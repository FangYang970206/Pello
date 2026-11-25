// An isolated native-conversation fixture. It never connects to a model service.
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const args = process.argv.slice(2)
const value = (key) => args[args.indexOf(key) + 1]
const id = args.includes('--resume') ? value('--resume') : args.includes('--session-id') ? value('--session-id') : 'unmanaged'
const file = path.join(args.includes('--fixture-home') ? value('--fixture-home') : process.env.PELLO_FIXTURE_HOME, id + '.json')
if (args.includes('--resume') && !fs.existsSync(file)) { console.error('MISSING_NATIVE_SESSION'); process.exit(2) }
const messages = args.includes('--resume') ? JSON.parse(fs.readFileSync(file, 'utf8')) : []
console.log('CUSTOM_READY ' + id + ' ' + JSON.stringify(messages))
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.startsWith('FIXTURE_STATUS_')) {
    process.stdout.write('\x1b]7501;state=' + line.slice('FIXTURE_STATUS_'.length) + ':app=custom-fixture\x07')
    return
  }
  messages.push(line)
  fs.writeFileSync(file, JSON.stringify(messages))
  console.log('CUSTOM_REPLY ' + JSON.stringify(messages))
})
