import { describe, expect, it } from 'vitest'
import { Registry, addStep, assignSegment, checkPartReferences, emptyStepList, makeStep, measureMesh, runFixtures, runWorkflow, segmentTable, validateManifest } from '@ateliermesh/core'
import type { Mesh, StepList } from '@ateliermesh/core'
import { boxMesh } from '@ateliermesh/core/testing'
import { PARTS_PLUGIN_ID, PARTS_PLUGIN_VERSION, corePlugin, gridBox, orderHints, partsFixtures, partsManifest, partsPlugin, removeParts } from '../src'

const registry = (): Registry => new Registry().register(corePlugin()).register(partsPlugin())
const step = (id: string, op: 'delete_part' | 'keep_part', params: Record<string, unknown> = {}) => makeStep({ id, plugin: { id: PARTS_PLUGIN_ID, version: PARTS_PLUGIN_VERSION }, op, params })
const run = (mesh: Mesh, op: 'delete_part' | 'keep_part', params: Record<string, unknown>, signal?: AbortSignal) =>
  runWorkflow(addStep(emptyStepList(), step('p', op, params)), { registry: registry(), source: mesh, ...(signal ? { signal } : {}) })
const report = (r: Awaited<ReturnType<typeof run>>): Record<string, unknown> => r.results[0]!.report as Record<string, unknown>
const closed = (m: Mesh): boolean => measureMesh(m).watertight

const boxAt = (x: number, s = 10): Mesh => {
  const b = boxMesh(s, s, s)
  const P = Float64Array.from(b.positions)
  for (let i = 0; i < P.length; i += 3) P[i] = (P[i] as number) + x
  return { positions: P, indices: Uint32Array.from(b.indices) }
}
/** Two bodies side by side, as two groups named `left` and `right`. */
function twoBodies(): Mesh {
  const a = boxAt(0), b = boxAt(30, 8)
  const na = a.indices.length / 3, nb = b.indices.length / 3
  return {
    positions: Float64Array.from([...a.positions, ...b.positions]),
    indices: Uint32Array.from([...a.indices, ...Array.from(b.indices, i => i + a.positions.length / 3)]),
    groups: [{ start: 0, count: na, role: 'solid', name: 'left' }, { start: na, count: nb, role: 'solid', name: 'right' }],
  }
}
/** A 20 x 20 x 10 box whose top face is the segment `lid` and whose outer ring of the sides is the segment `rim`. */
function boxWithLid(): Mesh {
  const m = gridBox(20, 20, 10, 8, 8, 4)
  const flags = new Uint8Array(m.indices.length / 3)
  for (let t = 0; t < flags.length; t++) { const z = [0, 1, 2].map(k => m.positions[3 * (m.indices[3 * t + k] as number) + 2] as number); if (z.every(v => Math.abs(v - 10) < 1e-9)) flags[t] = 1 }
  return assignSegment(m, 'lid', flags)
}
const hash = (m: Mesh): string => JSON.stringify([Array.from(m.positions), Array.from(m.indices), m.segments ? [Array.from(m.segments.labels), m.segments.table] : null, m.groups ?? null])

describe('the parts plugin', () => {
  it('has a valid manifest in the prepare category, both operations never personalisable', () => {
    expect(validateManifest(partsManifest).ok).toBe(true)
    expect(partsManifest.operations.map(o => [o.id, o.category, o.personalisable])).toEqual([['delete_part', 'prepare', 'never'], ['keep_part', 'prepare', 'never']])
  })

  describe('delete a body (group)', () => {
    it('leaves the other body as a closed solid, with its range, name and role', async () => {
      const r = await run(twoBodies(), 'delete_part', { part: 'left' })
      expect(r.ok).toBe(true)
      const m = r.mesh!
      expect(m.indices.length / 3).toBe(12)
      expect(closed(m)).toBe(true)
      expect(measureMesh(m).volume).toBeCloseTo(512, 6)
      expect(m.groups).toEqual([{ start: 0, count: 12, role: 'solid', name: 'right' }])
      expect(m.positions.length / 3).toBe(8)       // the vertices of the removed body are gone
      expect(report(r)).toMatchObject({ kind: 'group', part: 'left', triangles_before: 24, triangles_after: 12, removed_triangles: 12, closed: true, groups_removed: ['left'] })
    })
    it('keeps the order, roles and names of the bodies that stay and shifts their ranges', async () => {
      const three: Mesh = (() => { const a = twoBodies(), c = boxAt(60, 6); return { positions: Float64Array.from([...a.positions, ...c.positions]), indices: Uint32Array.from([...a.indices, ...Array.from(c.indices, i => i + a.positions.length / 3)]), groups: [...a.groups!, { start: 24, count: 12, role: 'negative' as const, name: 'hole' }] } })()
      const r = await run(three, 'delete_part', { part: 'left' })
      expect(r.mesh!.groups).toEqual([{ start: 0, count: 12, role: 'solid', name: 'right' }, { start: 12, count: 12, role: 'negative', name: 'hole' }])
    })
    it('refuses to delete the only body', async () => {
      const one: Mesh = { ...boxAt(0), groups: [{ start: 0, count: 12, role: 'solid', name: 'only' }] }
      const r = await run(one, 'delete_part', { part: 'only' })
      expect(r.ok).toBe(false)
      expect(r.results[0]!.error).toMatchObject({ code: 'parts.would_remove_everything' })
    })
    it('keep_part keeps one body and removes the rest', async () => {
      const r = await run(twoBodies(), 'keep_part', { part: 'left' })
      expect(r.ok).toBe(true)
      expect(r.mesh!.groups).toEqual([{ start: 0, count: 12, role: 'solid', name: 'left' }])
      expect(measureMesh(r.mesh!).volume).toBeCloseTo(1000, 6)
      expect(report(r)).toMatchObject({ kind: 'group', removed_triangles: 12, groups_removed: ['right'] })
    })
  })

  describe('delete a surface region (segment)', () => {
    it('closes the opening with a cap: a closed solid again, with the volume of the box', async () => {
      const m = boxWithLid()
      expect(closed(m)).toBe(true)
      const r = await run(m, 'delete_part', { part: 'lid' })
      expect(r.ok).toBe(true)
      expect(closed(r.mesh!)).toBe(true)
      expect(measureMesh(r.mesh!).volume).toBeCloseTo(4000, 3)
      const rep = report(r)
      expect(rep['removed_triangles']).toBe(128)
      expect(rep['cap_triangles'] as number).toBeGreaterThan(0)
      expect(rep['segments_removed']).toEqual(['lid'])
      // the cap took the label of the surface around it, so the table has no `lid`
      expect(segmentTable(r.mesh!).map(s => s.name)).toEqual(['body'])
    })
    it('with close_hole none leaves the opening, and says so', async () => {
      const r = await run(boxWithLid(), 'delete_part', { part: 'lid', close_hole: 'none' })
      expect(r.ok).toBe(true)
      expect(closed(r.mesh!)).toBe(false)
      expect(r.results[0]!.warnings?.map(w => w.code)).toContain('parts.result_open')
      expect(report(r)).toMatchObject({ cap_triangles: 0, closed: false, closed_before: true })
    })
    it('keeps the ids of the other segments when one is deleted', () => {
      let m = boxWithLid()
      const n = m.indices.length / 3
      const side = new Uint8Array(n)
      for (let t = 0; t < n; t++) if ((m.segments!.labels[t] as number) === 0 && (m.positions[3 * (m.indices[3 * t] as number)] as number) < -9.999) side[t] = 1
      m = assignSegment(m, 'edge', side)
      const before = segmentTable(m).map(s => `${s.id}:${s.name}`)
      expect(before).toEqual(['0:body', '1:lid', '2:edge'])
      const out = removeParts(m, { part: 'lid', mode: 'delete', closeHole: 'fill', removeUnused: true }).mesh
      expect(segmentTable(out).map(s => `${s.id}:${s.name}`)).toEqual(['0:body', '2:edge'])
    })
    it('keep_part of a segment keeps that region only (an open sheet is reported, not an error)', async () => {
      const r = await run(boxWithLid(), 'keep_part', { part: 'lid' })
      expect(r.ok).toBe(true)
      expect(report(r)['removed_triangles']).toBe(boxWithLid().indices.length / 3 - 128)
      expect(r.mesh!.indices.length / 3).toBeGreaterThanOrEqual(128)
    })
  })

  describe('errors', () => {
    it('no part chosen', async () => { expect((await run(boxAt(0), 'delete_part', {})).results[0]!.error).toMatchObject({ code: 'parts.nothing_chosen' }) })
    it('a part the mesh does not have', async () => { expect((await run(boxAt(0), 'delete_part', { part: 'lid' })).results[0]!.error).toMatchObject({ code: 'part.unknown' }) })
    it('everything', async () => {
      expect((await run(boxAt(0), 'delete_part', { part: 'body' })).results[0]!.error).toMatchObject({ code: 'parts.would_remove_everything' })
      const lidOnly = boxWithLid()
      expect((await run(lidOnly, 'keep_part', { part: 'body' })).ok).toBe(true)
    })
    it('groups that do not cover the mesh are refused', async () => {
      const bad: Mesh = { ...twoBodies(), groups: [{ start: 0, count: 6, role: 'solid', name: 'left' }] }
      expect((await run(bad, 'delete_part', { part: 'left' })).results[0]!.error).toMatchObject({ code: 'parts.groups_unsupported' })
    })
    it('a part that exists as both a group and a segment is ambiguous without the prefix, and the prefix chooses', async () => {
      const m = twoBodies()
      const flags = new Uint8Array(24); flags.fill(1, 0, 12)
      const both = assignSegment(m, 'left', flags)
      expect((await run(both, 'delete_part', { part: 'left' })).results[0]!.error).toMatchObject({ code: 'part.ambiguous' })
      const r = await run(both, 'delete_part', { part: 'group:left' })
      expect(r.ok).toBe(true)
      expect(r.mesh!.groups!.map(g => g.name)).toEqual(['right'])
    })
  })

  describe('what later steps may name', () => {
    const l = (...s: ReturnType<typeof step>[]): StepList => s.reduce((acc, x) => addStep(acc, x), emptyStepList())
    const user = makeStep({ id: 'u', plugin: { id: PARTS_PLUGIN_ID, version: PARTS_PLUGIN_VERSION }, op: 'keep_part', params: { part: 'lid' } })
    it('a step that names a deleted part gets part.dropped', () => {
      const issues = checkPartReferences(l(step('d', 'delete_part', { part: 'lid' }), user), registry(), { segments: ['lid'], groups: [] })
      expect(issues).toEqual([{ stepId: 'u', param: 'part', value: 'lid', code: 'part.dropped' }])
    })
    it('keep_part drops every other part of its kind but not the one it keeps', () => {
      const base = { segments: ['lid', 'rim'], groups: ['left', 'right'] }
      const keepRim = step('k', 'keep_part', { part: 'rim' })
      const named = (name: string) => makeStep({ id: 'u2', plugin: { id: PARTS_PLUGIN_ID, version: PARTS_PLUGIN_VERSION }, op: 'delete_part', params: { part: name } })
      expect(checkPartReferences(l(keepRim, named('rim')), registry(), base)).toEqual([])
      expect(checkPartReferences(l(keepRim, named('lid')), registry(), base)).toEqual([{ stepId: 'u2', param: 'part', value: 'lid', code: 'part.dropped' }])
      expect(checkPartReferences(l(step('kg', 'keep_part', { part: 'left' }), named('right')), registry(), base)).toEqual([{ stepId: 'u2', param: 'part', value: 'right', code: 'part.dropped' }])
    })
    it('a disabled delete step drops nothing', () => {
      const off = makeStep({ id: 'd', plugin: { id: PARTS_PLUGIN_ID, version: PARTS_PLUGIN_VERSION }, op: 'delete_part', params: { part: 'lid' }, enabled: false })
      expect(checkPartReferences(l(off, user), registry(), { segments: ['lid'], groups: [] })).toEqual([])
    })
  })

  it('is deterministic and does not change its input', () => {
    const m = boxWithLid()
    const before = hash(m)
    const a = removeParts(m, { part: 'lid', mode: 'delete', closeHole: 'fill', removeUnused: true }).mesh
    const b = removeParts(m, { part: 'lid', mode: 'delete', closeHole: 'fill', removeUnused: true }).mesh
    expect(hash(a)).toBe(hash(b))
    expect(hash(m)).toBe(before)
  })

  it('stops when the run is cancelled', async () => {
    const ac = new AbortController(); ac.abort()
    const r = await run(boxWithLid(), 'delete_part', { part: 'lid' }, ac.signal)
    expect(r.ok).toBe(false)
    expect(r.results[0]!.error?.code).toMatch(/cancel/)
  })

  it('remove_unused false keeps the vertex list when nothing is capped', () => {
    const m = twoBodies()
    const out = removeParts(m, { part: 'left', mode: 'delete', closeHole: 'none', removeUnused: false }).mesh
    expect(out.positions.length).toBe(m.positions.length)
    expect(out.indices.length / 3).toBe(12)
  })

  it('passes its conformance fixtures', async () => {
    const results = await runFixtures(partsFixtures, { registry: registry() })
    expect(results.filter(r => !r.ok)).toEqual([])
    expect(results.length).toBeGreaterThanOrEqual(4)
  })

  it('gets a hint to stand near the top, after repair', () => {
    const size = makeStep({ id: 'z', plugin: { id: 'org.ateliermesh.core', version: '0.2.0' }, op: 'resize', params: {} })
    const l = addStep(addStep(emptyStepList(), size), step('d', 'delete_part', { part: 'lid' }))
    expect(orderHints(l).find(h => h.code === 'parts_first')).toMatchObject({ step: 'd', fix: { id: 'd', to: 0 } })
    expect(orderHints(addStep(addStep(emptyStepList(), step('d', 'delete_part', { part: 'lid' })), size)).some(h => h.code === 'parts_first')).toBe(false)
  })

  it('handles 200 000 triangles (timing only noted)', async () => {
    const big = gridBox(100, 100, 20, 150, 150, 60)
    const n = big.indices.length / 3
    const flags = new Uint8Array(n)
    for (let t = 0; t < n; t++) { const z = [0, 1, 2].map(k => big.positions[3 * (big.indices[3 * t + k] as number) + 2] as number); if (z.every(v => Math.abs(v - 20) < 1e-9)) flags[t] = 1 }
    const m = assignSegment(big, 'lid', flags)
    const t0 = performance.now()
    const out = removeParts(m, { part: 'lid', mode: 'delete', closeHole: 'fill', removeUnused: true })
    const ms = performance.now() - t0
    console.info(`parts: delete a region on ${n} triangles (${out.removed} removed, ${out.capTriangles} cap triangles) took ${Math.round(ms)} ms`)
    expect(out.closedAfter).toBe(true)
    expect(ms).toBeLessThan(15000)
  }, 60000)
})
