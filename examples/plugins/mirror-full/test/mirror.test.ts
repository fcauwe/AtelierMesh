import { describe, expect, it } from 'vitest'
import { Registry, addStep, emptyStepList, makeStep, measureMesh, runFixtures, runWorkflow, validateManifest, validateParams } from '@ateliermesh/core'
import type { Fixture, Mesh } from '@ateliermesh/core'
import { boxMesh } from '@ateliermesh/core/testing'
import manifest from '../manifest.json'
import module from '../main'

const ID = 'com.example.mirror'
const registry = new Registry().register({ manifest: manifest as never, load: () => module })
const step = (params: Record<string, unknown>) => makeStep({ id: 's1', plugin: { id: ID, version: '1.0.0' }, op: 'mirror', params })
const run = (params: Record<string, unknown>, source: Mesh, signal?: AbortSignal) =>
  runWorkflow(addStep(emptyStepList(), step(params)), { registry, source, ...(signal ? { signal } : {}) })

describe('the manifest', () => {
  it('is valid, and its limits are enforced', () => {
    expect(validateManifest(manifest).ok).toBe(true)
    const op = manifest.operations[0] as never
    expect(validateParams(op, { axis: 'x', mode: 'copy', gap: 9999 }).ok).toBe(false)   // max 200
    expect(validateParams(op, { axis: 'q' }).ok).toBe(false)                              // not one of the options
  })
})

describe('conformance fixtures (the same format the built-in plugins use)', () => {
  const fixtures: Fixture[] = [
    { name: 'flip a 10 x 20 x 30 box in place', input: { kind: 'generator', name: 'box', params: { width: 10, depth: 20, height: 30 } }, steps: [step({ axis: 'x', mode: 'flip' })],
      expect: { triangles: 12, volume: { value: 6000, tol: 1e-6 }, size: { value: [10, 20, 30], tol: 1e-9 }, watertight: true } },
    { name: 'a copy beside it doubles the triangles and the width', input: { kind: 'generator', name: 'box', params: { width: 10, depth: 20, height: 30 } }, steps: [step({ axis: 'x', mode: 'copy', gap: 2 })],
      expect: { triangles: 24, volume: { value: 12000, tol: 1e-6 }, size: { value: [22, 20, 30], tol: 1e-9 }, watertight: true } },
    { name: 'a gap above the limit is refused', input: { kind: 'generator', name: 'box' }, steps: [step({ axis: 'x', mode: 'copy', gap: 500 })], expect: { ok: false, error_code: 'param.out_of_range' } },
  ]
  it('pass', async () => {
    for (const r of await runFixtures(fixtures, { registry })) expect(r.failures, r.name).toEqual([])
  })
})

describe('the operation', () => {
  const box = boxMesh(10, 20, 30)
  it('mirrors in place: the vertices move, the triangles still face outwards', async () => {
    const r = await run({ axis: 'z', mode: 'flip' }, box)
    expect(r.ok).toBe(true)
    const m = r.mesh!
    expect(measureMesh(m).volume).toBeCloseTo(6000, 6)                // a positive volume means the winding is outward
    expect(m.indices.length).toBe(box.indices.length)
  })
  it('keeps the colours of parts: the body colour and the segment colour, also on the mirrored copy', async () => {
    const nt = box.indices.length / 3
    const coloured: Mesh = { ...box, segments: { labels: Uint16Array.from({ length: nt }, (_, i) => (i < 2 ? 1 : 0)), table: [{ id: 0, name: 'body' }, { id: 1, name: 'lid', color: '#ffd400' }] }, groups: [{ start: 0, count: nt, role: 'solid', name: 'shell', color: '#e5484d' }] }
    const flip = (await run({ axis: 'x', mode: 'flip' }, coloured)).mesh!
    expect(flip.groups![0]!.color).toBe('#e5484d'); expect(flip.segments!.table[1]!.color).toBe('#ffd400')
    const copy = (await run({ axis: 'y', mode: 'copy', gap: 1 }, coloured)).mesh!
    expect(copy.groups!.map(g => [g.name, g.color])).toEqual([['shell', '#e5484d'], ['shell_mirror', '#e5484d']])
    expect(copy.segments!.table[1]!.color).toBe('#ffd400')
  })
  it('keeps segments and groups through a copy, and names the new bodies', async () => {
    const nt = box.indices.length / 3
    const labelled: Mesh = { ...box, segments: { labels: Uint16Array.from({ length: nt }, (_, i) => (i < 2 ? 1 : 0)), table: [{ id: 0, name: 'body' }, { id: 1, name: 'lid' }] }, groups: [{ start: 0, count: nt, role: 'solid', name: 'box' }] }
    const m = (await run({ axis: 'y', mode: 'copy', gap: 1 }, labelled)).mesh!
    expect(m.segments!.labels.length).toBe(nt * 2)
    expect(Array.from(m.segments!.labels.slice(nt, nt + 3))).toEqual([1, 1, 0])
    expect(m.groups!.map(g => [g.name, g.start, g.count])).toEqual([['box', 0, nt], ['box_mirror', nt, nt]])
  })
  it('gives two bodies named original and mirror_... when the input had none', async () => {
    const m = (await run({ axis: 'x', mode: 'copy' }, box)).mesh!
    expect(m.groups!.map(g => g.name)).toEqual(['original', 'original_mirror'])
  })
  it('reports an empty mesh with a code, not a crash', async () => {
    const r = await run({ axis: 'x', mode: 'flip' }, { positions: new Float64Array(0), indices: new Uint32Array(0) })
    expect(r.ok).toBe(false)
    expect(r.results[0]!.error?.code).toBe('mirror.empty')
  })
  it('stops when cancelled', async () => {
    const ac = new AbortController(); ac.abort()
    const r = await run({ axis: 'x', mode: 'flip' }, box, ac.signal)
    expect(r.ok).toBe(false)
    expect(r.results[0]!.error?.code).toBe('run.cancelled')
  })
  it('gives the same mesh for the same input', async () => {
    const a = (await run({ axis: 'x', mode: 'copy', gap: 3 }, box)).mesh!, b = (await run({ axis: 'x', mode: 'copy', gap: 3 }, box)).mesh!
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions)); expect(Array.from(a.indices)).toEqual(Array.from(b.indices))
  })
})
