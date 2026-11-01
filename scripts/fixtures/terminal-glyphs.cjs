process.stdout.write('\x1b[2J\x1b[H\x1b[?25l\x1b[38;2;90;180;240m')
process.stdout.write(('▎\r\n').repeat(8))
process.stdout.write('┗━━━━━━━━━━━━┛\r\n\x1b[0m你好，终端边线测试\r\n')
setInterval(() => {}, 1000)
