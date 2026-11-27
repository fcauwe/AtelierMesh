import { describe, expect, it } from 'vitest'
import { Registry, addStep, emptyStepList, makeStep, measureMesh, operationParamsSchema, runFixtures, runWorkflow, sha256Hex, validateManifest } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'
import { cylinderMesh } from '@ateliermesh/core/testing'
import Ajv from 'ajv/dist/2020'
import { HOLES_PLUGIN_ID, HOLES_PLUGIN_VERSION, corePlugin, holesFixtures, holesManifest, holesPlugin } from '../src'
import { gridBox } from './parts'
import { sphere } from '../src/samples'

const registry = (): Registry => new Registry().register(corePlugin()).register(holesPlugin())
const hstep = (params: Record<string, unknown>) => makeStep({ id: 'h', plugin: { id: HOLES_PLUGIN_ID, version: HOLES_PLUGIN_VERSION }, op: 'cut_hole', params })
type V3 = [number, number, number]
const at = (point: V3, normal: V3, extra: Record<string, unknown> = {}) => ({ anchor: { point, normal }, direction: 0, up_ref: 'z', ...extra })
const run = async (mesh: Mesh, params: Record<string, unknown>, opts: { quality?: 'preview' | 'export'; signal?: AbortSignal } = {}) =>
  (await runWorkflow(addStep(emptyStepList(), hstep(params)), { registry: registry(), source: mesh, quality: opts.quality ?? 'export', ...(opts.signal ? { signal: opts.signal } : {}) })).results[0]!
const hash = (m: Mesh): string => sha256Hex(new Uint8Array(m.positions.buffer.slice(m.positions.byteOffset, m.positions.byteOffset + m.positions.byteLength))) + sha256Hex(new Uint8Array(m.indices.buffer.slice(m.indices.byteOffset, m.indices.byteOffset + m.indices.byteLength)))
const vol = (m: Mesh): number => measureMesh(m).volume
const key = (P: ArrayLike<number>, T: ArrayLike<number>, t: number): string => [0, 1, 2].map(k => `${P[3 * T[3 * t + k]!]},${P[3 * T[3 * t + k]! + 1]},${P[3 * T[3 * t + k]! + 2]}`).sort().join('|')
const keys = (m: Mesh): Set<string> => { const s = new Set<string>(); for (let t = 0; t < m.indices.length / 3; t++) s.add(key(m.positions, m.indices, t)); return s }
// the 40 x 30 x 10 box: x -20..20, y -15..15, z 0..10, twelve big triangles (the hole sits inside a big triangle, the hard case)
const box = (): Mesh => ({
  positions: Float64Array.from([-20, -15, 0, 20, -15, 0, 20, 15, 0, -20, 15, 0, -20, -15, 10, 20, -15, 10, 20, 15, 10, -20, 15, 10]),
  indices: Uint32Array.from([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]),
})
const top: V3 = [0, 0, 10], up: V3 = [0, 0, 1]
/** The area of the part of a circle (centre c, radius r) that lies inside the rectangle |x| <= 20, |y| <= 15 (numerical). */
const areaInBox = (cx: number, cy: number, r: number): number => {
  let a = 0; const n = 1200, h = (2 * r) / n
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x = cx - r + (i + 0.5) * h, y = cy - r + (j + 0.5) * h
    if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r && Math.abs(x) <= 20 && Math.abs(y) <= 15) a += h * h
  }
  return a
}
const rel = (a: number, b: number): number => Math.abs(a - b) / Math.abs(b)

describe('org.ateliermesh.holes: a round hole', () => {
  it('through a box: the volume of the cylinder is gone, one closed solid, the rest untouched', async () => {
    const m = box()
    const r = await run(m, { placement: at(top, up), diameter: 5 })
    expect(r.status).toBe('ok')
    const out = r.mesh!
    expect(measureMesh(out).watertight).toBe(true)
    expect(rel(vol(m) - vol(out), Math.PI * 2.5 * 2.5 * 10)).toBeLessThan(0.005)
    // the side faces and the bottom are not touched by the hole: their triangles are still there, bit for bit
    const after = keys(out)
    for (const t of [4, 5, 6, 7, 8, 9, 10, 11]) expect(after.has(key(m.positions, m.indices, t))).toBe(true)   // the four side faces
    expect(r.report!['through']).toBe(true)
  })
  it('keeps every triangle away from the hole, in the same order, on a finely divided plate', async () => {
    const m = gridBox(60, 40, 8, 60, 40, 8)
    const r = await run(m, { placement: at([5, 3, 8], up), diameter: 6 })
    expect(r.status).toBe('ok')
    const out = r.mesh!
    const before = keys(m), after = keys(out)
    let kept = 0, far = 0
    for (let t = 0; t < m.indices.length / 3; t++) {
      const cx = [0, 1, 2].reduce((s, k) => s + m.positions[3 * m.indices[3 * t + k]!]!, 0) / 3, cy = [0, 1, 2].reduce((s, k) => s + m.positions[3 * m.indices[3 * t + k]! + 1]!, 0) / 3
      if (Math.hypot(cx - 5, cy - 3) > 7) { far++; if (after.has(key(m.positions, m.indices, t))) kept++ }
    }
    expect(kept).toBe(far)
    expect(before.size).toBeGreaterThan(after.size - 1000)
    expect(measureMesh(out).watertight).toBe(true)
  })
  it('a blind hole: the depth is the depth, the bottom is flat and the wall under it is reported', async () => {
    const m = box()
    const r = await run(m, { placement: at(top, up), diameter: 6, depth: 4 })
    expect(r.status).toBe('ok')
    expect(rel(vol(m) - vol(r.mesh!), Math.PI * 9 * 4)).toBeLessThan(0.005)
    expect(r.report!['through']).toBe(false)
    expect(r.report!['wall_under_bottom']).toBeCloseTo(6, 3)
    expect(measureMesh(r.mesh!).watertight).toBe(true)
  })
  it('warns when the wall under a blind hole is thinner than the minimum', async () => {
    const r = await run(box(), { placement: at(top, up), diameter: 4, depth: 9.5, min_wall: 0.8 })
    expect(r.status).toBe('ok')
    expect(r.warnings!.map(w => w.code)).toContain('holes.thin_wall')
  })
  it('goes along the surface normal on a face, and along an axis when asked', async () => {
    const m = box()
    const side = await run(m, { placement: at([20, 0, 5], [1, 0, 0]), diameter: 4 })
    expect(rel(vol(m) - vol(side.mesh!), Math.PI * 4 * 40)).toBeLessThan(0.005)
    const viaZ = await run(m, { placement: at([20, 0, 5], [1, 0, 0]), diameter: 4, axis: 'z' })   // along z from the point, down to the bottom
    expect(viaZ.status).toBe('ok')
    expect(measureMesh(viaZ.mesh!).watertight).toBe(true)
  })
  it('a hole through the middle of a hollow part cuts both walls and leaves the cavity', async () => {
    const outer = box()
    // a cavity 36 x 26 x 6 inside, with its triangles turned inside out
    const inner: Mesh = {
      positions: Float64Array.from([-18, -13, 2, 18, -13, 2, 18, 13, 2, -18, 13, 2, -18, -13, 8, 18, -13, 8, 18, 13, 8, -18, 13, 8]),
      indices: Uint32Array.from(Array.from(box().indices).map((v, i, a) => (i % 3 === 1 ? a[i + 1]! : i % 3 === 2 ? a[i - 1]! : v))),
    }
    const hollow: Mesh = { positions: Float64Array.from([...outer.positions, ...inner.positions]), indices: Uint32Array.from([...outer.indices, ...Array.from(inner.indices, v => v + 8)]) }
    expect(measureMesh(hollow).watertight).toBe(true)
    const r = await run(hollow, { placement: at(top, up), diameter: 5 })
    expect(r.status).toBe('ok')
    expect(measureMesh(r.mesh!).watertight).toBe(true)
    expect(rel(vol(hollow) - vol(r.mesh!), Math.PI * 6.25 * 4)).toBeLessThan(0.006)   // the top wall (2 mm) and the bottom wall (2 mm)
  })
  it('on a sphere it follows the normal and removes the right piece', async () => {
    const R = 12, a = 2
    const s = sphere(R, 4)
    const r = await run(s, { placement: at([0, 0, R], up), diameter: 2 * a })
    expect(r.status).toBe('ok')
    expect(measureMesh(r.mesh!).watertight).toBe(true)
    const expected = ((4 * Math.PI) / 3) * (R ** 3 - (R * R - a * a) ** 1.5)
    expect(rel(vol(s) - vol(r.mesh!), expected)).toBeLessThan(0.03)
  })
  it('on the side of a cylinder', async () => {
    const c = cylinderMesh(10, 20, 96)
    const r = await run(c, { placement: at([10, 0, 10], [1, 0, 0]), diameter: 4 })
    expect(r.status).toBe('ok')
    expect(measureMesh(r.mesh!).watertight).toBe(true)
    expect(vol(c) - vol(r.mesh!)).toBeGreaterThan(Math.PI * 4 * 20 * 0.95)
  })
  it('across an edge and at a corner: the hole opens through two and three faces and the result is closed', async () => {
    const m = box()
    const edge = await run(m, { placement: at([19.5, 0, 10], up), diameter: 6 })
    expect(edge.status).toBe('ok')
    expect(measureMesh(edge.mesh!).watertight).toBe(true)
    expect(rel(vol(m) - vol(edge.mesh!), areaInBox(19.5, 0, 3) * 10)).toBeLessThan(0.01)
    const corner = await run(m, { placement: at([19.5, 14.5, 10], up), diameter: 6 })
    expect(corner.status).toBe('ok')
    expect(measureMesh(corner.mesh!).watertight).toBe(true)
    expect(rel(vol(m) - vol(corner.mesh!), areaInBox(19.5, 14.5, 3) * 10)).toBeLessThan(0.01)
  })
})

describe('org.ateliermesh.holes: other shapes', () => {
  it('a slot has the area of a stadium', async () => {
    const m = box()
    const r = await run(m, { placement: at(top, up), shape: 'slot', diameter: 4, length: 12 })
    expect(r.status).toBe('ok')
    expect(measureMesh(r.mesh!).watertight).toBe(true)
    expect(rel(vol(m) - vol(r.mesh!), (8 * 4 + Math.PI * 4) * 10)).toBeLessThan(0.006)
  })
  it('a turned slot lies along the turned direction', async () => {
    const r = await run(box(), { placement: at(top, up), shape: 'slot', diameter: 3, length: 14, rotation: 90 })
    expect(r.status).toBe('ok')
    // the slot runs along y now: it reaches y = +-7 but not x = +-7
    const P = r.mesh!.positions
    let maxX = 0, maxY = 0
    for (let i = 0; i < P.length; i += 3) { if (Math.abs(P[i + 2]! - 10) < 1e-6 && Math.hypot(P[i]!, P[i + 1]!) < 10) { maxX = Math.max(maxX, Math.abs(P[i]!)); maxY = Math.max(maxY, Math.abs(P[i + 1]!)) } }
    expect(maxY).toBeGreaterThan(6.5)
    expect(maxX).toBeLessThan(2)
  })
  it('a square with rounded corners', async () => {
    const m = box()
    const r = await run(m, { placement: at(top, up), shape: 'square', diameter: 6, length: 8, corner_radius: 1 })
    expect(r.status).toBe('ok')
    expect(measureMesh(r.mesh!).watertight).toBe(true)
    expect(rel(vol(m) - vol(r.mesh!), (48 - (4 - Math.PI)) * 10)).toBeLessThan(0.006)
  })
  it('a countersink adds the volume of a cone; a counterbore adds a wider cylinder', async () => {
    const m = box()
    const cs = await run(m, { placement: at(top, up), diameter: 4, countersink: 'countersink', countersink_diameter: 10 })
    expect(cs.status).toBe('ok')
    expect(measureMesh(cs.mesh!).watertight).toBe(true)
    const removed = Math.PI * 4 * 7 + (Math.PI / 3) * 3 * (25 + 10 + 4)
    expect(rel(vol(m) - vol(cs.mesh!), removed)).toBeLessThan(0.01)
    const cb = await run(m, { placement: at(top, up), diameter: 4, countersink: 'counterbore', countersink_diameter: 8, countersink_depth: 3 })
    expect(cb.status).toBe('ok')
    expect(measureMesh(cb.mesh!).watertight).toBe(true)
    expect(rel(vol(m) - vol(cb.mesh!), Math.PI * 16 * 3 + Math.PI * 4 * 7)).toBeLessThan(0.006)
  })
})

describe('org.ateliermesh.holes: part, problems and the rest', () => {
  const labelled = (): Mesh => {
    const m = box()
    // the two triangles of the top face are the segment "top"
    const labels = new Uint16Array(12); labels[2] = 1; labels[3] = 1
    return { ...m, segments: { labels, table: [{ id: 0, name: 'body' }, { id: 1, name: 'top' }] } }
  }
  it('a blind hole in the selected part leaves every other triangle alone', async () => {
    const m = labelled()
    const r = await run(m, { placement: at(top, up), diameter: 4, depth: 4, part: 'top' })
    expect(r.status).toBe('ok')
    const after = keys(r.mesh!)
    for (const t of [0, 1, 4, 5, 6, 7, 8, 9, 10, 11]) expect(after.has(key(m.positions, m.indices, t))).toBe(true)
    expect(r.mesh!.segments).toBeTruthy()
  })
  it('a hole that would open an unselected part is refused', async () => {
    const r = await run(labelled(), { placement: at(top, up), diameter: 4, part: 'top' })      // through: it would also cut the bottom
    expect(r.status).toBe('error')
    expect(r.error?.code).toBe('holes.breaches')
  })
  it('a step without a place is an error with its own code; a hole beside the model misses it; one bigger than the model removes it all', async () => {
    expect((await run(box(), { placement: null })).error?.code).toBe('holes.no_placement')
    expect((await run(box(), { placement: at([100, 0, 10], up), diameter: 4 })).error?.code).toBe('holes.misses_model')
    expect((await run(box(), { placement: at(top, up), diameter: 100 })).error?.code).toBe('holes.too_big')
  })
  it('refuses a model that is not closed and several bodies', async () => {
    const open: Mesh = { positions: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: Uint32Array.from([0, 1, 2]) }
    expect((await run(open, { placement: at([0.2, 0.2, 0], up), diameter: 1 })).error?.code).toBe('holes.bad_input')
    const two: Mesh = { ...box(), groups: [{ start: 0, count: 6, role: 'solid', name: 'a' }, { start: 6, count: 6, role: 'solid', name: 'b' }] }
    expect((await run(two, { placement: at(top, up), diameter: 4 })).error?.code).toBe('holes.groups_unsupported')
  })
  it('a model with one body is fine and keeps it', async () => {
    const one: Mesh = { ...box(), groups: [{ start: 0, count: 12, role: 'solid', name: 'Part 1' }] }
    const r = await run(one, { placement: at(top, up), diameter: 4 })
    expect(r.status).toBe('ok')
    expect(r.mesh!.groups?.length).toBe(1)
    expect(r.mesh!.groups![0]!.count).toBe(r.mesh!.indices.length / 3)
  })
  it('is deterministic', async () => {
    const a = await run(box(), { placement: at([3, 2, 10], up), diameter: 5 }), b = await run(box(), { placement: at([3, 2, 10], up), diameter: 5 })
    expect(hash(a.mesh!)).toBe(hash(b.mesh!))
  })
  it('can be cancelled', async () => {
    const ac = new AbortController(); ac.abort()
    const r = await run(gridBox(60, 40, 8, 60, 40, 8), { placement: at([0, 0, 8], up), diameter: 5 }, { signal: ac.signal })
    expect(r.status === 'cancelled' || r.error?.code === 'run.cancelled').toBe(true)
  })
  it('is quick on a model of 100 000 triangles', async () => {
    const m = gridBox(80, 60, 10, 160, 120, 20)
    const t0 = performance.now()
    const r = await run(m, { placement: at([3, 2, 10], up), diameter: 6 })
    const ms = performance.now() - t0
    expect(r.status).toBe('ok')
    expect(m.indices.length / 3).toBeGreaterThan(90000)
    expect(ms).toBeLessThan(2500)
  })
  it('manifest: valid, with a placement a customer can move and the diameter handed over', () => {
    expect(validateManifest(holesManifest).ok).toBe(true)
    const op = holesManifest.operations[0]!
    expect(op.params.filter(p => (p as { personalisable?: boolean }).personalisable).map(p => p.name)).toEqual(['placement', 'diameter'])
    expect(new Ajv({ strict: false }).validate(operationParamsSchema(holesManifest, op) as object, { shape: 'round', diameter: 5 })).toBe(true)
  })
  it('conformance fixtures', async () => {
    const results = await runFixtures(holesFixtures, { registry: registry() })
    for (const f of results) expect(f.failures, f.name).toEqual([])
  })
})

describe('org.ateliermesh.holes: robustness', () => {
  it('random places, shapes and sizes on a box, a sphere and a cylinder all give one closed solid', async () => {
    let st = 7
    const rnd = (): number => { st = (Math.imul(st, 1664525) + 1013904223) >>> 0; return st / 4294967296 }
    const cyl = cylinderMesh(10, 20, 96), ball = sphere(12, 4), plate = gridBox(40, 30, 10, 20, 15, 5)
    const places: Array<[Mesh, () => { point: V3; normal: V3 }]> = [
      [plate, () => { const f = Math.floor(rnd() * 3); return f === 0 ? { point: [(rnd() - 0.5) * 36, (rnd() - 0.5) * 26, 10], normal: [0, 0, 1] } : f === 1 ? { point: [20, (rnd() - 0.5) * 26, rnd() * 10], normal: [1, 0, 0] } : { point: [(rnd() - 0.5) * 36, 15, rnd() * 10], normal: [0, 1, 0] } }],
      [ball, () => { const a = rnd() * Math.PI * 2, b = Math.acos(2 * rnd() - 1); const n: V3 = [Math.sin(b) * Math.cos(a), Math.sin(b) * Math.sin(a), Math.cos(b)]; return { point: [n[0] * 12, n[1] * 12, n[2] * 12], normal: n } }],
      [cyl, () => { const a = rnd() * Math.PI * 2; return { point: [10 * Math.cos(a), 10 * Math.sin(a), 1 + rnd() * 18], normal: [Math.cos(a), Math.sin(a), 0] } }],
    ]
    for (const [mesh, place] of places) {
      for (let i = 0; i < 10; i++) {
        const shape = (['round', 'slot', 'square'] as const)[Math.floor(rnd() * 3)]!
        const r = await run(mesh, { placement: { anchor: place(), direction: Math.floor(rnd() * 8) * 45 - 180, up_ref: 'z' }, shape, diameter: 1 + rnd() * 6, length: 6 + rnd() * 8, depth: rnd() < 0.4 ? 1 + rnd() * 6 : 0, rotation: rnd() * 90, corner_radius: rnd() * 1.5 })
        expect(r.status, `${shape} ${JSON.stringify(r.error)}`).toBe('ok')
        expect(measureMesh(r.mesh!).watertight).toBe(true)
        expect(vol(r.mesh!)).toBeLessThan(vol(mesh))
      }
    }
  }, 120000)
})
