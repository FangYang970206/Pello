import { checkSuites } from './check-cases.mjs'
import { runChecks } from './check-runner.mjs'

const behaviorCheck = checkSuites.behavior
const [suite = 'all', ...options] = process.argv.slice(2)
const shardOption = options.find((arg) => arg.startsWith('--shard='))
const shard = shardOption?.match(/^--shard=([1-9]\d*)\/([1-9]\d*)$/)
const list = options.includes('--list')

if ((suite !== 'prepare' && !Object.hasOwn(checkSuites, suite)) ||
    options.some((arg) => arg !== '--list' && arg !== shardOption) ||
    new Set(options).size !== options.length ||
    (shardOption && (suite !== 'behavior' || !shard || Number(shard[1]) > Number(shard[2]) || Number(shard[2]) > behaviorCheck.length))) {
  console.error('Usage: node scripts/check-suite.mjs [suite] [--list] [--shard=N/T for behavior]')
  process.exit(2)
}

const stages = ['lint', 'typecheck', 'build']
const names = shard
  ? behaviorCheck.filter((_, index) => index % Number(shard[2]) === Number(shard[1]) - 1)
  : suite === 'prepare' ? stages : checkSuites[suite]

if (list) {
  console.log(names.join('\n'))
} else {
  const cases = suite === 'prepare'
    ? stages.map((name) => ({ name, args: [process.env.npm_execpath, 'run', name], rerun: `npm run ${name}` }))
    : names.map((name) => ({ name, args: [`scripts/${name}.mjs`], rerun: `node scripts/${name}.mjs` }))
  if (suite === 'prepare' && !process.env.npm_execpath) {
    console.error('Run the preparation stages with npm run verify:prepare.')
    process.exit(2)
  }
  const { failed } = runChecks(cases, { stopOnFailure: suite === 'prepare' })
  process.exitCode = failed.length ? 1 : 0
}
