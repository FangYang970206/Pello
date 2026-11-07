// Model Pi on ConPTY: a hidden final cursor move is omitted; its native
// hardware-cursor mode preserves the input caret for IME positioning.
const fs = require('node:fs')
const log = process.argv[2]
let text = ''
process.stdin.setRawMode(true)
process.stdin.resume()
process.stdout.write('\x1b[?1049h')
function draw() {
  const rows = process.stdout.rows
  const nativeCursor = process.platform !== 'win32' || process.env.PI_HARDWARE_CURSOR === '1'
  const cells = Array.from(text).reduce((sum, char) => sum + (char.codePointAt(0) > 127 ? 2 : 1), 0)
  const col = nativeCursor ? cells + 1 : process.stdout.columns
  process.stdout.write(`\x1b[2J\x1b[HINPUT_HEADER 原有文字\x1b[${rows - 2};1H${text}\x1b[${rows};1HINPUT_FOOTER 最底行\x1b[${rows - 2};${col}H\x1b[?25${nativeCursor ? 'h' : 'l'}`)
}
process.stdout.on('resize', draw)
process.stdin.on('data', (data) => {
  fs.appendFileSync(log, data)
  text += data.toString('utf8')
  draw()
})
draw()
