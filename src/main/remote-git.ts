import { t } from '../shared/i18n'

/** Never let a privileged SSH login publish a new index as itself. */
export function remoteGitProgram(): string {
  return `import os,sys,pwd
cwd=sys.argv[1]
folder=os.path.realpath(cwd)
metadata=None
while True:
 candidate=os.path.join(folder,'.git')
 if os.path.isdir(candidate):
  metadata=os.path.realpath(candidate); break
 if os.path.isfile(candidate):
  with open(candidate) as source: pointer=source.readline().strip()
  if pointer.startswith('gitdir: '): metadata=os.path.realpath(os.path.join(folder,pointer[8:]))
  break
 parent=os.path.dirname(folder)
 if parent==folder: break
 folder=parent
args=['git','--no-optional-locks','-C',cwd,'-c','core.quotepath=false','-c','core.fsmonitor=false','-c','diff.autoRefreshIndex=false']+sys.argv[2:]
if metadata:
 owner=os.stat(metadata).st_uid
 if owner!=os.geteuid():
  account=pwd.getpwuid(owner)
  if os.geteuid()==0:
   os.initgroups(account.pw_name,account.pw_gid)
   os.setgid(account.pw_gid); os.setuid(owner)
   os.environ['HOME']=account.pw_dir
   for key in ['SUDO_UID','SUDO_GID','SUDO_USER']: os.environ.pop(key,None)
  else:
   import subprocess
   result=subprocess.run(['sudo','-n','-H','-u',account.pw_name,'--']+args)
   if result.returncode: sys.stderr.write(${JSON.stringify(t('无法以仓库所有者身份执行 Git，请使用该用户连接或配置免密 sudo。'))}+'\\n')
   sys.exit(result.returncode)
os.execvp(args[0],args)
`
}
