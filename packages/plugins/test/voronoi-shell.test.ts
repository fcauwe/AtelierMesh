import { describe, expect, it } from 'vitest'
import { Registry, addStep, buildBvh, emptyStepList, makeStep, measureMesh, operationParamsSchema, runFixtures, runWorkflow, sha256Hex, validateManifest } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'
import Ajv from 'ajv/dist/2020'
import { VORONOI_PLUGIN_ID, VORONOI_PLUGIN_VERSION, corePlugin, voronoiFixtures, voronoiManifest, voronoiPlugin } from '../src'
import { frustum, sphere } from '../src/samples'
import { MeshDistance } from '../src/voronoi/sdf'
import { voronoiShell } from '../src/voronoi/shell'
import { refineSurface } from '../src/implicit/iso'
import { mushroom } from './shapes'

const registry = (): Registry => new Registry().register(corePlugin()).register(voronoiPlugin())
const step = (params: Record<string, unknown>) => makeStep({ id: 'vs', plugin: { id: VORONOI_PLUGIN_ID, version: VORONOI_PLUGIN_VERSION }, op: 'voronoi_shell', params })
const run = async (mesh: Mesh, params: Record<string, unknown>, opts: { quality?: 'preview' | 'export'; signal?: AbortSignal } = {}) =>
  (await runWorkflow(addStep(emptyStepList(), step(params)), { registry: registry(), source: mesh, quality: opts.quality ?? 'export', ...(opts.signal ? { signal: opts.signal } : {}) })).results[0]!
const hash = (m: Mesh): string => sha256Hex(new Uint8Array(m.positions.buffer.slice(m.positions.byteOffset, m.positions.byteOffset + m.positions.byteLength))) + sha256Hex(new Uint8Array(m.indices.buffer.slice(m.indices.byteOffset, m.indices.byteOffset + m.indices.byteLength)))
const R = 12
const ball = sphere(R, 4)
const fast = { thickness: 1.5, rib_width: 1.5, cells: 20, seed: 2, detail: 'coarse' }

/** True when the point is inside the mesh (a ray along +x, counting crossings with the BVH one by one). */
const inside = (bvh: ReturnType<typeof buildBvh>, p: [number, number, number]): boolean => {
  let n = 0, o: [number, number, number] = [p[0], p[1], p[2]]
  for (let i = 0; i < 200; i++) {
    const h = bvh.raycast(o, [1, 0.0001, 0.0002])
    if (!h) break
    n++; o = [o[0] + h.distance * 1.0000001 + 1e-6, o[1] + h.distance * 0.0001, o[2] + h.distance * 0.0002]
  }
  return n % 2 === 1
}

describe('org.ateliermesh.voronoi: voronoi_shell', () => {
  it('has a valid manifest and a JSON Schema that agrees with the validator', () => {
    expect(validateManifest(voronoiManifest).ok).toBe(true)
    const ajv = new Ajv({ strict: false })
    const op = voronoiManifest.operations.find(o => o.id === 'voronoi_shell')!
    expect(ajv.validate(operationParamsSchema(voronoiManifest, op), Object.fromEntries(op.params.map(p => [p.name, p.default])))).toBe(true)
    expect(op.category).toBe('style')
    expect(op.personalisable).toBe('optional')
    expect(op.params.filter(p => p.personalisable).map(p => p.name).sort()).toEqual(['cells', 'seed'])
  })

  describe('the signed distance', () => {
    const d = MeshDistance.create(sphere(10, 4))!
    it('is the distance to the surface, negative inside', () => {
      expect(d.signed(0, 0, 0)).toBeCloseTo(-10, 0)
      expect(d.signed(14, 0, 0)).toBeCloseTo(4, 0)
      expect(d.signed(0, 0, 7)).toBeCloseTo(-3, 0)
      expect(d.signed(3, 4, 5)).toBeLessThan(0)
      expect(d.signed(30, 30, 30)).toBeGreaterThan(0)
    })
    it('refuses a mesh that is not closed', () => {
      expect(MeshDistance.create({ positions: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: Uint32Array.from([0, 1, 2]) })).toBeNull()
    })
  })

  it('the outer face of the struts lies on the model itself: a sharp-edged cylinder is not rounded by the grid', async () => {
    const cyl = frustum(14, 14, 30, 96, 30)
    const r = await run(cyl, { thickness: 2, rib_width: 2, cells: 40, seed: 3, detail: 'auto' })
    expect(r.status, JSON.stringify(r.error)).toBe('ok')
    expect(measureMesh(r.mesh!).watertight).toBe(true)
    const P = r.mesh!.positions
    let rMax = 0, zMax = -Infinity, onFace = 0
    for (let i = 0; i < P.length; i += 3) {
      const rr = Math.hypot(P[i] as number, P[i + 1] as number), z = P[i + 2] as number
      if (rr > rMax) rMax = rr; if (z > zMax) zMax = z
      if (rr > 13.9 || Math.abs(z - 30) < 1e-6 || Math.abs(z) < 1e-6) onFace++
    }
    expect(rMax).toBeLessThanOrEqual(14.0001)
    expect(zMax).toBeCloseTo(30, 4)
    expect(onFace).toBeGreaterThan(P.length / 3 * 0.1)
  }, 120000)

  for (const ctxQuality of ['export', 'preview'] as const) it(`the struts are smooth at ${ctxQuality} quality: no ridge of slivers or saw-tooth along the edges of a frustum shell`, async () => {
    const cone = frustum(14, 20, 50, 96, 40)
    const r = await run(cone, { thickness: 2, rib_width: 2, cells: 70, seed: 3, opening: 'top', opening_diameter: 26 }, { quality: ctxQuality })
    expect(r.status, JSON.stringify(r.error)).toBe('ok')
    const m = r.mesh!
    expect(measureMesh(m).watertight).toBe(true)
    const P = m.positions, I = m.indices, nt = I.length / 3
    const N = new Float64Array(nt * 3)
    let minQ = 1
    for (let t = 0; t < nt; t++) {
      const a = 3 * (I[3 * t] as number), b = 3 * (I[3 * t + 1] as number), c = 3 * (I[3 * t + 2] as number)
      const ux = (P[b] as number) - (P[a] as number), uy = (P[b + 1] as number) - (P[a + 1] as number), uz = (P[b + 2] as number) - (P[a + 2] as number)
      const vx = (P[c] as number) - (P[a] as number), vy = (P[c + 1] as number) - (P[a + 1] as number), vz = (P[c + 2] as number) - (P[a + 2] as number)
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz)
      const e = ux * ux + uy * uy + uz * uz + vx * vx + vy * vy + vz * vz + ((P[c] as number) - (P[b] as number)) ** 2 + ((P[c + 1] as number) - (P[b + 1] as number)) ** 2 + ((P[c + 2] as number) - (P[b + 2] as number)) ** 2
      minQ = Math.min(minQ, (2 * Math.sqrt(3) * l) / e)
      N[3 * t] = nx / l; N[3 * t + 1] = ny / l; N[3 * t + 2] = nz / l
    }
    const seen = new Map<string, number>()
    let edges = 0, sharp = 0
    for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
      const a = I[3 * t + k] as number, b = I[3 * t + ((k + 1) % 3)] as number, key = a < b ? `${a}_${b}` : `${b}_${a}`
      const o = seen.get(key)
      if (o === undefined) { seen.set(key, t); continue }
      edges++
      if ((N[3 * t] as number) * (N[3 * o] as number) + (N[3 * t + 1] as number) * (N[3 * o + 1] as number) + (N[3 * t + 2] as number) * (N[3 * o + 2] as number) < 0.5) sharp++ // dihedral above 60 degrees
    }
    // pulling every vertex near the surface onto it gave 3.7 % sharp edges and slivers down to 0.0008; the lattice itself has about 0.4 %
    expect(sharp / edges).toBeLessThan(0.01)
    expect(minQ).toBeGreaterThan(0.01)
  }, 180000)

  it('refineSurface splits a coarse mesh down onto the exact field, keeping it closed and the same every time', () => {
    const R = 5
    const coarse = sphere(R, 1)
    const f = (x: number, y: number, z: number): number => Math.hypot(x, y, z) - R
    const opts = { f, minEdge: 0.3, tol: 0.02, maxStep: 0.5, maxTriangles: 200000, rounds: 3, relax: 1 }
    const a = refineSurface(Float64Array.from(coarse.positions), Uint32Array.from(coarse.indices), opts)
    const b = refineSurface(Float64Array.from(coarse.positions), Uint32Array.from(coarse.indices), opts)
    expect(a.indices.length).toBeGreaterThan(coarse.indices.length * 4)
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions))
    expect(measureMesh({ positions: a.positions, indices: a.indices }).watertight).toBe(true)
    let worst = 0
    for (let i = 0; i < a.positions.length; i += 3) worst = Math.max(worst, Math.abs(Math.hypot(a.positions[i] as number, a.positions[i + 1] as number, a.positions[i + 2] as number) - R))
    expect(worst).toBeLessThan(0.02)
    const capped = refineSurface(Float64Array.from(coarse.positions), Uint32Array.from(coarse.indices), { ...opts, maxTriangles: coarse.indices.length / 3 + 100 })
    expect(capped.indices.length / 3).toBeLessThanOrEqual(coarse.indices.length / 3 + 220)
  })

  it('rounded beams (beam_rounding 1) have a rounder cross-section and stay closed', async () => {
    const cyl = frustum(14, 14, 30, 96, 30)
    const base = { thickness: 2, rib_width: 2, cells: 25, seed: 3, smooth: 0 }
    const square = await run(cyl, { ...base, beam_rounding: 0 })
    const round = await run(cyl, { ...base, beam_rounding: 1 })
    expect(square.status, JSON.stringify(square.error)).toBe('ok')
    expect(round.status, JSON.stringify(round.error)).toBe('ok')
    expect(measureMesh(round.mesh!).watertight).toBe(true)
    const vs = measureMesh(square.mesh!).volume, vr = measureMesh(round.mesh!).volume
    // a square strut section loses 1 - pi/4 (21 %) when it is fully round; the joints keep some material, so a little less
    expect(vr / vs).toBeGreaterThan(0.7)
    expect(vr / vs).toBeLessThan(0.9)
  }, 240000)

  it('turns a sphere into one closed lattice with a fraction of the volume', async () => {
    const r = await run(ball, fast)
    expect(r.status, JSON.stringify(r.error)).toBe('ok')
    const m = measureMesh(r.mesh!)
    expect(m.watertight).toBe(true)
    const solid = measureMesh(ball).volume
    expect(m.volume).toBeGreaterThan(0.02 * solid)
    expect(m.volume).toBeLessThan(0.2 * solid)
    expect((r.report as { closed: boolean }).closed).toBe(true)
  })

  it('keeps the wall between the surface and `thickness` below it, and the openings through it', async () => {
    const r = await run(ball, fast)
    const bvh = buildBvh(r.mesh!)
    // random points: every point of the result is within `thickness` of the original surface, and the lattice is open where there is no strut
    const d = MeshDistance.create(ball)!
    let n = 0, solidPoints = 0, deep = 0, throughOpenings = 0
    let a = 12345
    const rnd = (): number => { a = (Math.imul(a, 1664525) + 1013904223) | 0; return (a >>> 0) / 4294967296 }
    for (let i = 0; i < 6000; i++) {
      const p: [number, number, number] = [(rnd() * 2 - 1) * R, (rnd() * 2 - 1) * R, (rnd() * 2 - 1) * R]
      const depth = -d.signed(p[0], p[1], p[2])
      n++
      if (inside(bvh, p)) { solidPoints++; if (depth > 1.5 + 0.4 || depth < -0.4) deep++ }
      else if (depth > 0 && depth < 1.5) throughOpenings++
    }
    expect(n).toBe(6000)
    expect(solidPoints).toBeGreaterThan(5)
    expect(deep).toBe(0)                       // nothing solid deeper than the wall (a little over, for the rounding)
    expect(throughOpenings).toBeGreaterThan(solidPoints)   // inside the wall layer there is more opening than strut
  })

  it('makes a thinner wall with a smaller thickness and a lighter shell with fewer struts', async () => {
    const a = measureMesh((await run(ball, { ...fast, thickness: 1.2 })).mesh!).volume
    const b = measureMesh((await run(ball, { ...fast, thickness: 2.4 })).mesh!).volume
    expect(b).toBeGreaterThan(a * 1.5)
    const c = measureMesh((await run(ball, { ...fast, rib_width: 1 })).mesh!).volume
    const d = measureMesh((await run(ball, { ...fast, rib_width: 2.2 })).mesh!).volume
    expect(d).toBeGreaterThan(c * 1.5)
  })

  it('is deterministic by seed: the same seed gives the same hash, another seed another lattice', async () => {
    const a = await run(ball, fast), b = await run(ball, fast), c = await run(ball, { ...fast, seed: 3 })
    expect(hash(a.mesh!)).toBe(hash(b.mesh!))
    expect(hash(c.mesh!)).not.toBe(hash(a.mesh!))
    expect(measureMesh(c.mesh!).watertight).toBe(true)
  })

  it('the preview uses a coarser grid than the export, and both are closed', async () => {
    const p = await run(ball, fast, { quality: 'preview' }), e = await run(ball, fast, { quality: 'export' })
    expect((p.report as { voxel_mm: number }).voxel_mm).toBeCloseTo(1.4 * (e.report as { voxel_mm: number }).voxel_mm, 5)
    expect(measureMesh(p.mesh!).watertight).toBe(true)
    expect(measureMesh(e.mesh!).watertight).toBe(true)
  })

  it('works on a non-convex part (a mushroom) and keeps it closed', async () => {
    const r = await run(mushroom(48), { thickness: 1.5, rib_width: 1.5, cells: 30, seed: 1, detail: 'coarse' })
    expect(r.status, JSON.stringify(r.error)).toBe('ok')
    expect(measureMesh(r.mesh!).watertight).toBe(true)
    expect(measureMesh(r.mesh!).volume).toBeLessThan(measureMesh(mushroom(48)).volume * 0.5)
  })

  it('an opening at the bottom leaves nothing near the axis in the lower half, and a collar round its edge', async () => {
    const lowNear = (m: Mesh, radius: number): number => { let n = 0; for (let i = 0; i < m.positions.length; i += 3) if (m.positions[i + 2]! < -1 && Math.hypot(m.positions[i]!, m.positions[i + 1]!) < radius) n++; return n }
    const collar = (m: Mesh): number => { let n = 0; for (let i = 0; i < m.positions.length; i += 3) { const r = Math.hypot(m.positions[i]!, m.positions[i + 1]!); if (m.positions[i + 2]! < -1 && r > 4.2 && r < 5.2) n++ } return n }
    const open = (await run(ball, { ...fast, opening: 'bottom', opening_diameter: 8 })).mesh!
    expect(measureMesh(open).watertight).toBe(true)
    expect(lowNear(open, 3.8)).toBe(0)
    expect(collar(open)).toBeGreaterThan(50)
    // without the opening, some seed has a strut or the wall across the axis at the bottom
    let shutNear = 0
    for (const seed of [2, 3, 4, 5]) shutNear += lowNear((await run(ball, { ...fast, seed, opening: 'none' })).mesh!, 3.8)
    expect(shutNear).toBeGreaterThan(0)
    // an opening at the top does the same up there
    const top = (await run(ball, { ...fast, opening: 'top', opening_diameter: 8 })).mesh!
    let up = 0
    for (let i = 0; i < top.positions.length; i += 3) if (top.positions[i + 2]! > 1 && Math.hypot(top.positions[i]!, top.positions[i + 1]!) < 3.8) up++
    expect(up).toBe(0)
  })

  it('on a 25 mm sphere with the default settings the volume agrees with a count of points to within 5 %', async () => {
    const big = sphere(25, 4)
    const r = await run(big, {})
    expect(r.status, JSON.stringify(r.error)).toBe('ok')
    expect(measureMesh(r.mesh!).watertight).toBe(true)
    const bvh = buildBvh(r.mesh!)
    const layer = (4 / 3) * Math.PI * (25 ** 3 - 23 ** 3)
    let a = 987654321, inLayer = 0, hit = 0
    const rnd = (): number => { a = (Math.imul(a, 1664525) + 1013904223) | 0; return (a >>> 0) / 4294967296 }
    while (inLayer < 12000) {
      const p: [number, number, number] = [(rnd() * 2 - 1) * 25, (rnd() * 2 - 1) * 25, (rnd() * 2 - 1) * 25]
      const rr = Math.hypot(p[0], p[1], p[2])
      if (rr > 25 || rr < 23) continue
      inLayer++
      if (inside(bvh, p)) hit++
    }
    const sampled = (hit / inLayer) * layer
    const volume = measureMesh(r.mesh!).volume
    expect(Math.abs(volume - sampled) / sampled).toBeLessThan(0.05)
    // the lattice covers a quarter to a half of the wall for 60 cells of 2 mm struts
    expect(hit / inLayer).toBeGreaterThan(0.15)
    expect(hit / inLayer).toBeLessThan(0.55)
  }, 120000)

  it('"extra fine" cuts the surface finer than "fine" (more triangles, still a closed solid)', async () => {
    const small = sphere(8, 3)
    const base = { thickness: 2, rib_width: 2, cells: 10, seed: 3 }
    const fine = await run(small, { ...base, detail: 'fine' })
    const extra = await run(small, { ...base, detail: 'extra_fine' })
    expect(fine.status).toBe('ok'); expect(extra.status).toBe('ok')
    expect(extra.mesh!.indices.length).toBeGreaterThan(fine.mesh!.indices.length * 1.4)
    expect(measureMesh(extra.mesh!).watertight).toBe(true)
  })

  it('refuses a model that is not closed, with the reason', async () => {
    const open: Mesh = { positions: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: Uint32Array.from([0, 1, 2]) }
    const r = await run(open, {})
    expect(r.status).toBe('error')
    expect(r.error?.code).toBe('voronoi_shell.bad_input')
  })

  it('refuses a model with several bodies', async () => {
    const two: Mesh = { ...ball, groups: [{ start: 0, count: ball.indices.length / 6, role: 'solid', name: 'a' }, { start: ball.indices.length / 6, count: ball.indices.length / 6, role: 'solid', name: 'b' }] }
    const r = await run(two, fast)
    expect(r.error?.code).toBe('voronoi_shell.groups_unsupported')
  })

  it('a model with a single body (one group) is one body: it is hollowed, not refused', async () => {
    const one: Mesh = { ...ball, groups: [{ start: 0, count: ball.indices.length / 3, role: 'solid', name: 'Part 1' }] }
    const r = await run(one, fast)
    expect(r.error).toBeUndefined()
    expect(r.status).toBe('ok')
  })

  it('refuses more openings than the surface has room for, and says how many fit', async () => {
    const r = await run(sphere(10, 3), { cells: 1500, rib_width: 5 })
    expect(r.error?.code).toBe('voronoi_shell.cells_too_small')
    expect((r.error?.params as { max_cells: number }).max_cells).toBeLessThan(1500)
  })

  it('refuses a grid that would be too big, with a way out', async () => {
    const r = await run(sphere(200, 3), { thickness: 0.4, rib_width: 0.6 })
    expect(r.error?.code).toBe('voronoi_shell.too_heavy')
  })

  it('warns when the wall is thicker than the model is deep', async () => {
    const r = await run(sphere(5, 3), { thickness: 12, rib_width: 1.5, cells: 8, detail: 'coarse' })
    expect(r.status, JSON.stringify(r.error)).toBe('ok')
    expect(r.warnings?.some(w => w.code === 'voronoi_shell.thickness_too_big')).toBe(true)
  })

  it('warns when the struts are thinner than a printer lays down', async () => {
    const r = await run(ball, { ...fast, rib_width: 0.7 })
    expect(r.warnings?.some(w => w.code === 'voronoi_shell.thin_ribs')).toBe(true)
  })

  it('stops when the run is cancelled', async () => {
    const ac = new AbortController(); ac.abort()
    const r = await run(ball, fast, { signal: ac.signal })
    expect(['error', 'cancelled']).toContain(r.status)
  })

  it('reduces the triangles to the limit', async () => {
    const r = await run(ball, { ...fast, max_triangles: 8000 })
    expect(r.status, JSON.stringify(r.error)).toBe('ok')
    expect(r.mesh!.indices.length / 3).toBeLessThanOrEqual(8200)
    expect((r.report as { decimated: boolean }).decimated).toBe(true)
  })

  it('reports what it did', async () => {
    const r = await run(ball, fast)
    const rep = r.report as Record<string, unknown>
    for (const k of ['voxel_mm', 'grid', 'cells', 'triangles', 'volume_before', 'volume_after', 'max_depth_mm', 'timing_ms']) expect(rep[k], k).toBeDefined()
  })

  it('passes its conformance fixtures', async () => {
    const results = await runFixtures(voronoiFixtures.filter(f => f.name.startsWith('voronoi shell')), { registry: registry() })
    for (const r of results) expect(r.ok, `${r.name}: ${JSON.stringify(r.failures)}`).toBe(true)
  }, 120000)

  it('the field function runs on its own', () => {
    const r = voronoiShell(ball, { thickness: 1.5, cells: 12, seed: 1, irregularity: 0.5, ribWidth: 1.5, smooth: 0.4, opening: 'none', openingDiameter: 10, voxel: 1.2 })
    expect(r.rawTriangles).toBeGreaterThan(1000)
    expect(r.grid[0]).toBeGreaterThan(10)
  })
})
