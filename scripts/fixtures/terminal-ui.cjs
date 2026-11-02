const fs = require('node:fs')
const log = process.argv[2]
let clicks = 0
let sgr = false
process.stdin.setRawMode(true)
process.stdin.resume()
process.stdout.write('\x1b[?1049h\x1b[?1000h\x1b[?1006l')
function draw() {
  process.stdout.write(`\x1b[2J\x1b[HTERM_HEADER SESSION_A SESSION_B\r\nCLICK_COUNT=${clicks}\x1b[${process.stdout.rows};1HFOOTER_VISIBLE rows=${process.stdout.rows}`)
}
process.stdout.on('resize', draw)
process.stdin.on('data', (data) => {
  fs.appendFileSync(log, `${data.toString('hex')}\n`)
  if (data.toString() === 's') {
    sgr = true
    process.stdout.write('\x1b[?1006h')
  // eslint-disable-next-line no-control-regex -- This fixture parses terminal protocol bytes.
  } else if ((sgr && /\x1b\[<0;\d+;\d+M/.test(data.toString())) || (!sgr && data[0] === 27 && data[1] === 91 && data[2] === 77 && (data[3] & 3) === 0)) {
    clicks++
    draw()
  }
})
draw()
