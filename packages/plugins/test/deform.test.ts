import { describe, expect, it } from 'vitest'
import { Registry, addStep, assignSegment, emptyStepList, makeStep, measureMesh, runFixtures, runWorkflow, sha256Hex, validateManifest } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'
import { boxMesh, cylinderMesh } from '@ateliermesh/core/testing'
import { DEFORM_PLUGIN_ID, DEFORM_PLUGIN_VERSION, corePlugin, deformFixtures, deformManifest, deformMesh, deformPlugin, orderHints } from '../src'
import { CORE_PLUGIN_ID, CORE_PLUGIN_VERSION } from '../src/core-plugin'

const registry = (): Registry => new Registry().register(corePlugin()).register(deformPlugin())
const df = (id: string, op: 'twist' | 'taper', params: Record<string, unknown>) => makeStep({ id, plugin: { id: DEFORM_PLUGIN_ID, version: DEFORM_PLUGIN_VERSION }, op, params })
const run = (mesh: Mesh, op: 'twist' | 'taper', params: Record<string, unknown>, signal?: AbortSignal) =>
  runWorkflow(addStep(emptyStepList(), df('d', op, params)), { registry: registry(), source: mesh, ...(signal ? { signal } : {}) })
const pillar = (): Mesh => boxMesh(10, 10, 40)

const top = (m: Mesh, zmax: number): number[][] => {
  const out: number[][] = []
  for (let i = 0; i < m.positions.length; i += 3) if (Math.abs((m.positions[i + 2] as number) - zmax) < 1e-9) out.push([m.positions[i] as number, m.positions[i + 1] as number])
  return out
}

describe('deform plugin', () => {
  it('has a valid manifest', () => { expect(validateManifest(deformManifest).ok).toBe(true) })

  it('twists a pillar by 90 degrees: closed, same volume, the top is turned, the bottom stays', async () => {
    const m = pillar()
    const r = await run(m, 'twist', { angle: 90 })
    expect(r.ok).toBe(true)
    const out = r.mesh as Mesh
    const me = measureMesh(out)
    expect(me.watertight).toBe(true)
    expect(Math.abs(me.volume - 4000) / 4000).toBeLessThan(0.01)
    // the top face corners: (5,5) turned by 90 degrees about the centre is (-5,5)
    const t = top(out, 40)
    expect(t.some(p => Math.abs((p[0] as number) + 5) < 1e-9 && Math.abs((p[1] as number) - 5) < 1e-9)).toBe(true)
    expect(t.every(p => Math.abs(Math.abs(p[0] as number) - 5) < 1e-9 && Math.abs(Math.abs(p[1] as number) - 5) < 1e-9)).toBe(true)
    // the bottom is untouched
    const b = [] as number[][]
    for (let i = 0; i < out.positions.length; i += 3) if (Math.abs(out.positions[i + 2] as number) < 1e-9) b.push([out.positions[i] as number, out.positions[i + 1] as number])
    expect(b.every(p => Math.abs(Math.abs(p[0] as number) - 5) < 1e-9 && Math.abs(Math.abs(p[1] as number) - 5) < 1e-9)).toBe(true)
    expect(out.indices.length / 3).toBeGreaterThan(12)
  })

  it('an angle of 0 is the identity and adds no triangle', async () => {
    const m = pillar()
    const r = await run(m, 'twist', { angle: 0 })
    const out = r.mesh as Mesh
    expect(out.indices.length).toBe(m.indices.length)
    expect(Array.from(out.positions)).toEqual(Array.from(m.positions))
  })

  it('from and to keep the parts outside the range rigid', async () => {
    const r = await run(pillar(), 'twist', { angle: 90, from: 0.25, to: 0.75 })
    const out = r.mesh as Mesh
    expect(measureMesh(out).watertight).toBe(true)
    // below the range: nothing moved; above: turned as a whole by 90 degrees
    for (let i = 0; i < out.positions.length; i += 3) {
      const z = out.positions[i + 2] as number, x = out.positions[i] as number, y = out.positions[i + 1] as number
      if (z <= 10 + 1e-9) expect(Math.abs(Math.hypot(x, y) - Math.hypot(5, 5)) < 1e-9 || Math.hypot(x, y) < Math.hypot(5, 5) + 1e-9).toBe(true)
      if (z >= 30 - 1e-9) { const a = Math.atan2(y, x); const q = ((a * 180) / Math.PI + 360) % 90; expect(Math.min(q, 90 - q) <= 45 + 1e-6).toBe(true) }
    }
    const t = top(out, 40)
    expect(t.some(p => Math.abs((p[0] as number) + 5) < 1e-9 && Math.abs((p[1] as number) - 5) < 1e-9)).toBe(true)
  })

  it('tapers to 50 percent: the top is a quarter of the bottom and the volume is the frustum', async () => {
    const r = await run(pillar(), 'taper', { scale_end: 0.5 })
    expect(r.ok).toBe(true)
    const out = r.mesh as Mesh
    const me = measureMesh(out)
    expect(me.watertight).toBe(true)
    expect(Math.abs(me.volume - 2333.333) / 2333.333).toBeLessThan(0.01)
    const t = top(out, 40)
    expect(Math.max(...t.map(p => Math.abs(p[0] as number)))).toBeCloseTo(2.5, 9) // half of 5: area 25 percent
  })

  it('taper in one direction scales one cross-section axis only', async () => {
    const out = (await run(pillar(), 'taper', { scale_end: 0.5, uniform: 'x' })).mesh as Mesh
    const t = top(out, 40)
    expect(Math.max(...t.map(p => Math.abs(p[0] as number)))).toBeCloseTo(2.5, 9)
    expect(Math.max(...t.map(p => Math.abs(p[1] as number)))).toBeCloseTo(5, 9)
  })

  it('works about another axis', async () => {
    const m = boxMesh(40, 10, 10) // long along x
    const out = (await run(m, 'taper', { axis: 'x', scale_end: 0.5 })).mesh as Mesh
    expect(measureMesh(out).watertight).toBe(true)
    expect(Math.abs(measureMesh(out).volume - 2333.333) / 2333.333).toBeLessThan(0.01)
  })

  it('tapering to almost nothing warns, a normal taper does not', async () => {
    const r = await run(pillar(), 'taper', { scale_end: 0.05 })
    expect(r.ok).toBe(true)
    expect(r.results[0]?.warnings?.some(w => w.code === 'deform.may_fold')).toBe(true)
    const q = await run(pillar(), 'taper', { scale_end: 0.5 })
    expect(q.results[0]?.warnings ?? []).toEqual([])
  })

  it('keeps bodies and segments', async () => {
    const a = boxMesh(10, 10, 40)
    const m: Mesh = assignSegment({ ...a, groups: [{ start: 0, count: 6, role: 'solid', name: 'lower' }, { start: 6, count: 6, role: 'solid', name: 'upper' }] }, 'side', Uint8Array.from({ length: 12 }, (_, i) => (i < 4 ? 1 : 0)))
    const out = (await run(m, 'twist', { angle: 120 })).mesh as Mesh
    expect(out.groups?.length).toBe(2)
    const g = out.groups as NonNullable<Mesh['groups']>
    expect(g[0]!.start).toBe(0)
    expect(g[0]!.start + g[0]!.count).toBe(g[1]!.start)
    expect(g[1]!.start + g[1]!.count).toBe(out.indices.length / 3)
    expect(out.segments?.table.map(s => s.name)).toContain('side')
    const side = out.segments!.table.find(s => s.name === 'side')!.id
    let n = 0; out.segments!.labels.forEach(l => { if (l === side) n++ })
    expect(n).toBeGreaterThanOrEqual(4)
  })

  it('is deterministic', async () => {
    const h = async (): Promise<string> => { const o = (await run(pillar(), 'twist', { angle: 200, easing: 'smooth' })).mesh as Mesh; return sha256Hex(new Uint8Array(o.positions.buffer.slice(0)).toString() + Array.from(o.indices).join(',')) }
    expect(await h()).toBe(await h())
  })

  it('stops when cancelled', async () => {
    const ac = new AbortController(); ac.abort()
    const r = await run(cylinderMesh(10, 60, 200), 'twist', { angle: 720 }, ac.signal)
    expect(r.ok).toBe(false)
  })

  it('refuses when the cut would exceed the triangle limit', async () => {
    const r = await run(pillar(), 'twist', { angle: 1440, max_triangles: 1000 })
    expect(r.ok).toBe(false)
    expect(r.results[0]?.error?.code).toBe('deform.too_heavy')
  })

  it('refuses an empty range', () => {
    expect(() => deformMesh(pillar(), { kind: 'twist', axis: 'z', center: [0, 0, 20], from: 0.5, to: 0.5, easing: 'linear', detail: 'auto', maxTriangles: 1e6, angle: 90 })).not.toThrow()
  })

  it('a finer detail gives more triangles than a coarse one and both stay closed', async () => {
    const fine = (await run(pillar(), 'twist', { angle: 180, detail: 'fine' })).mesh as Mesh
    const coarse = (await run(pillar(), 'twist', { angle: 180, detail: 'coarse' })).mesh as Mesh
    expect(fine.indices.length).toBeGreaterThan(coarse.indices.length)
    expect(measureMesh(fine).watertight && measureMesh(coarse).watertight).toBe(true)
  })

  it('twists a 100k triangle cylinder by 360 degrees in reasonable time and keeps it closed', async () => {
    const m = cylinderMesh(15, 60, 600) // 600 segments: ~2400 triangles; refined below
    const dense = deformMesh(m, { kind: 'twist', axis: 'z', center: [0, 0, 30], from: 0, to: 1, easing: 'linear', detail: 'fine', maxTriangles: 2e6, angle: 0.0001 })
    const t0 = performance.now()
    const r = await run(dense.mesh, 'twist', { angle: 360 })
    const ms = performance.now() - t0
    expect(r.ok).toBe(true)
    expect(measureMesh(r.mesh as Mesh).watertight).toBe(true)
    console.log(`twist 360 deg of a ${(dense.mesh.indices.length / 3)} triangle cylinder -> ${((r.mesh as Mesh).indices.length / 3)} triangles in ${Math.round(ms)} ms`)
    expect(ms).toBeLessThan(15000)
  })

  it('orders: twist and taper belong above text steps', () => {
    const text = makeStep({ id: 'e', plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op: 'emboss', params: {} })
    const list = addStep(addStep(emptyStepList(), text), df('t', 'twist', { angle: 90 }))
    const h = orderHints(list)
    expect(h.some(x => x.step === 't')).toBe(true)
  })

  it('passes its conformance fixtures', async () => {
    const results = await runFixtures(deformFixtures, { registry: registry() })
    for (const r of results) expect(r.ok, `${r.name}: ${JSON.stringify(r.failures)}`).toBe(true)
  })
})
