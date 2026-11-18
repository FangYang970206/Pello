import type { Executor } from './types'

export function executorForHost(executor: Executor, hostId: string): Executor {
  return { ...executor, ...executor.hosts?.[hostId] }
}

/** Tokenize only simple launch commands. Pipelines, substitutions and wrappers are not identities. */
export function launchTokens(command: string): string[] | undefined {
  if (/[\r\n;|`<>]/.test(command) || command.includes('&&')) return
  const tokens: string[] = []
  const text = command.trim().replace(/^&\s+/, '')
  const pattern = /"([^"\n]*)"|'((?:[^'\n]|'')*)'|([^\s"']+)/gy
  let at = 0
  while (at < text.length) {
    pattern.lastIndex = at
    const match = pattern.exec(text)
    if (!match) return
    tokens.push(match[1] ?? match[2]?.replaceAll("''", "'") ?? match[3])
    at = pattern.lastIndex
    while (/\s/.test(text[at] || '') && at < text.length) at++
  }
  return tokens
}

export function submittedCustomAgent(command: string, custom: Executor[], hostId: string): Executor | undefined {
  const submitted = launchTokens(command)
  if (!submitted?.length) return
  const matches = custom.filter((item) => {
    const config = executorForHost(item, hostId)
    const expected = launchTokens([config.cmd, config.args].filter(Boolean).join(' '))
    return expected?.length && expected.every((token, index) => token === submitted[index])
  })
  // Identical configured commands cannot establish which conversation owns the process.
  return matches.length === 1 ? matches[0] : undefined
}

export function isConfiguredLaunch(command: string, executor: Executor, hostId: string): boolean {
  const config = executorForHost(executor, hostId)
  const expected = launchTokens([config.cmd, config.args].filter(Boolean).join(' '))
  const actual = launchTokens(command)
  return !!expected && !!actual && expected.length === actual.length && expected.every((token, index) => token === actual[index])
}
