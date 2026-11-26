import manifest from './check-cases.json' with { type: 'json' }

export function getCheckSuites({ groups, all, performanceIsolated, wsl }) {
  const expand = (entries) => entries.flatMap((entry) => entry.startsWith('@') ? groups[entry.slice(1)] : entry)
  const full = expand(all)
  const measured = expand(performanceIsolated)
  const behavior = full.filter((name) => !wsl.includes(name) && !measured.includes(name))
  return { ...groups, all: full, behavior, performanceIsolated: measured, wsl }
}

export const checkSuites = getCheckSuites(manifest)
