import type { TextMatch } from '../shared/search'

export type SearchAdapter = {
  reveal: (match: TextMatch | null, matches: TextMatch[], active: number) => void
  focus: () => void
  replace?: (matches: TextMatch[], value: string) => void
}
