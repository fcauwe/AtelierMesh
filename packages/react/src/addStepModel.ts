// What the "Add a step" menu shows, as plain data: headings, one-row submenus for a plugin with several operations, a "More" group, and search.
// No React here, so the rules can be tested on their own. Rules (docs/proposals/design-handoff-v5-feedback.md):
//  - every operation is listed, none is hidden; one that cannot be added here (`operationAvailability` in core) stays in its place, disabled, with the reason under its name;
//  - above SEARCH_THRESHOLD operations the menu has a search field and the `importance: 'low'` operations go into "More";
//  - a plugin that has an `icon` and three or more operations under one heading is one row (a submenu) there.
import type { Operation } from '@ateliermesh/core'

export const SEARCH_THRESHOLD = 12
export const GROUP_MIN = 3
/** The headings, in this order; any other category a plugin declares follows, in the order it first appears. */
export const CATEGORY_ORDER = ['prepare', 'shape', 'style', 'surface', 'check']

export interface MenuOp {
  plugin: string
  pluginName: string
  /** The plugin's own icon: only a plugin that has one is folded into a submenu row. */
  pluginIcon?: string
  op: Operation
  /** The name in the current language. */
  title: string
  heading: string
  low: boolean
  /** Why the step cannot be added here (`needs.drawing`, `needs.mesh`, `needs.stored`); absent when it can. The row stays in its place, greyed, with this under the name. */
  reason?: string
}

export type Row = { kind: 'op'; item: MenuOp } | { kind: 'group'; plugin: string; name: string; icon: string; items: MenuOp[] }
export interface Section { heading: string; rows: Row[] }
export interface MenuModel { showSearch: boolean; main: Section[]; more: Section[]; moreCount: number }

export const headingOf = (i: { op: { kind: string; category?: string } }): string => i.op.category ?? (i.op.kind === 'analyzer' ? 'check' : 'shape')

const byHeading = (a: string, b: string): number => { const x = CATEGORY_ORDER.indexOf(a), y = CATEGORY_ORDER.indexOf(b); return (x < 0 ? 99 : x) - (y < 0 ? 99 : y) }

function rowsOf(items: MenuOp[], fold: boolean): Row[] {
  const perPlugin = new Map<string, MenuOp[]>()
  for (const i of items) perPlugin.set(i.plugin, [...(perPlugin.get(i.plugin) ?? []), i])
  const rows: Row[] = [], done = new Set<string>()
  for (const i of items) {
    const all = perPlugin.get(i.plugin) as MenuOp[]
    if (fold && i.pluginIcon && all.length >= GROUP_MIN) {
      if (done.has(i.plugin)) continue
      done.add(i.plugin); rows.push({ kind: 'group', plugin: i.plugin, name: i.pluginName, icon: i.pluginIcon, items: all })
    } else rows.push({ kind: 'op', item: i })
  }
  return rows
}

export function buildMenu(items: MenuOp[]): MenuModel {
  const showSearch = items.length > SEARCH_THRESHOLD
  const sectionsOf = (list: MenuOp[], fold: boolean): Section[] => [...new Set(list.map(i => i.heading))].sort(byHeading).map(heading => ({ heading, rows: rowsOf(list.filter(i => i.heading === heading), fold) }))
  const low = showSearch ? items.filter(i => i.low) : []
  const main = items.filter(i => !low.includes(i))
  return { showSearch, main: sectionsOf(main, true), more: sectionsOf(low, false), moreCount: low.length }
}

/** Lower case without accents, so "uithollen", "Uithollen" and "uithöllen" meet. */
export const normalise = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

/** The place of an operation, for a search result: "Shape" or "Shape › Deform" (the plugin shows only when it is folded into a submenu there). */
export function whereOf(i: MenuOp, model: MenuModel, headingTitle: (h: string) => string): string {
  const folded = model.main.some(s => s.heading === i.heading && s.rows.some(r => r.kind === 'group' && r.plugin === i.plugin))
  return folded ? `${headingTitle(i.heading)} › ${i.pluginName}` : headingTitle(i.heading)
}

/** Match the translated name, the English name and the operation id; names that start with the text come first, then names where a word starts with it, then the rest, alphabetically. */
export function searchOps(items: MenuOp[], query: string): MenuOp[] {
  const q = normalise(query)
  if (!q) return []
  const rank = (i: MenuOp): number => {
    let best = 9
    for (const name of [normalise(i.title), normalise(i.op.title ?? i.op.id), normalise(i.op.id), normalise(i.op.id.replace(/_/g, ' '))]) {
      if (name.startsWith(q)) best = Math.min(best, 0)
      else if (name.split(/[\s\-_]+/).some(w => w.startsWith(q))) best = Math.min(best, 1)
      else if (name.includes(q)) best = Math.min(best, 2)
    }
    return best
  }
  return items.map(i => ({ i, r: rank(i) })).filter(x => x.r < 9).sort((a, b) => a.r - b.r || normalise(a.i.title).localeCompare(normalise(b.i.title))).map(x => x.i)
}
