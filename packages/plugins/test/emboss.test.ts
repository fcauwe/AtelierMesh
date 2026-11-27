import { describe, expect, it } from 'vitest'
import { measureMesh, selectTriangles } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'
import { sphereMesh } from '@ateliermesh/core/testing'
import { embossRings, findAnchor } from '../src/emboss/embosscore'
import { buildAdjacency } from '../src/emboss/adjacency'
import { extractPatch } from '../src/emboss/patch'
import { lscm, normaliseUV, stretchStats } from '../src/emboss/unfold'
import type { EmbossInput } from '../src/emboss/embosscore'
import type { Ring } from '../src/emboss/cut'
import { frustum, gridBox, letterL, rect } from './parts'

const bboxOf = (rings: Ring[]): [number, number, number, number] => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const r of rings) for (const [x, y] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
  return [x0, y0, x1, y1]
}
const run = (mesh: Mesh, point: [number, number, number], rings: Ring[], extra: Partial<EmbossInput> = {}) =>
  embossRings({ mesh, point, rings, bbox: bboxOf(rings), height: 0.8, mode: 'raised', ...extra })

/** Area-weighted centre and bounding box of the triangles in a segment. */
function segmentStats(m: Mesh, name: string, minZ = -Infinity): { area: number; cx: number; cy: number; cz: number; bbox: number[] } {
  const sel = selectTriangles(m, name) as Uint8Array
  let area = 0, cx = 0, cy = 0, cz = 0
  const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (let t = 0; t < sel.length; t++) {
    if (!sel[t]) continue
    const v = [0, 1, 2].map(k => m.indices[3 * t + k] as number)
    if (v.some(i => (m.positions[3 * i + 2] as number) < minZ)) continue
    const p = v.map(i => [m.positions[3 * i] as number, m.positions[3 * i + 1] as number, m.positions[3 * i + 2] as number])
    const u = [p[1]![0]! - p[0]![0]!, p[1]![1]! - p[0]![1]!, p[1]![2]! - p[0]![2]!], w = [p[2]![0]! - p[0]![0]!, p[2]![1]! - p[0]![1]!, p[2]![2]! - p[0]![2]!]
    const a = 0.5 * Math.hypot(u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!)
    area += a
    cx += (a * (p[0]![0]! + p[1]![0]! + p[2]![0]!)) / 3; cy += (a * (p[0]![1]! + p[1]![1]! + p[2]![1]!)) / 3; cz += (a * (p[0]![2]! + p[1]![2]! + p[2]![2]!)) / 3
    for (const q of p) for (let k = 0; k < 3; k++) { bb[k] = Math.min(bb[k]!, q[k]!); bb[3 + k] = Math.max(bb[3 + k]!, q[k]!) }
  }
  return { area, cx: cx / area, cy: cy / area, cz: cz / area, bbox: bb }
}

describe('emboss on a flat plate (40 x 20 x 3, 0.5 mm triangles)', () => {
  const plate = gridBox(40, 20, 3, 80, 40, 6)
  const base = measureMesh(plate)

  it('raised: one closed mesh whose volume grows by letter area x height exactly', () => {
    const rings = [rect(-5, -2, 5, 2)]
    const r = run(plate, [0, 0, 3], rings)
    const m = measureMesh(r.mesh)
    expect(m.watertight).toBe(true)
    expect(m.volume - base.volume).toBeCloseTo(10 * 4 * 0.8, 6)
    expect(m.bbox.max[2]).toBeCloseTo(3.8, 9)           // grows by exactly the height
    expect(r.report.volume_estimate).toBeCloseTo(32, 6)
    expect(r.report.worst_stretch).toBeCloseTo(1, 6)
  })

  it('engraved removes the same volume and the bounding box does not grow', () => {
    const r = run(plate, [0, 0, 3], [rect(-5, -2, 5, 2)], { mode: 'engraved' })
    const m = measureMesh(r.mesh)
    expect(m.watertight).toBe(true)
    expect(base.volume - m.volume).toBeCloseTo(32, 6)
    expect(m.bbox.max[2]).toBeCloseTo(3, 9)
  })

  it('a hole in a letter stays a hole (even-odd outlines)', () => {
    const r = run(plate, [0, 0, 3], [rect(-6, -4, 6, 4), rect(-3, -2, 3, 2)])
    expect(measureMesh(r.mesh).volume - base.volume).toBeCloseTo((12 * 8 - 6 * 4) * 0.8, 6)
    expect(measureMesh(r.mesh).watertight).toBe(true)
  })

  it('the letters read correctly: an L keeps its bar on the left and its foot to the right, not mirrored', () => {
    const r = run(plate, [0, 0, 3], [letterL().map(([x, y]) => [x - 3, y - 5] as [number, number])])
    const s = segmentStats(r.mesh, 'text', 3.5)
    // top face seen from above: +x east, +y north. The L's area centre is at (1.857, 3.857) in letter coordinates, minus the (3, 5) offset
    expect(s.cx).toBeCloseTo(1.857 - 3, 1)
    expect(s.cy).toBeCloseTo(3.857 - 5, 1)
    expect(s.bbox[5]).toBeCloseTo(3.8, 9)
  })

  it('direction turns the text by exactly that angle at the anchor', () => {
    const L = letterL().map(([x, y]) => [x - 3, y - 5] as [number, number])
    const at0 = segmentStats(run(plate, [0, 0, 3], [L]).mesh, 'text', 3.5)
    for (const [deg, ex, ey] of [[90, -at0.cy, at0.cx], [180, -at0.cx, -at0.cy], [270, at0.cy, -at0.cx]] as const) {
      const s = segmentStats(run(plate, [0, 0, 3], [L], { direction: deg }).mesh, 'text', 3.5)
      expect(s.cx, `x at ${deg}`).toBeCloseTo(ex, 1)
      expect(s.cy, `y at ${deg}`).toBeCloseTo(ey, 1)
    }
  })

  it('on a top face the up reference falls back, and the report says so', () => {
    const r = run(plate, [0, 0, 3], [rect(-5, -2, 5, 2)])
    expect(r.report.up_fallback).toBe(true)
    expect(r.warnings.some(w => w.code === 'emboss.up_fallback')).toBe(false)   // no hint: the text just reads along the longest side
  })

  it('on a vertical wall with world Z as the reference the text stands upright', () => {
    const block = gridBox(40, 20, 20, 40, 20, 20)
    const r = run(block, [0, -10, 10], [rect(-5, -2, 5, 2)], { normal: [0, -1, 0] })
    const s = segmentStats(r.mesh, 'text', -Infinity)
    expect(r.report.up_fallback).toBe(false)
    // the 10 wide letters run along x and the 4 tall ones along z
    expect(s.bbox[3]! - s.bbox[0]!).toBeCloseTo(10, 6)
    expect(s.bbox[5]! - s.bbox[2]!).toBeCloseTo(4, 6)
    expect(s.cz).toBeCloseTo(10, 1)
    expect(s.bbox[1]).toBeCloseTo(-10.8, 9)      // lifted outward (towards -y)
  })

  it('the letters are a segment named text; the rest keeps its label', () => {
    const r = run(plate, [0, 0, 3], [rect(-5, -2, 5, 2)], { segment: 'name' })
    expect(r.mesh.segments!.table.map(s => s.name)).toEqual(['body', 'name'])
    expect(segmentStats(r.mesh, 'name').area).toBeGreaterThan(40)  // tops plus walls
  })

  it('text off the part gives a clear failure, not a broken mesh', () => {
    expect(() => run(plate, [0, 0, 3], [rect(-30, -2, 30, 2)])).toThrowError(expect.objectContaining({ code: 'emboss.touches_patch_edge' }))
    expect(() => run(plate, [0, 0, 3], [rect(-5, -2, 5, 2)], { height: 0 })).toThrowError(expect.objectContaining({ code: 'emboss.bad_height' }))
    expect(() => run(plate, [0, 0, 3], [])).toThrowError(expect.objectContaining({ code: 'emboss.empty_shape' }))
  })
})

const turnX = (m: Mesh, deg: number): Mesh => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
  const p = new Float64Array(m.positions.length)
  for (let i = 0; i < p.length; i += 3) { p[i] = m.positions[i]!; p[i + 1] = c * m.positions[i + 1]! - s * m.positions[i + 2]!; p[i + 2] = s * m.positions[i + 1]! + c * m.positions[i + 2]! }
  return { ...m, positions: p }
}

describe('emboss on curved and tilted parts', () => {
  it('cylinder: the letters keep their size along the surface and wrap with it', () => {
    const cyl = frustum(15, 15, 40, 96, 40)
    const base = measureMesh(cyl)
    const r = run(cyl, [15, 0, 20], [rect(-10, -3, 10, 3)])
    const m = measureMesh(r.mesh)
    expect(m.watertight).toBe(true)
    expect(r.report.worst_stretch).toBeLessThan(1.02)
    // lifting along the normals of a convex surface adds area x (h + h^2 / 2R)
    expect(m.volume - base.volume).toBeCloseTo(120 * 0.8 * (1 + 0.8 / 30), -0.5)
    expect((m.volume - base.volume) / (120 * 0.8 * (1 + 0.8 / 30))).toBeGreaterThan(0.97)
    expect((m.volume - base.volume) / (120 * 0.8 * (1 + 0.8 / 30))).toBeLessThan(1.03)
    // 20 mm along the surface is about 76 degrees of the circumference: far more than a straight projection could show
    const s = segmentStats(r.mesh, 'text')
    expect(s.bbox[1]! < -9).toBe(true); expect(s.bbox[4]! > 9).toBe(true)
    expect(s.bbox[0]).toBeGreaterThan(14.9 * Math.cos((20 / 15 / 2) + 0.05) - 0.5)  // the ends curve away from the anchor's x
  })

  it('cylinder, engraved: a bit less volume is removed than on a flat part', () => {
    const cyl = frustum(15, 15, 40, 96, 40)
    const base = measureMesh(cyl)
    const r = run(cyl, [15, 0, 20], [rect(-10, -3, 10, 3)], { mode: 'engraved' })
    const m = measureMesh(r.mesh)
    expect(m.watertight).toBe(true)
    const removed = base.volume - m.volume
    expect(removed / (120 * 0.8 * (1 - 0.8 / 30))).toBeGreaterThan(0.97)
    expect(removed / (120 * 0.8 * (1 - 0.8 / 30))).toBeLessThan(1.03)
  })

  it('cone: stretch stays close to 1 (a cone unrolls without stretching)', () => {
    const cone = frustum(15, 5, 40, 96, 40)
    const r = run(cone, [10, 0, 20], [rect(-8, -3, 8, 3)], { normal: [0.97, 0, 0.24] })
    expect(measureMesh(r.mesh).watertight).toBe(true)
    expect(r.report.worst_stretch).toBeLessThan(1.05)
  })

  it('sphere cap: the worst stretch is reported and stays inside the limit', () => {
    const sph = sphereMesh(20, 4)
    const r = run(sph, [0, 0, 20], [rect(-7.5, -2, 7.5, 2)])
    expect(measureMesh(r.mesh).watertight).toBe(true)
    expect(r.report.worst_stretch).toBeGreaterThan(1)
    expect(r.report.worst_stretch).toBeLessThan(1.15)
  })

  it('too much stretch is refused with the measured value', () => {
    const sph = sphereMesh(20, 4)
    expect(() => run(sph, [0, 0, 20], [rect(-30, -4, 30, 4)], { margin: 12, stretchRefuse: 1.1 })).toThrowError(expect.objectContaining({ code: expect.stringMatching(/emboss\.(too_much_stretch|touches_patch_edge|patch_not_disk|fold_over)/) as unknown }))
  })

  it('a tilted face gives the same volume change as a flat one', () => {
    const plate = turnX(gridBox(40, 20, 3, 80, 40, 6), 30)
    const a = (30 * Math.PI) / 180
    const base = measureMesh(plate)
    const r = run(plate, [0, -3 * Math.sin(a), 3 * Math.cos(a)], [rect(-5, -2, 5, 2)])
    expect(measureMesh(r.mesh).volume - base.volume).toBeCloseTo(32, 5)
    expect(measureMesh(r.mesh).watertight).toBe(true)
  })

  it('a 100 mm text on a sheet with 0.5 mm triangles takes about 3 s or less with a band-shaped patch', () => {
    const sheet = gridBox(120, 40, 3, 240, 80, 2)
    const t0 = performance.now()
    const r = run(sheet, [0, 0, 3], [rect(-50, -3, 50, 3)], { patch: 'band' })
    const ms = performance.now() - t0
    expect(measureMesh(r.mesh).volume - measureMesh(sheet).volume).toBeCloseTo(100 * 6 * 0.8, 4)
    expect(r.report.patch_triangles).toBeLessThan(30000)
    expect(ms).toBeLessThan(process.env['COVERAGE'] ? 600000 : 6000) // the coverage instrumentation slows the hot loops a lot
  })
})

describe('guards', () => {
  it('text that runs over a corner of the part says that growth stopped at an edge; text that runs off a plate does too (its sides are edges)', () => {
    const block = gridBox(40, 20, 20, 40, 20, 20)
    let err: { code?: string; params?: Record<string, unknown> } = {}
    try { run(block, [0, 0, 20], [rect(-25, -2, 25, 2)]) } catch (e) { err = e as typeof err }
    expect(err.code).toBe('emboss.touches_patch_edge')
    expect(err.params).toMatchObject({ stopped_at_crease: true })
  })

  it('engraving too deep for the wall behind fails with the numbers', () => {
    const plate = gridBox(40, 20, 3, 40, 20, 3)
    expect(() => run(plate, [0, 0, 3], [rect(-5, -2, 5, 2)], { mode: 'engraved', height: 2.8 })).toThrowError(expect.objectContaining({ code: 'emboss.wall_too_thin', params: expect.objectContaining({ depth: 2.8 }) as unknown }))
    const ok = run(plate, [0, 0, 3], [rect(-5, -2, 5, 2)], { mode: 'engraved', height: 1 })
    expect(ok.report.wall_behind).toBeCloseTo(3, 6)
    // the check can be switched off (minWall 0): a designer who knows better
    expect(measureMesh(run(plate, [0, 0, 3], [rect(-5, -2, 5, 2)], { mode: 'engraved', height: 2.8, minWall: 0 }).mesh).watertight).toBe(true)
  })

  it('engraving deeper than the radius of a convex part collapses and is refused', () => {
    const thin = frustum(3, 3, 20, 48, 20)
    expect(() => run(thin, [3, 0, 10], [rect(-1.5, -1.5, 1.5, 1.5)], { mode: 'engraved', height: 4, minWall: 0 })).toThrowError(expect.objectContaining({ code: 'emboss.curvature_collapse' }))
  })

  const twoBodies = (): Mesh => {
    const a = gridBox(40, 20, 3, 40, 20, 3), b = gridBox(40, 20, 3, 40, 20, 3)
    const n = a.positions.length / 3
    return {
      positions: Float64Array.from([...a.positions, ...b.positions.map((v, i) => (i % 3 === 0 ? v + 100 : v))]),
      indices: Uint32Array.from([...a.indices, ...Array.from(b.indices, i => i + n)]),
      groups: [{ start: 0, count: a.indices.length / 3, role: 'solid' as const, name: 'left' }, { start: a.indices.length / 3, count: b.indices.length / 3, role: 'solid' as const, name: 'right' }],
    }
  }
  const bodyVolume = (m: Mesh, gi: number): { volume: number; watertight: boolean } => {
    const g = m.groups![gi]!
    const idx = m.indices.slice(3 * g.start, 3 * (g.start + g.count))
    return measureMesh({ positions: m.positions, indices: idx })
  }

  it('on a part made of bodies, the text goes on one body and every body stays a closed range of triangles', () => {
    const m = twoBodies()
    const before = [bodyVolume(m, 0).volume, bodyVolume(m, 1).volume]
    const r = run(m, [100, 0, 3], [rect(-5, -2, 5, 2)])
    const out = r.mesh
    expect(out.groups!.map(g => g.name)).toEqual(['left', 'right'])
    expect(out.groups!.reduce((s, g) => s + g.count, 0)).toBe(out.indices.length / 3)
    expect(out.groups![1]!.start).toBe(out.groups![0]!.count)
    expect(bodyVolume(out, 0).volume).toBeCloseTo(before[0]!, 6)                 // the left body is untouched
    expect(bodyVolume(out, 1).volume - before[1]!).toBeCloseTo(10 * 4 * 0.8, 6)  // the right one carries the letters
    expect(bodyVolume(out, 0).watertight).toBe(true); expect(bodyVolume(out, 1).watertight).toBe(true)
  })

  it('refuses text on a negative body, and groups that do not cover the mesh', () => {
    const m = twoBodies()
    expect(() => run({ ...m, groups: [m.groups![0]!, { ...m.groups![1]!, role: 'negative' as const }] }, [100, 0, 3], [rect(-5, -2, 5, 2)])).toThrowError(expect.objectContaining({ code: 'emboss.on_negative_body' }))
    expect(() => run({ ...m, groups: [m.groups![0]!] }, [0, 0, 3], [rect(-5, -2, 5, 2)])).toThrowError(expect.objectContaining({ code: 'emboss.groups_unsupported' }))
  })
})

describe('unfolding', () => {
  it('a wrap far past 90 degrees still unfolds from the plain projection (ARAP repairs the fold)', () => {
    const cyl = frustum(15, 15, 40, 96, 40)
    const r = run(cyl, [15, 0, 20], [rect(-23, -3, 23, 3)], { margin: 6, patch: 'disk' })
    expect(measureMesh(r.mesh).watertight).toBe(true)
    expect(r.report.worst_stretch).toBeLessThan(1.1)
  })

  it('LSCM, the fallback, also unfolds a cylinder strip without flips and with little stretch', () => {
    const cyl = frustum(15, 15, 40, 96, 40)
    const adj = buildAdjacency(cyl.indices)
    const anchor = findAnchor(cyl, [15, 0, 20])
    const patch = extractPatch(cyl, adj, anchor.tri, tt => {
      const c = [0, 1, 2].map(k => cyl.positions[3 * (cyl.indices[3 * tt + k] as number)] as number)
      const z = [0, 1, 2].map(k => cyl.positions[3 * (cyl.indices[3 * tt + k] as number) + 2] as number)
      return Math.max(...z) <= 26 && Math.min(...z) >= 14 && Math.min(...c) > -3
    }, { maxNormalDeg: 120, creaseDeg: 40 })
    expect(patch.topology.disk).toBe(true)
    let pa = 0, best = Infinity, pb = 0, far = -1
    for (let v = 0; v < patch.nv; v++) { const d = Math.hypot(...[0, 1, 2].map(k => (patch.P[3 * v + k] as number) - anchor.point[k]!)); if (d < best) { best = d; pa = v } }
    for (let v = 0; v < patch.nv; v++) { const d = Math.hypot(...[0, 1, 2].map(k => (patch.P[3 * v + k] as number) - (patch.P[3 * pa + k] as number))); if (d > far) { far = d; pb = v } }
    const uv = normaliseUV(patch, lscm(patch, pa, pb, far, 1e-8))
    const s = stretchStats(patch, uv)
    expect(s.flips).toBe(0)
    expect(s.maxStretch).toBeLessThan(1.05)
    // the map keeps lengths: the strip is a quarter of the circumference or more, so it must be wider than the chord
    const xs = Array.from({ length: patch.nv }, (_, v) => uv[2 * v] as number)
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(20)
  })
})

describe('small gaps in the patch', () => {
  it('a few rejected triangles inside a smooth area do not stop the patch from being a disk', () => {
    const plate = gridBox(40, 20, 3, 80, 40, 6)
    const adj = buildAdjacency(plate.indices)
    const a = findAnchor(plate, [0, 0, 3])
    const opts = { maxNormalDeg: 100, creaseDeg: 40 }
    const all = (): boolean => true
    const plain = extractPatch(plate, adj, a.tri, all, opts)
    // reject the triangles of one interior neighbour of the anchor's neighbour: a gap, closed on all sides
    const gap = new Set<number>()
    for (let e = 0; e < 3; e++) { const n = adj.adj[3 * a.tri + e] as number; for (let k = 0; k < 3; k++) { const w = adj.adj[3 * n + k] as number; if (w !== a.tri && w >= 0) { gap.add(w); break } } ; break }
    const holey = extractPatch(plate, adj, a.tri, t => !gap.has(t), opts)
    expect(plain.topology.disk).toBe(true)
    expect(holey.topology.disk).toBe(true)
    expect(holey.nt).toBe(plain.nt)
  })
})

describe('text on a coarse model', () => {
  it('a 12-triangle box takes the text: the box is refined first and stays a closed solid', () => {
    const box = gridBox(40, 30, 10, 1, 1, 1)
    expect(box.indices.length / 3).toBe(12)
    const r = run(box, [0, 0, 10], [rect(-6, -2, 6, 2)])
    const m = measureMesh(r.mesh)
    expect(m.watertight).toBe(true)
    expect(m.volume - measureMesh(box).volume).toBeCloseTo(12 * 4 * 0.8, 3)
    expect(m.bbox.max[2]).toBeCloseTo(10.8, 6)
  })

  it('refining keeps the shape, the body ranges and the segment labels', async () => {
    const { refineOnce } = await import('../src/emboss/refine')
    const box = gridBox(10, 10, 10, 1, 1, 1)
    const withSeg = { ...box, groups: [{ start: 0, count: 12, role: 'solid' as const, name: 'a' }], segments: { labels: Uint16Array.from({ length: 12 }, (_, i) => i % 2), table: [{ id: 0, name: 'body' }, { id: 1, name: 'top' }] } }
    const r = refineOnce(withSeg)
    expect(r.indices.length / 3).toBe(48)
    expect(r.groups).toEqual([{ start: 0, count: 48, role: 'solid', name: 'a' }])
    expect(Array.from(r.segments!.labels.slice(0, 8))).toEqual([0, 0, 0, 0, 1, 1, 1, 1])
    const a = measureMesh(withSeg), b = measureMesh(r)
    expect(b.volume).toBeCloseTo(a.volume, 9)
    expect(b.watertight).toBe(true)
  })

  it('a model that is not coarse keeps its error', () => {
    const sph = sphereMesh(20, 3)
    expect(() => run(sph, [0, 0, 20], [rect(-30, -4, 30, 4)], { margin: 12, stretchRefuse: 1.1 })).toThrowError(expect.objectContaining({ code: expect.stringMatching(/emboss\./) as unknown }))
  })
})
