/** Session-local shell integration. Native ssh owns authentication and its control socket. */
export function terminalContextShell(): string {
  return `
__pello_context() {
  [ -n "$PELLO_CONTEXT_TOKEN" ] || return 0
  local payload
  payload=$(python3 -c 'import os,sys,json,base64,socket,getpass; route=json.loads(base64.b64decode(sys.argv[1] or "W10=")); print(base64.b64encode(json.dumps(dict(route=route,cwd=os.getcwd(),user=getpass.getuser(),hostname=socket.gethostname())).encode()).decode())' "$PELLO_CONTEXT_ROUTE" 2>/dev/null) || return 0
  printf '\\033]777;pello;context;%s;%s\\007' "$PELLO_CONTEXT_TOKEN" "$payload"
}
ssh() {
  if [ -z "$PELLO_CONTEXT_TOKEN" ]; then command ssh "$@"; return $?; fi
  local -a original=("$@") options=()
  local destination='' plain=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --) shift; destination="$1"; shift; break ;;
      -N|-T|-G|-V|-W|-O) plain=1; break ;;
      -[BbcDEeFIiJLlmopQRSw]) options+=("$1"); shift; [ "$#" -gt 0 ] || break; options+=("$1"); shift ;;
      -*) options+=("$1"); shift ;;
      *) destination="$1"; shift; break ;;
    esac
  done
  if [ "$plain" = 1 ] || [ -z "$destination" ] || [ "$#" -gt 0 ]; then command ssh "\${original[@]}"; return $?; fi
  local directory control route payload result
  directory=$(umask 077; mktemp -d /tmp/pello-ssh.XXXXXXXX) || return 1
  control="$directory/master"
  route=$(python3 -c 'import sys,json,base64; r=json.loads(base64.b64decode(sys.argv[1] or "W10=")); r.append(dict(socket=sys.argv[2],destination=sys.argv[3])); print(base64.b64encode(json.dumps(r).encode()).decode())' "$PELLO_CONTEXT_ROUTE" "$control" "$destination") || { rmdir -- "$directory"; return 1; }
  payload=$({
    printf '%s\\n' '[ ! -r "$HOME/.bashrc" ] || . "$HOME/.bashrc"' 'unalias ssh 2>/dev/null || true'
    declare -f __pello_context ssh __awb_prompt
    printf '\\nexport PELLO_CONTEXT_TOKEN=%q PELLO_CONTEXT_ROUTE=%q\\nPROMPT_COMMAND=__awb_prompt\\n' "$PELLO_CONTEXT_TOKEN" "$route"
  } | base64 | tr -d '\\r\\n')
  command ssh -o ControlMaster=yes -o ControlPersist=no -S "$control" -t "\${options[@]}" -- "$destination" "bash -lc 'exec bash --noprofile --rcfile <(printf %s $payload | base64 -d) -i'"
  result=$?
  command ssh -S "$control" -o BatchMode=yes -o ProxyCommand=false -O exit -- "$destination" >/dev/null 2>&1 || true
  rm -f -- "$control"
  rmdir -- "$directory" 2>/dev/null || true
  __pello_context
  return "$result"
}
unalias ssh 2>/dev/null || true
`
}
