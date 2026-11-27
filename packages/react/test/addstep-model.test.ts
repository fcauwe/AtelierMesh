import { describe, expect, it } from 'vitest'
import type { Operation } from '@ateliermesh/core'
import { SEARCH_THRESHOLD, buildMenu, normalise, searchOps, whereOf } from '../src/addStepModel'
import type { MenuOp } from '../src/addStepModel'

const op = (id: string, extra: Partial<Operation> = {}): Operation => ({ id, kind: 'modifier', params: [], ...extra })
const item = (plugin: string, id: string, title: string, heading = 'shape', extra: Partial<MenuOp> = {}, opExtra: Partial<Operation> = {}): MenuOp => ({ plugin, pluginName: plugin, op: op(id, opExtra), title, heading, low: false, ...extra })
const many = (n: number): MenuOp[] => Array.from({ length: n }, (_, i) => item('p', `op${i}`, `Step ${i}`))

describe('the Add a step menu model', () => {
  it('has no search and no More group when twelve operations or fewer are offered; low ones then stay under their heading', () => {
    const m = buildMenu([...many(SEARCH_THRESHOLD - 1), item('p', 'chk', 'Check', 'check', { low: true })])
    expect(m.showSearch).toBe(false); expect(m.moreCount).toBe(0)
    expect(m.main.map(s => s.heading)).toEqual(['shape', 'check'])
  })
  it('above twelve: a search field, and the low-importance operations move into More (an emptied heading disappears)', () => {
    const items = [...many(SEARCH_THRESHOLD), item('p', 'chk', 'Check', 'check', { low: true })]
    const m = buildMenu(items)
    expect(m.showSearch).toBe(true); expect(m.moreCount).toBe(1)
    expect(m.main.map(s => s.heading)).toEqual(['shape']); expect(m.more.map(s => s.heading)).toEqual(['check'])
  })
  it('headings follow the fixed order, then any other in the order it appears', () => {
    const m = buildMenu([item('p', 'a', 'A', 'check'), item('p', 'b', 'B', 'zebra'), item('p', 'c', 'C', 'surface'), item('p', 'd', 'D', 'apple'), item('p', 'e', 'E', 'prepare')])
    expect(m.main.map(s => s.heading)).toEqual(['prepare', 'surface', 'check', 'zebra', 'apple'])
  })
  it('a plugin with an icon and three or more operations under one heading becomes one row; Core, with no icon, stays flat', () => {
    const deform = ['twist', 'taper', 'bend'].map(id => item('deform', id, id, 'shape', { pluginIcon: 'spline' }))
    const core = ['resize', 'rotate', 'decimate'].map(id => item('core', id, id))
    const m = buildMenu([...core, ...deform])
    const rows = m.main[0]!.rows
    expect(rows.filter(r => r.kind === 'op').length).toBe(3)
    const group = rows.find(r => r.kind === 'group')
    expect(group).toMatchObject({ kind: 'group', plugin: 'deform', icon: 'spline' })
    expect((group as { items: MenuOp[] }).items.length).toBe(3)
    // two operations are not enough
    expect(buildMenu(deform.slice(0, 2)).main[0]!.rows.every(r => r.kind === 'op')).toBe(true)
  })
  it('a disabled step stays in the list (nothing is hidden) and counts toward the search threshold', () => {
    const items = [...many(SEARCH_THRESHOLD), item('p', 'extrude', 'Extrude', 'shape', { reason: 'needs.drawing' })]
    const m = buildMenu(items)
    expect(m.showSearch).toBe(true)
    expect(m.main[0]!.rows.length).toBe(SEARCH_THRESHOLD + 1)
  })
})

describe('search', () => {
  const items = [item('c', 'hollow', 'Uithollen', 'shape', {}, { title: 'Hollow' }), item('c', 'cheese', 'Kaasgaten', 'shape', {}, { title: 'Cheese holes' }), item('c', 'cut_hole', 'Gat snijden', 'shape', {}, { title: 'Cut hole' }), item('c', 'resize', 'Grootte wijzigen', 'shape', {}, { title: 'Resize' })]
  it('ignores case and accents, and finds a name in the middle', () => {
    expect(normalise('  Uithöllen ')).toBe('uithollen')
    expect(searchOps(items, 'HOL').map(i => i.op.id)).toEqual(['hollow', 'cut_hole', 'cheese'])   // English names: Hollow and Cut hole... start or word-start, Cheese holes: a word starts
  })
  it('matches the English name and the operation id, not only the translated name', () => {
    expect(searchOps(items, 'cheese').map(i => i.op.id)).toEqual(['cheese'])      // the nl name is Kaasgaten
    expect(searchOps(items, 'cut_hole').map(i => i.op.id)).toEqual(['cut_hole'])
    expect(searchOps(items, 'kaas').map(i => i.op.id)).toEqual(['cheese'])
  })
  it('puts names that start with the text first, then word starts, then the rest, alphabetically', () => {
    const list = [item('p', 'a', 'Mixed holes'), item('p', 'b', 'Hole punch'), item('p', 'c', 'Whole thing'), item('p', 'd', 'Hole alpha')]
    expect(searchOps(list, 'hole').map(i => i.title)).toEqual(['Hole alpha', 'Hole punch', 'Mixed holes', 'Whole thing'])
  })
  it('an empty or unmatched query gives nothing', () => {
    expect(searchOps(items, '')).toEqual([]); expect(searchOps(items, 'zzz')).toEqual([])
  })
  it('says where a result lives, with the plugin only when it is folded into a submenu', () => {
    const deform = ['twist', 'taper', 'bend'].map(id => item('deform', id, id, 'shape', { pluginIcon: 'spline', pluginName: 'Deform' }))
    const m = buildMenu([...deform, item('core', 'resize', 'Resize')])
    const head = (h: string): string => (h === 'shape' ? 'Shape' : h)
    expect(whereOf(deform[0]!, m, head)).toBe('Shape › Deform')
    expect(whereOf(item('core', 'resize', 'Resize'), m, head)).toBe('Shape')
  })
})
