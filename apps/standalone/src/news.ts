// What is new, for the popup people see when they open the app: one entry per version, newest first. To tell people about a change they will notice, add an entry
// at the top (the version, and the keys of its items); the texts go under `welcome.news.<version with underscores>.<item>` in en, nl and fr. A visitor sees each entry once:
// the popup shows what is newer than the newest version they have seen. A version with nothing a user would notice needs no entry.
import { compareSemver } from '@ateliermesh/core'

export interface NewsEntry { version: string; items: readonly string[] }

export const NEWS: readonly NewsEntry[] = [
  { version: '0.3.0', items: ['svg', 'menu', 'store'] },
]

/** The newest version that has news; what a visitor has seen once they close the popup. */
export const LATEST_NEWS = (NEWS[0] as NewsEntry).version

/** The text key of one item of one version: `1.2.0` and `reshape` give `welcome.news.v1_2_0.reshape`. */
export const newsKey = (version: string, item: string): string => `welcome.news.v${version.replace(/\./g, '_')}.${item}`

/**
 * The entries a visitor has not seen, newest first. Someone who has seen nothing of this yet (`seen` is null: a first visit, or a visit from before there was a popup)
 * gets the newest entry only, not the whole history.
 */
export function unseenNews(seen: string | null): NewsEntry[] {
  if (seen === null) return NEWS.slice(0, 1)
  return NEWS.filter(e => compareSemver(e.version, seen) > 0)
}
