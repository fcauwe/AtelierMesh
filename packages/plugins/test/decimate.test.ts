import { describe, expect, it } from 'vitest'
import { Registry, addStep, assignSegment, emptyStepList, makeStep, measureMesh, runWorkflow } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'
import { boxMesh, cylinderMesh, sphereMesh } from '@ateliermesh/core/testing'
import { CORE_PLUGIN_ID, CORE_PLUGIN_VERSION, corePlugin, decimate, decimateBodies, decimateWasm } from '../src'
import { gridBox } from './parts'

/** The largest distance from a vertex of `a` to the surface of `b` (triangles of b, brute force; for small meshes). */
function oneSidedDistance(a: Mesh, b: Mesh, step = 1): number {
  const P = b.positions, T = b.indices
  let worst = 0
  for (let v = 0; v < a.positions.length / 3; v += step) {
    const p: [number, number, number] = [a.positions[3 * v] as number, a.positions[3 * v + 1] as number, a.positions[3 * v + 2] as number]
    let best = Infinity
    for (let t = 0; t < T.length; t += 3) {
      const A: number[] = [], B: number[] = [], C: number[] = []
      for (let k = 0; k < 3; k++) { A.push(P[3 * (T[t] as number) + k] as number); B.push(P[3 * (T[t + 1] as number) + k] as number); C.push(P[3 * (T[t + 2] as number) + k] as number) }
      best = Math.min(best, distPointTri(p, A, B, C))
      if (best < 1e-9) break
    }
    worst = Math.max(worst, best)
  }
  return worst
}
function distPointTri(p: number[], a: number[], b: number[], c: number[]): number {
  const sub = (x: number[], y: number[]): number[] => [x[0]! - y[0]!, x[1]! - y[1]!, x[2]! - y[2]!], dot = (x: number[], y: number[]): number => x[0]! * y[0]! + x[1]! * y[1]! + x[2]! * y[2]!
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a)
  const d1 = dot(ab, ap), d2 = dot(ac, ap)
  const L = (q: number[]): number => Math.hypot(...sub(p, q))
  if (d1 <= 0 && d2 <= 0) return L(a)
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp)
  if (d3 >= 0 && d4 <= d3) return L(b)
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return L([a[0]! + v * ab[0]!, a[1]! + v * ab[1]!, a[2]! + v * ab[2]!]) }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp)
  if (d6 >= 0 && d5 <= d6) return L(c)
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return L([a[0]! + w * ac[0]!, a[1]! + w * ac[1]!, a[2]! + w * ac[2]!]) }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); return L([b[0]! + w * (c[0]! - b[0]!), b[1]! + w * (c[1]! - b[1]!), b[2]! + w * (c[2]! - b[2]!)]) }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den
  return L([a[0]! + ab[0]! * v + ac[0]! * w, a[1]! + ab[1]! * v + ac[1]! * w, a[2]! + ab[2]! * v + ac[2]! * w])
}

describe('decimate', () => {
  it('sphere: reaches the target within 2 percent, stays closed, volume close, surface error small', () => {
    const sph = sphereMesh(20, 4)             // 5120 triangles
    const r = decimate(sph, { targetTriangles: 800 })
    const m = measureMesh(r.mesh)
    expect(Math.abs(r.after - 800) / 800).toBeLessThan(0.02)
    expect(m.watertight).toBe(true)
    expect(m.boundaryEdges).toBe(0)
    const v0 = measureMesh(sph).volume
    expect(Math.abs(m.volume - v0) / v0).toBeLessThan(0.05)
    // the reported error against an independent measurement of how far the new vertices are from the old surface and the other way round
    const real = Math.max(oneSidedDistance(r.mesh, sph, 1), oneSidedDistance(sph, r.mesh, 8))
    expect(real).toBeLessThan(0.6)
    expect(r.maxError).toBeGreaterThan(0)
    expect(r.maxError).toBeLessThan(real * 6 + 0.1)   // the quadric estimate is the right order of magnitude
  })

  it('cylinder: the sharp rims and the closed surface survive', () => {
    const cyl = cylinderMesh(10, 30, 96)
    const r = decimate(cyl, { targetTriangles: 200 })
    const m = measureMesh(r.mesh)
    expect(m.watertight).toBe(true)
    expect(Math.abs(r.after - 200) / 200).toBeLessThan(0.05)
    // the bounding box does not shrink: the rim vertices were held, not pulled in
    const b0 = measureMesh(cyl)
    for (let k = 0; k < 3; k++) { expect(m.size[k]).toBeGreaterThan(b0.size[k]! * 0.97); expect(m.size[k]).toBeLessThan(b0.size[k]! * 1.001) }
    // a flat cap stays flat: the top face triangles all lie at z = 30
    let atTop = 0
    for (let t = 0; t < r.mesh.indices.length; t += 3) if ([0, 1, 2].every(k => Math.abs(r.mesh.positions[3 * r.mesh.indices[t + k]! + 2]! - 30) < 1e-9)) atTop++
    expect(atTop).toBeGreaterThan(0)
  })

  it('a plate with a hole: the open boundary is kept (boundary edges stay on the boundary)', () => {
    // a grid plate (open: top face only), with a 4 x 4 square of cells removed in the middle
    const nx = 20, ny = 20
    const P: number[] = [], T: number[] = []
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) P.push(i, j, 0)
    const id = (i: number, j: number): number => j * (nx + 1) + i
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (i >= 8 && i < 12 && j >= 8 && j < 12) continue
      T.push(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1))
    }
    const plate: Mesh = { positions: Float64Array.from(P), indices: Uint32Array.from(T) }
    const r = decimate(plate, { targetTriangles: 120 })
    const m = measureMesh(r.mesh)
    expect(r.after).toBeLessThanOrEqual(130)
    // the outline stays a 20 x 20 square, and the hole is still 4 x 4: the boundary vertices are the same points as before
    expect(m.size[0]).toBeCloseTo(20, 9); expect(m.size[1]).toBeCloseTo(20, 9)
    const before = new Set<string>(), after = new Set<string>()
    const boundaryPoints = (mesh: Mesh, into: Set<string>): void => {
      const count = new Map<string, number>()
      for (let t = 0; t < mesh.indices.length; t += 3) for (let k = 0; k < 3; k++) { const a = mesh.indices[t + k]!, b = mesh.indices[t + ((k + 1) % 3)]!; const key = a < b ? `${a}_${b}` : `${b}_${a}`; count.set(key, (count.get(key) ?? 0) + 1) }
      for (const [key, n] of count) if (n === 1) for (const v of key.split('_').map(Number)) into.add(`${mesh.positions[3 * v]},${mesh.positions[3 * v + 1]}`)
    }
    boundaryPoints(plate, before); boundaryPoints(r.mesh, after)
    for (const p of after) expect(before.has(p), p).toBe(true)     // no boundary vertex moved off the original boundary
    expect(oneSidedDistance(r.mesh, plate)).toBeLessThan(1e-9)    // a flat plate stays exactly flat
  })

  it('creases: a box shrinks from 768 triangles to under 100 and keeps its corners and its exact volume', () => {
    const box = gridBox(20, 20, 20, 8, 8, 8)
    const r = decimate(box, { targetTriangles: 12 })
    expect(r.after).toBeGreaterThanOrEqual(12)
    expect(r.after).toBeLessThanOrEqual(100)    // a face whose every vertex is held on a crease cannot lose its diagonals without cutting a corner
    const m = measureMesh(r.mesh)
    expect(m.watertight).toBe(true)
    expect(m.volume).toBeCloseTo(8000, 3)
    expect(m.size).toEqual([20, 20, 20])
  })

  it('segment borders are held: the labelled part keeps its shape', () => {
    const box = gridBox(20, 20, 20, 10, 10, 10)
    const flags = new Uint8Array(box.indices.length / 3)
    for (let t = 0; t < flags.length; t++) if ([0, 1, 2].every(k => Math.abs(box.positions[3 * box.indices[3 * t + k]! + 2]! - 20) < 1e-9)) flags[t] = 1
    const lab = assignSegment(box, 'top', flags)
    const r = decimate(lab, { targetTriangles: 100 })
    const top = r.mesh.segments!.labels.reduce((n, l) => n + (l === 1 ? 1 : 0), 0)
    expect(top).toBeGreaterThanOrEqual(2)
    expect(top).toBeLessThan(flags.reduce((a, b) => a + b, 0))
    expect(measureMesh(r.mesh).watertight).toBe(true)
    // the top face triangles are still exactly the ones at z = 20
    for (let t = 0; t < r.mesh.indices.length; t += 3) { const isTop = r.mesh.segments!.labels[t / 3] === 1; const flat = [0, 1, 2].every(k => Math.abs(r.mesh.positions[3 * r.mesh.indices[t + k]! + 2]! - 20) < 1e-9); expect(isTop).toBe(flat) }
  })

  it('max_error stops early', () => {
    const sph = sphereMesh(20, 4)
    const r = decimate(sph, { targetTriangles: 4, maxError: 0.05 })
    expect(r.after).toBeGreaterThan(500)
    expect(r.maxError).toBeLessThanOrEqual(0.05 + 1e-9)
  })

  it('does nothing when the mesh is already small, refuses groups, can be cancelled, and does not change its input', () => {
    const b = boxMesh(1, 1, 1)
    expect(decimate(b, { targetTriangles: 100 }).mesh).toBe(b)
    expect(() => decimate({ ...sphereMesh(5, 2), groups: [{ start: 0, count: 10, role: 'solid' }] }, { targetTriangles: 20 })).toThrowError(expect.objectContaining({ code: 'decimate.groups_unsupported' }))
    const ac = new AbortController(); ac.abort()
    expect(() => decimate(sphereMesh(5, 3), { targetTriangles: 20, signal: ac.signal })).toThrowError(expect.objectContaining({ code: 'run.cancelled' }))
    const s = sphereMesh(5, 3), copy = s.positions.slice(), idx = s.indices.slice()
    decimate(s, { targetTriangles: 100 })
    expect(Array.from(s.positions)).toEqual(Array.from(copy)); expect(Array.from(s.indices)).toEqual(Array.from(idx))
  })

  it('a mesh of bodies: each body is reduced on its own, ranges and closedness are kept, in JavaScript and in WebAssembly', async () => {
    const a = sphereMesh(10, 4), b = sphereMesh(5, 3)
    const n = a.positions.length / 3
    const both: Mesh = {
      positions: Float64Array.from([...a.positions, ...b.positions.map((v, i) => (i % 3 === 0 ? v + 40 : v))]),
      indices: Uint32Array.from([...a.indices, ...Array.from(b.indices, i => i + n)]),
      groups: [{ start: 0, count: a.indices.length / 3, role: 'solid', name: 'big' }, { start: a.indices.length / 3, count: b.indices.length / 3, role: 'solid', name: 'small' }],
    }
    for (const run of [(m: Mesh) => decimateBodies(m, { targetTriangles: 1000 }, (x, o) => decimate(x, o)), (m: Mesh) => decimateWasm(m, { targetTriangles: 1000 })]) {
      const r = await run(both)
      expect(Math.abs(r.after - 1000) / 1000).toBeLessThan(0.05)
      expect(r.mesh.groups!.map(g => g.name)).toEqual(['big', 'small'])
      expect(r.mesh.groups![1]!.start).toBe(r.mesh.groups![0]!.count)
      expect(r.mesh.groups!.reduce((s, g) => s + g.count, 0)).toBe(r.after)
      for (const g of r.mesh.groups!) expect(measureMesh({ positions: r.mesh.positions, indices: r.mesh.indices.slice(3 * g.start, 3 * (g.start + g.count)) }).watertight).toBe(true)
      expect(r.mesh.groups![0]!.count).toBeGreaterThan(r.mesh.groups![1]!.count)     // the target is split by size
    }
  })

  it('works as a step: reports before and after, and a budget-busting mesh fails clearly', async () => {
    const reg = new Registry().register(corePlugin())
    const list = addStep(emptyStepList(), makeStep({ id: 'd', plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op: 'decimate', params: { mode: 'target', target_triangles: 500 } }))
    const r = await runWorkflow(list, { registry: reg, source: sphereMesh(10, 4) })
    expect(r.ok).toBe(true)
    expect(r.results[0]!.report).toMatchObject({ triangles_before: 5120 })
    expect(Math.abs((r.results[0]!.report!['triangles_after'] as number) - 500) / 500).toBeLessThan(0.02)
    await expect(runWorkflow(list, { registry: reg, source: sphereMesh(10, 4), limits: { maxTriangles: 1000 } })).rejects.toMatchObject({ code: 'budget.triangles' })
  })

  it('a 100 000 triangle mesh reduces to 10 000 in a few seconds', () => {
    const big = sphereMesh(30, 6)   // 81 920 triangles
    const t0 = performance.now()
    const r = decimate(big, { targetTriangles: 8000 })
    const ms = performance.now() - t0
    expect(Math.abs(r.after - 8000) / 8000).toBeLessThan(0.02)
    expect(measureMesh(r.mesh).watertight).toBe(true)
    expect(ms).toBeLessThan(process.env['COVERAGE'] ? 600000 : 8000)
  })

  it('by default it reduces as far as the quality allows: a flat plate collapses, a ball keeps its shape', async () => {
    const reg = new Registry().register(corePlugin())
    const run = async (mesh: Mesh, params: Record<string, unknown>) => (await runWorkflow(addStep(emptyStepList(), makeStep({ id: 'd', plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op: 'decimate', params })), { registry: reg, source: mesh })).results[0]!
    const ball = sphereMesh(10, 4)
    const fine = await run(ball, { tolerance: 0.01 })
    const coarse = await run(ball, { tolerance: 0.5 })
    expect(fine.status).toBe('ok'); expect(coarse.status).toBe('ok')
    expect(fine.report).toMatchObject({ mode: 'quality', triangles_before: 5120 })
    expect(fine.report!['triangles_after'] as number).toBeLessThanOrEqual(5120)
    expect(coarse.report!['triangles_after'] as number).toBeLessThan(fine.report!['triangles_after'] as number)   // a bigger tolerance removes more
    expect(coarse.report!['max_error'] as number).toBeLessThanOrEqual(0.5 + 1e-9)    // and no collapse moved the surface further
    expect(measureMesh(coarse.mesh as Mesh).watertight).toBe(true)
    const plate = await run(gridBox(60, 30, 4, 60, 30, 4), {})          // the default quality, flat faces
    expect(plate.report!['triangles_after'] as number).toBeLessThan((plate.report!['triangles_before'] as number) / 10)
    expect(measureMesh(plate.mesh as Mesh).watertight).toBe(true)
  })

  it('a step stored by an older version (a target number, no method) keeps working as a target number', async () => {
    const reg = new Registry().register(corePlugin())
    const old = makeStep({ id: 'd', plugin: { id: CORE_PLUGIN_ID, version: '0.2.0' }, op: 'decimate', params: { target_triangles: 500 } })
    const r = await runWorkflow(addStep(emptyStepList(), old), { registry: reg, source: sphereMesh(10, 4) })
    expect(r.ok).toBe(true)
    expect(Math.abs((r.results[0]!.report!['triangles_after'] as number) - 500) / 500).toBeLessThan(0.02)
    expect(r.results[0]!.report).toMatchObject({ mode: 'target' })
  })
})
