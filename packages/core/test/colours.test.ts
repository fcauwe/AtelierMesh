import { describe, expect, it } from 'vitest'
import { DEFAULT_COLOUR_MAP, DEFAULT_MAX_COLOURS, InProcessHost, Registry, applyColourMap, assignSegment, colourMapProblems, colourParts, colourPlan, createRunner, emptyStepList, isDefaultColourMap, loadProject, resolveColours, saveProject, segmentTable } from '../src'
import type { ColourMap, Mesh } from '../src'
import { boxMesh, createTestPlugin } from '../src/testing'

const tri = (m: Mesh) => m.indices.length / 3
/** A box whose first triangles (the flags) are the segment `letters`. */
const withLetters = (n = 4): Mesh => { const m = boxMesh(10, 10, 10); const f = new Uint8Array(tri(m)); f.fill(1, 0, n); return assignSegment(m, 'letters', f) }
/** Two bodies of a box each, the second named `base`. */
const twoBodies = (): Mesh => {
  const a = boxMesh(10, 10, 10), b = boxMesh(10, 10, 10)
  const off = a.positions.length / 3
  const positions = new Float64Array([...a.positions, ...b.positions.map((v, i) => (i % 3 === 0 ? v + 20 : v))])
  const indices = new Uint32Array([...a.indices, ...b.indices.map(i => i + off)])
  return { positions, indices, groups: [{ start: 0, count: tri(a), role: 'solid', name: 'cap' }, { start: tri(a), count: tri(b), role: 'solid', name: 'base' }] }
}
const map = (...slots: Array<[string, string[]]>): ColourMap => ({ slots: slots.map(([id, parts]) => ({ id, name: `Slot ${id}`, parts })) })

describe('colour slots', () => {
  it('by default the whole model is in the one slot, and a one-slot map gives a one-segment mesh a viewer paints in its body colour', () => {
    expect(isDefaultColourMap(DEFAULT_COLOUR_MAP)).toBe(true); expect(isDefaultColourMap(undefined)).toBe(true)
    const m = withLetters()
    const r = resolveColours(m, DEFAULT_COLOUR_MAP, { mode: 'edit' })
    expect(Array.from(r.slot).every(s => s === 0)).toBe(true); expect(r.unassigned).toEqual([])
    const out = applyColourMap(m, DEFAULT_COLOUR_MAP, { colours: { '1': { color: '#cc0000' } } })
    expect(segmentTable(out)).toEqual([{ id: 0, name: 'body', color: '#cc0000' }])
    expect(out.positions).toBe(m.positions)   // the geometry is shared, not copied
  })

  it('maps parts to slots: a named segment wins over its body, which wins over the whole-part rule; two texts can share a slot', () => {
    let m = withLetters(2)
    const f = new Uint8Array(tri(m)); f.fill(1, 2, 4); m = assignSegment(m, 'more', f)
    const mp = map(['1', ['*']], ['2', ['letters', 'more']])
    const r = resolveColours(m, mp, { mode: 'edit' })
    expect(Array.from(r.slot.slice(0, 6))).toEqual([1, 1, 1, 1, 0, 0])
    const bodies = resolveColours(twoBodies(), map(['1', ['*']], ['2', ['base']]), { mode: 'edit' })
    const half = tri(twoBodies()) / 2
    expect(bodies.slot[0]).toBe(0); expect(bodies.slot[half]).toBe(1)
    // a segment inside a named body: the segment's own slot wins
    const mixed = assignSegment(twoBodies(), 'mark', (() => { const x = new Uint8Array(tri(twoBodies())); x[half] = 1; return x })())
    expect(resolveColours(mixed, map(['1', ['*']], ['2', ['base']], ['3', ['mark']]), { mode: 'edit' }).slot[half]).toBe(2)
  })

  it('without the whole-part rule, parts no slot has stay their own parts in the editor and join the first slot everywhere else', () => {
    const m = withLetters(4)
    const mp = map(['1', ['letters']], ['2', []])
    const edit = resolveColours(m, mp, { mode: 'edit' })
    expect(edit.slot[0]).toBe(0); expect(edit.slot[tri(m) - 1]).toBe(-1); expect(edit.unassigned).toEqual(['body'])
    const shown = applyColourMap(m, mp, { mode: 'edit' })
    expect(segmentTable(shown).map(s => s.name)).toEqual(['body', 'slot_2', 'unassigned'])   // the slots in order (even an empty one), then what is left, told apart from slot 1
    const preview = resolveColours(m, mp, { mode: 'preview' })
    expect(Array.from(preview.slot).every(s => s === 0)).toBe(true); expect(preview.unassigned).toEqual([])
    expect(segmentTable(applyColourMap(m, mp)).map(s => s.name)).toEqual(['body', 'slot_2'])   // the slots, in order, even an empty one
  })

  it('applies slot colours to segments by slot, keeps the bodies, and drops their colours', () => {
    const m = { ...twoBodies(), groups: [{ start: 0, count: 12, role: 'solid' as const, name: 'cap', color: '#00ff00' }, { start: 12, count: 12, role: 'solid' as const, name: 'base', color: '#0000ff' }] }
    const out = applyColourMap(m, map(['1', ['cap']], ['2', ['base']]), { colours: { '1': { color: '#111111' }, '2': { color: '#222222' } } })
    expect(segmentTable(out)).toEqual([{ id: 0, name: 'body', color: '#111111' }, { id: 1, name: 'slot_2', color: '#222222' }])
    expect(out.groups?.map(g => g.color)).toEqual([undefined, undefined])
    expect(out.groups?.map(g => g.name)).toEqual(['cap', 'base'])
    expect(() => applyColourMap(m, DEFAULT_COLOUR_MAP, { colours: { '1': { color: 'red' } } })).toThrow()
  })

  it('the plan gives the volume of each slot, with unassigned parts counted in the first', () => {
    const m = twoBodies()
    const p = colourPlan(m, map(['1', ['cap']], ['2', ['base']]))
    expect(p.slots.map(s => [s.id, s.triangles, s.volume_mm3])).toEqual([['1', 12, 1000], ['2', 12, 1000]])
    expect(p.unassigned).toEqual([])
    const q = colourPlan(m, map(['1', ['cap']], ['2', []]))
    expect(q.slots.map(s => s.volume_mm3)).toEqual([2000, 0]); expect(q.unassigned).toEqual(['base'])
    const negative = { ...m, groups: [m.groups![0]!, { ...m.groups![1]!, role: 'negative' as const }] }
    expect(colourPlan(negative, map(['1', ['*']])).slots[0]!.volume_mm3).toBe(0)   // a body that is subtracted counts against the volume
  })

  it('parts are the segments that are used and the bodies that are solid', () => {
    expect(colourParts(withLetters())).toEqual({ segments: ['body', 'letters'], groups: [] })
    expect(colourParts(twoBodies())).toEqual({ segments: ['body'], groups: ['cap', 'base'] })
  })

  it('says what is wrong with a map instead of changing it', () => {
    expect(colourMapProblems({ slots: [] }).map(p => p.code)).toEqual(['colours.no_slots'])
    const six = { slots: Array.from({ length: DEFAULT_MAX_COLOURS + 1 }, (_, i) => ({ id: String(i + 1), name: 'x', parts: [] })) }
    expect(colourMapProblems(six)[0]).toEqual({ code: 'colours.too_many', params: { count: 6, max: 5 } })
    expect(colourMapProblems(six, { maxColours: 6 })).toEqual([])   // the host's number wins
    expect(colourMapProblems(map(['1', ['a']], ['2', ['a']]))[0]).toEqual({ code: 'colours.part_twice', params: { part: 'a', slots: ['1', '2'] } })
    expect(colourMapProblems(map(['1', ['*']], ['2', ['*']])).map(p => p.code)).toEqual(['colours.part_twice'])
    expect(colourMapProblems(map(['1', []], ['1', []])).map(p => p.code)).toEqual(['colours.duplicate_slot'])
    expect(colourMapProblems(map(['A B', []])).map(p => p.code)).toEqual(['colours.bad_slot'])
    expect(() => applyColourMap(boxMesh(1, 1, 1), map(['1', ['a']], ['2', ['a']]))).toThrow()
  })
})

describe('colour slots in a project and in a run', () => {
  it('are saved in the project file only when the design uses them, and read back whole', async () => {
    const base = boxMesh(10, 10, 10)
    const without = await loadProject(saveProject({ name: 'p', base, list: emptyStepList(), rollback: null, assets: [] }))
    expect(without.colours).toBeUndefined()
    const mp: ColourMap = { slots: [{ id: '1', name: 'Part', parts: ['*'] }, { id: '2', name: 'Text', parts: ['letters', 'more'], personalisable: true }] }
    const back = await loadProject(saveProject({ name: 'p', base, list: emptyStepList(), rollback: null, assets: [], colours: mp }))
    expect(back.colours).toEqual(mp)
    // the default map, when the designer switched colours on, is kept: present means "uses slots"
    expect((await loadProject(saveProject({ name: 'p', base, list: emptyStepList(), rollback: null, assets: [], colours: DEFAULT_COLOUR_MAP }))).colours).toEqual(DEFAULT_COLOUR_MAP)
  })
  it('refuse a project whose colours cannot be used', async () => {
    const bytes = saveProject({ name: 'p', base: boxMesh(1, 1, 1), list: emptyStepList(), rollback: null, assets: [], colours: { slots: [{ id: '1', name: 'a', parts: ['x'] }, { id: '2', name: 'b', parts: ['x'] }] } })
    await expect(loadProject(bytes)).rejects.toMatchObject({ code: 'import.invalid_project' })
  })
  it('are applied to the result of a run, and the per-step results stay the steps\' own', async () => {
    const t = createTestPlugin()
    const reg = new Registry().register(t.entry)
    const runner = createRunner({ registry: reg, host: new InProcessHost(reg), assets: async () => new Uint8Array(0), maxTriangles: 1_000_000 })
    const source = withLetters()
    const plain = await runner.runList(emptyStepList(), { source })
    expect(plain.mesh).toBe(source)
    const res = await runner.runList(emptyStepList(), { source, colours: { map: DEFAULT_COLOUR_MAP, colours: { '1': { color: '#cc0000' } } } })
    expect(segmentTable(res.mesh!)).toEqual([{ id: 0, name: 'body', color: '#cc0000' }])   // the whole part in the filament colour: what a shop shows
    expect(res.payload).toBe(res.mesh)
    const edit = await runner.runList(emptyStepList(), { source, colours: { map: { slots: [{ id: '1', name: 'Part', parts: ['letters'] }] }, mode: 'edit' } })
    expect(segmentTable(edit.mesh!).map(x => x.name)).toEqual(['body', 'unassigned'])
  })
})
