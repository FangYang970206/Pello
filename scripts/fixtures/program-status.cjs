// Interactive CLI stand-in: native reports, persistent process, no model calls.
process.stdin.setRawMode?.(true)
process.stdin.setEncoding('utf8')
const report = (state) => process.stdout.write(`\x1b]7501;state=${state}:app=fixture\x1b\\`)
let input = '', negotiated = false
process.stdout.write('\x1b]7501;?\x1b\\')
process.stdin.on('data', (data) => {
  input += data
  if (!negotiated && input.includes('\x1b]7501;?\x1b\\')) {
    input = input.replace('\x1b]7501;?\x1b\\', '')
    negotiated = true
    process.stdout.write('STATUS_PROBE_OK\r\n')
    report('idle')
  }
  while (/[\r\n]/.test(input)) {
    const at = input.search(/[\r\n]/), command = input.slice(0, at).trim()
    input = input.slice(at + 1)
    if (command === 'exit') process.exit(0)
    if (command === 'work') report('working')
    if (command === 'idle') report('idle')
    if (command === 'done') report('done')
    if (command === 'blocked') report('blocked')
    process.stdout.write(`STATUS_COMMAND_${command}\r\n`)
  }
})
setInterval(() => {}, 1000)
