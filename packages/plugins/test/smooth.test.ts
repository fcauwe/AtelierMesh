import { describe, expect, it } from 'vitest'
import { MeshError, Registry, addStep, assignSegment, emptyStepList, makeStep, measureMesh, runFixtures, runWorkflow, sha256Hex, validateManifest } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'
import { DEFORM_PLUGIN_ID, DEFORM_PLUGIN_VERSION, corePlugin, smoothFixtures, deformManifest, deformPlugin, orderHints, smoothMesh, taubinFactors } from '../src'
import { gridBox, sphere } from '../src/samples'
import type { SmoothOptions } from '../src'

const registry = (): Registry => new Registry().register(corePlugin()).register(deformPlugin())
const sm = (id: string, params: Record<string, unknown>) => makeStep({ id, plugin: { id: DEFORM_PLUGIN_ID, version: DEFORM_PLUGIN_VERSION }, op: 'smooth', params })
const run = (mesh: Mesh, params: Record<string, unknown>, signal?: AbortSignal) =>
  runWorkflow(addStep(emptyStepList(), sm('s', params)), { registry: registry(), source: mesh, ...(signal ? { signal } : {}) })
const base: SmoothOptions = { iterations: 10, strength: 0.5, keepEdges: 40, keepBorders: true, keepVolume: true, maxMove: 0, region: null, falloff: 0 }

const rng = (seed: number): (() => number) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
/** A ball of radius r whose vertices are pushed in or out by up to `amp` mm. */
const noisyBall = (r: number, subdivisions: number, amp: number, seed = 1): Mesh => {
  const m = sphere(r, subdivisions)
  const rand = rng(seed)
  const p = Float64Array.from(m.positions)
  for (let i = 0; i < p.length; i += 3) { const k = 1 + ((rand() - 0.5) * 2 * amp) / r; p[i] = (p[i] as number) * k; p[i + 1] = (p[i + 1] as number) * k; p[i + 2] = (p[i + 2] as number) * k }
  return { ...m, positions: p }
}
/** How uneven the radii of the vertices are: their standard deviation (the ball may grow or shrink a little, that is not roughness). */
const roughness = (m: Mesh, _r?: number): number => { const r: number[] = []; for (let i = 0; i < m.positions.length; i += 3) r.push(Math.hypot(m.positions[i] as number, m.positions[i + 1] as number, m.positions[i + 2] as number)); const mean = r.reduce((a, b) => a + b, 0) / r.length; return Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / r.length) }
const hash = (m: Mesh): string => sha256Hex(new Uint8Array(m.positions.buffer.slice(m.positions.byteOffset, m.positions.byteOffset + m.positions.byteLength)))

describe('smooth (deform plugin 0.3.0)', () => {
  it('has a valid manifest; only the strength may be handed to a customer', () => {
    expect(validateManifest(deformManifest).ok).toBe(true)
    const op = deformManifest.operations.find(o => o.id === 'smooth')!
    expect(op.category).toBe('shape')
    expect(op.personalisable).toBe('optional')
    expect(op.params.filter(p => p.personalisable).map(p => p.name)).toEqual(['strength'])
    expect(DEFORM_PLUGIN_VERSION).toBe('0.3.0')
  })

  it('derives mu from lambda so that the pass band is 0.1, and has no mu for plain smoothing', () => {
    for (const s of [0.1, 0.5, 0.9]) { const { lambda, mu } = taubinFactors(s, true); expect(1 / lambda + 1 / mu).toBeCloseTo(0.1, 9); expect(mu).toBeLessThan(0) }
    expect(taubinFactors(0, true)).toEqual({ lambda: 0, mu: 0 })
    expect(taubinFactors(0.5, false).mu).toBe(0)
  })

  it('takes more than 70 % of the roughness off a rough ball, keeps it closed and its volume within 1 %', async () => {
    const m = noisyBall(20, 4, 0.5)
    const before = roughness(m, 20)
    const r = await run(m, { iterations: 25, strength: 1, keep_edges: 180 })
    expect(r.ok).toBe(true)
    const out = r.mesh as Mesh
    expect(roughness(out, 20)).toBeLessThan(before * 0.3)   // more than 70 % gone
    const a = measureMesh(m), b = measureMesh(out)
    expect(b.watertight).toBe(true)
    expect(Math.abs(b.volume - a.volume) / a.volume).toBeLessThan(0.01)
    // only positions changed
    expect(out.indices).toBe(m.indices)
    expect(r.results[0]!.report!['triangles']).toBe(m.indices.length / 3)
    expect(r.results[0]!.report!['closed']).toBe(true)
  })

  it('with the default edge angle a mildly rough ball is smoothed too', async () => {
    const m = noisyBall(20, 4, 0.1)
    const r = await run(m, { iterations: 25, strength: 1 })
    expect(roughness(r.mesh as Mesh, 20)).toBeLessThan(roughness(m, 20) * 0.5)
  })

  it('plain smoothing (keep_volume off) shrinks the ball much more than the volume-keeping pair', () => {
    const m = noisyBall(20, 4, 0.2)
    const v0 = measureMesh(m).volume
    const taubin = measureMesh(smoothMesh(m, { ...base, iterations: 30, keepEdges: 180 }).mesh).volume
    const plain = measureMesh(smoothMesh(m, { ...base, iterations: 30, keepEdges: 180, keepVolume: false }).mesh).volume
    expect(Math.abs(taubin - v0) / v0).toBeLessThan(0.01)
    expect((v0 - plain) / v0).toBeGreaterThan(0.05)
  })

  it('keeps the 8 corners of a box exactly, and the points on its edges on the edges', () => {
    const m = gridBox(10, 10, 10, 4, 4, 4)
    const r = smoothMesh(m, { ...base, iterations: 40, strength: 0.8 })
    const near = (v: number, w: number): boolean => Math.abs(v - w) < 1e-6
    let corners = 0
    for (let i = 0; i < m.positions.length; i += 3) {
      const x = m.positions[i] as number, y = m.positions[i + 1] as number, z = m.positions[i + 2] as number
      const onX = near(Math.abs(x), 5), onY = near(Math.abs(y), 5), onZ = near(z, 0) || near(z, 10)
      const k = (onX ? 1 : 0) + (onY ? 1 : 0) + (onZ ? 1 : 0)
      const ox = r.mesh.positions[i] as number, oy = r.mesh.positions[i + 1] as number, oz = r.mesh.positions[i + 2] as number
      if (k === 3) { corners++; expect([ox, oy, oz]).toEqual([x, y, z]) }
      // a vertex on an edge stays on that edge (two of its three coordinates stay at the faces)
      if (k === 2) { expect((onX ? near(Math.abs(ox), 5) : true) && (onY ? near(Math.abs(oy), 5) : true) && (onZ ? near(oz, 0) || near(oz, 10) : true)).toBe(true) }
    }
    expect(corners).toBe(8)
    expect(measureMesh(r.mesh).watertight).toBe(true)
  })

  it('a strength of 0 returns the same mesh', async () => {
    const m = noisyBall(10, 3, 0.3)
    const r = smoothMesh(m, { ...base, strength: 0 })
    expect(r.identity).toBe(true)
    expect(r.mesh).toBe(m)
    const w = await run(m, { strength: 0 })
    expect(w.results[0]!.report!['unchanged']).toBe(true)
    expect(w.mesh).toBe(m)
  })

  it('smooths only a region: the vertices outside it keep their bits, and with a falloff the border keeps too', () => {
    const m = noisyBall(20, 4, 0.5)
    const nt = m.indices.length / 3
    const mask = new Uint8Array(nt)
    for (let t = 0; t < nt; t++) { let z = 0; for (let k = 0; k < 3; k++) z += m.positions[3 * (m.indices[3 * t + k] as number) + 2] as number; if (z / 3 > 3) mask[t] = 1 }
    const touched = new Uint8Array(m.positions.length / 3)
    for (let t = 0; t < nt; t++) if (mask[t]) for (let k = 0; k < 3; k++) touched[m.indices[3 * t + k] as number] = 1
    const onBorder = new Uint8Array(touched.length)
    for (let t = 0; t < nt; t++) if (!mask[t]) for (let k = 0; k < 3; k++) { const v = m.indices[3 * t + k] as number; if (touched[v]) onBorder[v] = 1 }
    const r = smoothMesh(m, { ...base, iterations: 20, keepEdges: 180, region: mask, falloff: 0 })
    let moved = 0
    for (let v = 0; v < touched.length; v++) {
      const same = Object.is(m.positions[3 * v], r.mesh.positions[3 * v]) && Object.is(m.positions[3 * v + 1], r.mesh.positions[3 * v + 1]) && Object.is(m.positions[3 * v + 2], r.mesh.positions[3 * v + 2])
      if (!touched[v]) expect(same).toBe(true); else if (!same) moved++
    }
    expect(moved).toBeGreaterThan(100)
    const f = smoothMesh(m, { ...base, iterations: 20, keepEdges: 180, region: mask, falloff: 3 })
    for (let v = 0; v < touched.length; v++) {
      if (touched[v] && !onBorder[v]) continue
      expect([f.mesh.positions[3 * v], f.mesh.positions[3 * v + 1], f.mesh.positions[3 * v + 2]]).toEqual([m.positions[3 * v], m.positions[3 * v + 1], m.positions[3 * v + 2]])
    }
    expect(f.maxDisplacement).toBeGreaterThan(0)
    expect(f.maxDisplacement).toBeLessThanOrEqual(r.maxDisplacement + 1e-9)
  })

  it('the part parameter picks a segment, and an unknown part is a clear error', async () => {
    const m = noisyBall(20, 3, 0.4)
    const nt = m.indices.length / 3
    const flags = new Uint8Array(nt)
    for (let t = 0; t < nt; t++) if (m.positions[3 * (m.indices[3 * t] as number) + 2]! > 0) flags[t] = 1
    const seg = assignSegment(m, 'top', flags)
    const r = await run(seg, { part: 'top', falloff: 0, keep_edges: 180 })
    expect(r.ok).toBe(true)
    expect(roughness(r.mesh as Mesh, 20)).toBeLessThan(roughness(seg, 20))
    const bad = await run(seg, { part: 'nope' })
    expect(bad.ok).toBe(false)
  })

  it('keeps groups, segment labels and the triangles', () => {
    const m = gridBox(10, 10, 10, 3, 3, 3)
    const nt = m.indices.length / 3
    const flags = new Uint8Array(nt).fill(0).map((_, i) => (i % 2 ? 1 : 0))
    const withSeg = assignSegment({ ...m, groups: [{ start: 0, count: nt / 2, role: 'solid' as const, name: 'a' }, { start: nt / 2, count: nt / 2, role: 'solid' as const, name: 'b' }] }, 'odd', flags)
    const r = smoothMesh(withSeg, base)
    expect(r.mesh.groups).toBe(withSeg.groups)
    expect(r.mesh.segments).toBe(withSeg.segments)
    expect(r.mesh.indices).toBe(withSeg.indices)
  })

  it('is deterministic', () => {
    const m = noisyBall(15, 3, 0.4)
    expect(hash(smoothMesh(m, base).mesh)).toBe(hash(smoothMesh(m, base).mesh))
  })

  it('max_move limits how far a point may go', () => {
    const m = noisyBall(20, 4, 0.5)
    const r = smoothMesh(m, { ...base, iterations: 40, keepEdges: 180, maxMove: 0.05 })
    expect(r.maxDisplacement).toBeLessThanOrEqual(0.05 + 1e-9)
    expect(r.capped).toBeGreaterThan(0)
    expect(smoothMesh(m, { ...base, iterations: 40, keepEdges: 180 }).maxDisplacement).toBeGreaterThan(0.05)
  })

  it('an open mesh keeps its border, or smooths along it when asked', () => {
    // a rough sheet: the top of a grid box without the rest is built by taking the triangles that face up
    const b = gridBox(20, 20, 4, 10, 10, 1)
    const keep: number[] = []
    for (let t = 0; t < b.indices.length / 3; t++) { let z = 0; for (let k = 0; k < 3; k++) z += b.positions[3 * (b.indices[3 * t + k] as number) + 2] as number; if (z / 3 > 3.99) keep.push(b.indices[3 * t] as number, b.indices[3 * t + 1] as number, b.indices[3 * t + 2] as number) }
    const rand = rng(3)
    const p = Float64Array.from(b.positions)
    for (let i = 2; i < p.length; i += 3) if (p[i]! > 3.99) p[i] = (p[i] as number) + (rand() - 0.5) * 0.4
    const sheet: Mesh = { positions: p, indices: Uint32Array.from(keep) }
    const onBorder = (i: number): boolean => Math.abs(Math.abs(sheet.positions[i] as number) - 10) < 1e-9 || Math.abs(Math.abs(sheet.positions[i + 1] as number) - 10) < 1e-9
    const kept = smoothMesh(sheet, { ...base, iterations: 20, keepEdges: 180 })
    for (let v = 0; v < p.length; v += 3) if (onBorder(v)) expect([kept.mesh.positions[v], kept.mesh.positions[v + 1], kept.mesh.positions[v + 2]]).toEqual([sheet.positions[v], sheet.positions[v + 1], sheet.positions[v + 2]])
    const free = smoothMesh(sheet, { ...base, iterations: 20, keepEdges: 180, keepBorders: false })
    let movedBorder = 0
    for (let v = 0; v < p.length; v += 3) if (onBorder(v) && free.mesh.positions[v + 2] !== sheet.positions[v + 2]) movedBorder++
    expect(movedBorder).toBeGreaterThan(0)
  })

  it('moves vertices that lie at the same place together, so a split seam stays shut', () => {
    const m = noisyBall(12, 2, 0.3)
    // unindexed: every triangle has its own three vertices
    const nt = m.indices.length / 3
    const pos = new Float64Array(nt * 9)
    for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) pos[9 * t + 3 * k + c] = m.positions[3 * (m.indices[3 * t + k] as number) + c] as number
    const split: Mesh = { positions: pos, indices: Uint32Array.from({ length: nt * 3 }, (_, i) => i) }
    const joined = smoothMesh(m, { ...base, keepEdges: 180 }).mesh
    const out = smoothMesh(split, { ...base, keepEdges: 180 }).mesh
    // the same result as on the joined mesh, vertex by vertex
    for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) expect(out.positions[9 * t + 3 * k + c]).toBeCloseTo(joined.positions[3 * (m.indices[3 * t + k] as number) + c] as number, 9)
  })

  it('stops when cancelled', () => {
    const ac = new AbortController(); ac.abort()
    expect(() => smoothMesh(noisyBall(15, 3, 0.3), { ...base, signal: ac.signal })).toThrowError(MeshError)
  })

  it('reports what it did and warns when it shrinks the model', async () => {
    const m = noisyBall(20, 3, 0.3)
    const r = await run(m, { iterations: 5, keep_edges: 180 })
    const rep = r.results[0]!.report!
    expect(rep['iterations']).toBe(5)
    expect(rep['moved_vertices']).toBeGreaterThan(100)
    expect(typeof rep['max_displacement_mm']).toBe('number')
    expect(typeof rep['mean_displacement_mm']).toBe('number')
    expect(Math.abs(rep['volume_change_percent'] as number)).toBeLessThan(1)
    expect(r.results[0]!.warnings ?? []).toEqual([])
    // plain smoothing of a small ball many times shrinks it a lot
    const shrunk = await run(sphere(5, 3), { iterations: 100, strength: 0.9, keep_edges: 180, keep_volume: false })
    expect(shrunk.results[0]!.warnings!.map(w => w.code)).toEqual(['smooth.thin_features'])
  })

  it('is fast enough: 200 000 triangles, 10 iterations', () => {
    const big = gridBox(100, 100, 2, 200, 200, 1)
    expect(big.indices.length / 3).toBeGreaterThan(150000)
    const t0 = performance.now()
    const r = smoothMesh(big, base)
    const ms = performance.now() - t0
    expect(r.movable).toBeGreaterThan(1000)
    expect(ms).toBeLessThan(4000)
  })

  it('passes its conformance fixtures', async () => {
    const results = await runFixtures(smoothFixtures, { registry: registry() })
    expect(results.length).toBeGreaterThanOrEqual(2)
    for (const r of results) expect(r.ok, `${r.name}: ${JSON.stringify(r.failures)}`).toBe(true)
  }, 120000)
})

describe('order hints for smoothing', () => {
  const l = (...ops: Array<[string, string, string]>) => ops.reduce((acc, [id, plugin, op]) => addStep(acc, makeStep({ id, plugin: { id: plugin, version: '1.0.0' }, op })), emptyStepList())
  const CORE = 'org.ateliermesh.core', VORONOI = 'org.ateliermesh.voronoi', TEXTURE = 'org.ateliermesh.texture'
  it('smoothing after a text goes above it', () => {
    const h = orderHints(l(['t', CORE, 'emboss'], ['s', DEFORM_PLUGIN_ID, 'smooth']))
    expect(h).toEqual([{ step: 's', code: 'smooth_after_text', texts: ['t'], fix: { id: 's', to: 0 } }])
  })
  it('smoothing before a shell, a texture or a twist goes below it', () => {
    expect(orderHints(l(['s', DEFORM_PLUGIN_ID, 'smooth'], ['v', VORONOI, 'voronoi_shell']))).toEqual([{ step: 's', code: 'smooth_before_surface', texts: [], fix: { id: 's', to: 1 } }])
    expect(orderHints(l(['s', DEFORM_PLUGIN_ID, 'smooth'], ['x', TEXTURE, 'texture'], ['w', DEFORM_PLUGIN_ID, 'twist']))[0]).toMatchObject({ code: 'smooth_before_surface', fix: { id: 's', to: 2 } })
  })
  it('smoothing in the right place, and reducing triangles after it, give no hint; a smooth step is not a twist', () => {
    expect(orderHints(l(['v', VORONOI, 'voronoi_shell'], ['s', DEFORM_PLUGIN_ID, 'smooth'], ['d', CORE, 'decimate'], ['t', CORE, 'emboss']))).toEqual([])
    expect(orderHints(l(['t', CORE, 'emboss'], ['s', DEFORM_PLUGIN_ID, 'smooth'])).map(h => h.code)).toEqual(['smooth_after_text'])
  })
})
