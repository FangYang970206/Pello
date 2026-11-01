const fs = require('node:fs')
const { spawn } = require('node:child_process')

const [pidFile, depth = '2'] = process.argv.slice(2)
fs.appendFileSync(pidFile, `${process.pid}\n`)
if (Number(depth) > 0) {
  // Detached children must also be stopped when their terminal is closed.
  spawn(process.execPath, [__filename, pidFile, String(Number(depth) - 1)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  }).unref()
}
setInterval(() => {}, 1000)
