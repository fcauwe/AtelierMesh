import { describe, expect, it } from 'vitest'
import { MeshError, Registry, addStep, emptyStepList, makeStep, measureMesh, meshReport, operationParamsSchema, runFixtures, runWorkflow, validateManifest } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'
import { boxMesh, sphereMesh } from '@ateliermesh/core/testing'
import Ajv from 'ajv/dist/2020'
import { REPAIR_PLUGIN_ID, REPAIR_PLUGIN_VERSION, corePlugin, orderHints, repairFixtures, repairManifest, repairMesh, repairPlugin } from '../src'
import type { RepairOptions } from '../src'
import { CORE_PLUGIN_ID, CORE_PLUGIN_VERSION } from '../src/core-plugin'

const registry = (): Registry => new Registry().register(corePlugin()).register(repairPlugin())
const rp = (params: Record<string, unknown> = {}) => makeStep({ id: 'r', plugin: { id: REPAIR_PLUGIN_ID, version: REPAIR_PLUGIN_VERSION }, op: 'repair_mesh', params })
const run = (mesh: Mesh, params: Record<string, unknown> = {}, signal?: AbortSignal) => runWorkflow(addStep(emptyStepList(), rp(params)), { registry: registry(), source: mesh, ...(signal ? { signal } : {}) })
const report = (r: Awaited<ReturnType<typeof run>>): Record<string, number | boolean | string[] | null> => r.results[0]!.report as Record<string, number | boolean | string[] | null>
const direct = (mesh: Mesh, o: Partial<RepairOptions> = {}) => repairMesh(mesh, { weld: 0.001, nonManifold: 'split', fixNormals: true, minIsland: 1, maxHole: 200, ...o })

/** A closed mesh has no open edge, no edge with three triangles and every edge walked in opposite directions. */
const closed = (m: Mesh): boolean => measureMesh(m).watertight
const usedVertices = (m: Mesh): number => new Set(m.indices).size
const noOpenEdge = (m: Mesh): boolean => !meshReport(m).issues.includes('not_watertight')

const cubeAt = (x: number, y: number, z: number, s = 10, inward = false): Mesh => {
  const b = boxMesh(s, s, s)
  const P = Float64Array.from(b.positions)
  for (let i = 0; i < P.length; i += 3) { P[i] = (P[i] as number) + x; P[i + 1] = (P[i + 1] as number) + y; P[i + 2] = (P[i + 2] as number) + z }
  const idx = Uint32Array.from(b.indices)
  if (inward) for (let t = 0; t < idx.length; t += 3) { const q = idx[t + 1] as number; idx[t + 1] = idx[t + 2] as number; idx[t + 2] = q }
  return { positions: P, indices: idx }
}

/** Several meshes in one, vertices kept apart. */
function join(...ms: Mesh[]): Mesh {
  const pos: number[] = [], idx: number[] = []
  let off = 0
  for (const m of ms) { for (let i = 0; i < m.positions.length; i++) pos.push(m.positions[i] as number); for (const i of m.indices) idx.push(i + off); off += m.positions.length / 3 }
  return { positions: Float64Array.from(pos), indices: Uint32Array.from(idx) }
}
const dropTriangles = (m: Mesh, drop: number[]): Mesh => {
  const keep: number[] = []
  for (let t = 0; t < m.indices.length / 3; t++) if (!drop.includes(t)) keep.push(m.indices[3 * t] as number, m.indices[3 * t + 1] as number, m.indices[3 * t + 2] as number)
  return { positions: m.positions, indices: Uint32Array.from(keep) }
}
/** The same mesh with every triangle on its own three vertices (like an STL soup), each moved by a little noise. */
function soup(m: Mesh, noise: number): Mesh {
  const pos: number[] = []
  let seed = 7
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff - 0.5) * 2 * noise }
  for (const v of m.indices) pos.push((m.positions[3 * v] as number) + rnd(), (m.positions[3 * v + 1] as number) + rnd(), (m.positions[3 * v + 2] as number) + rnd())
  return { positions: Float64Array.from(pos), indices: Uint32Array.from(m.indices.map((_, i) => i)) }
}

/** A closed UV sphere with about nu * (2 * nv - 2) triangles. */
function uvSphere(r: number, nu: number, nv: number): Mesh {
  const pos: number[] = [], idx: number[] = []
  pos.push(0, 0, r)
  for (let j = 1; j < nv; j++) for (let i = 0; i < nu; i++) {
    const th = (Math.PI * j) / nv, ph = (2 * Math.PI * i) / nu
    pos.push(r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th))
  }
  pos.push(0, 0, -r)
  const south = 1 + (nv - 1) * nu, ring = (j: number, i: number): number => 1 + (j - 1) * nu + (i % nu)
  for (let i = 0; i < nu; i++) idx.push(0, ring(1, i), ring(1, i + 1))
  for (let j = 1; j < nv - 1; j++) for (let i = 0; i < nu; i++) idx.push(ring(j, i), ring(j + 1, i), ring(j + 1, i + 1), ring(j, i), ring(j + 1, i + 1), ring(j, i + 1))
  for (let i = 0; i < nu; i++) idx.push(south, ring(nv - 1, i + 1), ring(nv - 1, i))
  return { positions: Float64Array.from(pos), indices: Uint32Array.from(idx) }
}

/** Remove the triangles whose centre lies within `cos` of the direction `axis` seen from the origin: a round hole with a ragged edge. */
function punch(m: Mesh, axis: [number, number, number], cos: number): Mesh {
  const al = Math.hypot(...axis)
  const drop: number[] = []
  for (let t = 0; t < m.indices.length / 3; t++) {
    let x = 0, y = 0, z = 0
    for (let k = 0; k < 3; k++) { const v = m.indices[3 * t + k] as number; x += m.positions[3 * v] as number; y += m.positions[3 * v + 1] as number; z += m.positions[3 * v + 2] as number }
    const l = Math.hypot(x, y, z)
    if ((x * axis[0] + y * axis[1] + z * axis[2]) / (l * al) > cos) drop.push(t)
  }
  return dropTriangles(m, drop)
}

describe('org.ateliermesh.repair', () => {
  it('has a valid manifest and a JSON Schema that agrees with the validator', () => {
    expect(validateManifest(repairManifest).ok).toBe(true)
    const ajv = new Ajv({ strict: false })
    for (const op of repairManifest.operations) {
      const ok = ajv.validate(operationParamsSchema(repairManifest, op), Object.fromEntries(op.params.map(p => [p.name, p.default])))
      expect(ok, op.id).toBe(true)
    }
  })

  it('passes its conformance fixtures', async () => {
    const results = await runFixtures(repairFixtures, { registry: registry() })
    expect(results.filter(r => !r.ok)).toEqual([])
  })

  it('closes a cube with a missing triangle with its exact volume', async () => {
    const r = await run(dropTriangles(cubeAt(0, 0, 0), [11]))
    expect(r.ok).toBe(true)
    expect(closed(r.mesh!)).toBe(true)
    expect(noOpenEdge(r.mesh!)).toBe(true)
    expect(measureMesh(r.mesh!).volume).toBeCloseTo(1000, 6)
    expect(r.mesh!.indices.length / 3).toBe(12)
    expect(report(r)).toMatchObject({ closed: true, holes_before: 1, holes_after: 0, holes_filled: 1, hole_triangles: 1 })
    expect(r.results[0]!.warnings ?? []).toEqual([])
  })

  it('closes a cube with a whole face missing (a four-edge hole) flat and exact', async () => {
    const r = await run(dropTriangles(cubeAt(0, 0, 0), [10, 11]))
    expect(closed(r.mesh!)).toBe(true)
    expect(measureMesh(r.mesh!).volume).toBeCloseTo(1000, 6)
  })

  it('turns flipped triangles round and a cube that is inside out outward', async () => {
    const flipped = cubeAt(0, 0, 0)
    for (const t of [0, 5, 9]) { const q = flipped.indices[3 * t + 1] as number; flipped.indices[3 * t + 1] = flipped.indices[3 * t + 2] as number; flipped.indices[3 * t + 2] = q }
    expect(closed(flipped)).toBe(false)
    const r = await run(flipped)
    expect(closed(r.mesh!)).toBe(true)
    expect(measureMesh(r.mesh!).volume).toBeCloseTo(1000, 6)
    expect(report(r)['flipped_triangles']).toBe(3)
    const inside = await run(cubeAt(0, 0, 0, 10, true))
    expect(measureMesh(inside.mesh!).volume).toBeCloseTo(1000, 6)
    expect(report(inside)['flipped_triangles']).toBe(12)
  })

  it('drops duplicate triangles and a pair that faces both ways', async () => {
    const c = cubeAt(0, 0, 0)
    const idx = Array.from(c.indices)
    // triangle 2 twice (same facing), triangle 3 twice facing opposite ways
    idx.push(...idx.slice(6, 9), ...idx.slice(9, 12), idx[10]!, idx[9]!, idx[11]!)
    const r = await run({ positions: c.positions, indices: Uint32Array.from(idx) }, { max_hole: 0 })
    // triangle 2 has one extra copy; triangle 3 has a copy of each facing, so all three of them go and a hole is left that the hole filler closes
    const r2 = await run({ positions: c.positions, indices: Uint32Array.from(idx) })
    expect(report(r)['dropped_duplicates']).toBe(4)
    expect(closed(r2.mesh!)).toBe(true)
    expect(measureMesh(r2.mesh!).volume).toBeCloseTo(1000, 6)
  })

  it('keeps two cubes and drops a tiny floating fragment (one or two triangles), under the default island size', async () => {
    const two = join(cubeAt(0, 0, 0), cubeAt(30, 0, 0))
    const withBit = join(two, { positions: Float64Array.from([100, 100, 100, 100.5, 100, 100, 100, 100.5, 100, 100.5, 100.5, 100]), indices: Uint32Array.from([0, 1, 2, 1, 3, 2]) })
    const r = await run(withBit)
    expect(r.ok).toBe(true)
    expect(closed(r.mesh!)).toBe(true)
    expect(r.mesh!.indices.length / 3).toBe(24)
    expect(measureMesh(r.mesh!).volume).toBeCloseTo(2000, 6)
    expect(report(r)).toMatchObject({ islands_removed: 1, island_triangles: 2, shells_before: 3, shells_after: 2 })
    // 0 keeps every shell
    const keepAll = await run(withBit, { min_island: 0 })
    expect(report(keepAll)['islands_removed']).toBe(0)
  })

  it('min_island is a share of the largest shell: a small closed part stays under the default and goes above 40 percent', async () => {
    const tetra: Mesh = { positions: Float64Array.from([50, 0, 0, 55, 0, 0, 50, 5, 0, 50, 0, 5]), indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]) }
    const both = join(cubeAt(0, 0, 0), tetra)
    expect(closed(both.positions.length ? both : both)).toBe(true)
    const kept = await run(both)
    expect(report(kept)['islands_removed']).toBe(0)
    const gone = await run(both, { min_island: 40 })
    expect(report(gone)['islands_removed']).toBe(1)
    expect(measureMesh(gone.mesh!).triangles).toBe(12)
  })

  it('welds vertices that were split apart by 1e-5 (a triangle soup with noise)', async () => {
    const s = soup(cubeAt(0, 0, 0), 1e-5)
    expect(s.positions.length / 3).toBe(36)
    const r = await run(s)
    expect(closed(r.mesh!)).toBe(true)
    expect(r.mesh!.positions.length / 3).toBe(8)
    expect(r.mesh!.indices.length / 3).toBe(12)
    expect(measureMesh(r.mesh!).volume).toBeCloseTo(1000, 3)
    expect(report(r)['welded_vertices']).toBe(28)
    // weld 0 leaves them apart: the cube stays in pieces
    const off = await run(s, { weld: 0, max_hole: 0 })
    expect(closed(off.mesh!)).toBe(false)
  })

  it('removes a non-manifold fin on an edge of the cube', async () => {
    const c = cubeAt(0, 0, 0)
    // the bottom face is split along the diagonal 0-2; a fin hangs below it from that edge
    const fin: Mesh = { positions: Float64Array.from([...c.positions, 0, 0, -9]), indices: Uint32Array.from([...c.indices, 0, 2, 8]) }
    expect(measureMesh(fin).nonManifoldEdges).toBe(1)
    for (const mode of ['split', 'remove']) {
      const r = await run(fin, { non_manifold: mode })
      expect(closed(r.mesh!), mode).toBe(true)
      expect(r.mesh!.indices.length / 3, mode).toBe(12)
      expect(measureMesh(r.mesh!).volume, mode).toBeCloseTo(1000, 6)
      expect(report(r)['non_manifold_fixed'], mode).toBe(1)
    }
    // switched off, the fin stays
    const off = await run(fin, { non_manifold: 'off' })
    expect(measureMesh(off.mesh!).nonManifoldEdges).toBe(1)
  })

  it('closes a sphere with a ragged round hole; the patch is curved, not a flat lid, and the volume stays within 3 percent', async () => {
    const sph = sphereMesh(10, 4)
    const full = measureMesh(sph).volume
    // everything above a wavy line goes: a hole whose edge climbs and falls by a millimetre, so it is not planar
    const drop: number[] = []
    for (let t = 0; t < sph.indices.length / 3; t++) {
      let x = 0, y = 0, z = 0
      for (let k = 0; k < 3; k++) { const v = sph.indices[3 * t + k] as number; x += (sph.positions[3 * v] as number) / 3; y += (sph.positions[3 * v + 1] as number) / 3; z += (sph.positions[3 * v + 2] as number) / 3 }
      if (z > 8.5 + Math.cos(2 * Math.atan2(y, x))) drop.push(t)
    }
    const holey = dropTriangles(sph, drop)
    expect(noOpenEdge(holey)).toBe(false)
    const r = await run(holey)
    expect(r.ok).toBe(true)
    expect(closed(r.mesh!)).toBe(true)
    const after = measureMesh(r.mesh!)
    expect(Math.abs(after.volume - full) / full).toBeLessThan(0.03)
    const rep = report(r)
    expect(rep['holes_filled']).toBe(1)
    // the ragged edge is not planar, so the cap was refined: new vertices inside the hole
    expect(rep['vertices_after'] as number).toBeGreaterThan(usedVertices(holey))
    expect(after.bbox.max[2]).toBeGreaterThan(9.5)
  })

  it('closes a hole whose edge is planar with a flat cap and no new vertices', async () => {
    // every triangle above z = 8 goes: the edge of the hole is the ring of vertices at one latitude, so it is planar
    const sph = uvSphere(10, 48, 24)
    const drop: number[] = []
    for (let t = 0; t < sph.indices.length / 3; t++) if ([0, 1, 2].every(k => (sph.positions[3 * (sph.indices[3 * t + k] as number) + 2] as number) >= 8)) drop.push(t)
    const holey = dropTriangles(sph, drop)
    const r = await run(holey)
    expect(closed(r.mesh!)).toBe(true)
    const rep = report(r)
    expect(rep['holes_filled']).toBe(1)
    expect(rep['vertices_after']).toBe(usedVertices(holey))
    expect(rep['hole_triangles']).toBe(46)
  })

  it('reports a hole that is too big as a warning, returns the mesh, and says it is still open', async () => {
    const r = await run(dropTriangles(cubeAt(0, 0, 0), [10, 11]), { max_hole: 3 })
    expect(r.ok).toBe(true)
    const codes = (r.results[0]!.warnings ?? []).map(w => w.code)
    expect(codes).toContain('repair.hole_too_big')
    expect(codes).toContain('repair.still_open')
    expect(closed(r.mesh!)).toBe(false)
    expect(report(r)).toMatchObject({ closed: false, holes_after: 1, holes_too_big: 1 })
    const big = (r.results[0]!.warnings ?? []).find(w => w.code === 'repair.hole_too_big')!
    expect(big.params).toMatchObject({ count: 1, largest: 4, max: 3 })
  })

  it('leaves a hole open, with a warning, when its cap would cross itself', async () => {
    // a cone whose base loop is a bow-tie seen from above (the edges 0-1 and 2-3 cross): no flat cap can close it
    const cone: Mesh = {
      positions: Float64Array.from([0, 0, 0, 10, 10, 0, 10, 0, 0, 0, 6, 0, 5, 3, 6]),
      indices: Uint32Array.from([0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4]),
    }
    const r = await run(cone)
    expect(r.ok).toBe(true)
    const codes = (r.results[0]!.warnings ?? []).map(w => w.code)
    expect(codes).toEqual(['repair.hole_skipped', 'repair.still_open'])
    expect(r.results[0]!.warnings![0]!.params).toMatchObject({ count: 1 })
    expect(report(r)).toMatchObject({ closed: false, holes_after: 1, holes_filled: 0 })
  })

  it('keeps groups as valid ranges, never joins two bodies, and keeps the order and roles', async () => {
    const a = dropTriangles(cubeAt(0, 0, 0), [3]), b = cubeAt(0, 0, 0, 10)
    const m = join(a, b)
    // both cubes share the same place: they would weld into each other if the bodies were not repaired one at a time
    m.groups = [{ start: 0, count: 11, role: 'solid', name: 'outer' }, { start: 11, count: 12, role: 'negative', name: 'cut' }]
    const r = repairMesh(m, { weld: 0.001, nonManifold: 'split', fixNormals: true, minIsland: 1, maxHole: 200 })
    expect(r.mesh.groups).toEqual([{ start: 0, count: 12, role: 'solid', name: 'outer' }, { start: 12, count: 12, role: 'negative', name: 'cut' }])
    expect(r.mesh.indices.length / 3).toBe(24)
    expect(closed(r.mesh)).toBe(true)
    expect(r.after.shells).toBe(2)
  })

  it('keeps the orientation of a negative body and does not point it outward', () => {
    const m = join(cubeAt(0, 0, 0, 20), cubeAt(0, 0, 5, 10, true))
    m.groups = [{ start: 0, count: 12, role: 'solid' }, { start: 12, count: 12, role: 'negative' }]
    const r = direct(m)
    expect(r.did.flipped).toBe(0)
    expect(r.unchanged).toBe(true)
  })

  it('keeps a cavity: an inner shell that points inward stays inward', () => {
    const m = join(cubeAt(0, 0, 0, 20), cubeAt(0, 0, 5, 10, true))
    const r = direct(m)
    expect(r.did.flipped).toBe(0)
    expect(measureMesh(r.mesh).volume).toBeCloseTo(8000 - 1000, 6)
  })

  it('keeps triangles\' segment labels and gives a filled hole the label of its neighbours', () => {
    const c = dropTriangles(cubeAt(0, 0, 0), [11])
    const labels = new Uint16Array(11).fill(1)
    labels[0] = 0
    const m: Mesh = { ...c, segments: { labels, table: [{ id: 0, name: 'body' }, { id: 1, name: 'letters' }] } }
    const r = direct(m)
    expect(r.mesh.indices.length / 3).toBe(12)
    expect(r.mesh.segments!.labels.length).toBe(12)
    // the hole is in a face that borders nine triangles labelled 1 and one labelled 0 (or less): the cap takes 1
    expect(r.mesh.segments!.labels[11]).toBe(1)
    expect(r.mesh.segments!.table.map(s => s.name)).toEqual(['body', 'letters'])
  })

  it('returns a closed, valid mesh unchanged (the same object) and says so', async () => {
    const c = cubeAt(0, 0, 0)
    const r = direct(c)
    expect(r.unchanged).toBe(true)
    expect(r.mesh).toBe(c)
    const w = await run(c)
    expect(report(w)).toMatchObject({ unchanged: true, closed: true, did: [] })
  })

  it('is deterministic: the same input gives the same bytes', async () => {
    const holey = punch(sphereMesh(10, 4), [0.3, 0.2, 1], 0.9)
    const a = await run(holey), b = await run(holey)
    expect(Array.from(a.mesh!.positions)).toEqual(Array.from(b.mesh!.positions))
    expect(Array.from(a.mesh!.indices)).toEqual(Array.from(b.mesh!.indices))
  })

  it('refuses unusable input with a structured error', async () => {
    const empty = await run({ positions: new Float64Array(0), indices: new Uint32Array(0) })
    expect(empty.ok).toBe(false)
    expect(empty.results[0]!.error).toMatchObject({ code: 'repair.bad_input', params: { reason: 'no_triangles' } })
    const nan = await run({ positions: Float64Array.from([0, 0, NaN, 1, 0, 0, 0, 1, 0]), indices: Uint32Array.from([0, 1, 2]) })
    expect(nan.results[0]!.error).toMatchObject({ code: 'repair.bad_input', params: { reason: 'not_finite' } })
    const badIdx = await run({ positions: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: Uint32Array.from([0, 1, 7]) })
    expect(badIdx.results[0]!.error).toMatchObject({ code: 'repair.bad_input', params: { reason: 'index_out_of_range' } })
    const overlap: Mesh = { ...cubeAt(0, 0, 0), groups: [{ start: 0, count: 8, role: 'solid' }, { start: 6, count: 6, role: 'solid' }] }
    const o = await run(overlap)
    expect(o.results[0]!.error).toMatchObject({ code: 'repair.groups_unsupported' })
  })

  it('stops when it is cancelled', async () => {
    const ac = new AbortController(); ac.abort()
    const r = await run(dropTriangles(cubeAt(0, 0, 0), [11]), {}, ac.signal)
    expect(r.ok).toBe(false)
    expect(r.results[0]!.error?.code).toBe('run.cancelled')
    void MeshError
  })

  it('repair belongs at the top of the list', () => {
    const l = ['a', 'b'].reduce((acc, id) => addStep(acc, makeStep({ id, plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op: id === 'a' ? 'resize' : 'emboss' })), emptyStepList())
    const l2 = addStep(l, rp())
    const hints = orderHints(l2)
    expect(hints.find(h => h.code === 'repair_first')).toMatchObject({ step: 'r', fix: { id: 'r', to: 0 } })
    expect(orderHints(addStep(emptyStepList(), rp()))).toEqual([])
  })

  it('repairs random damage on a sphere: lost, turned and doubled triangles, with noise on the vertices', () => {
    const base = sphereMesh(10, 4)
    const full = measureMesh(base).volume
    for (const seed of [1, 2, 3, 4, 5]) {
      let st = seed * 7919
      const rnd = (): number => { st = (st * 1103515245 + 12345) & 0x7fffffff; return st / 0x7fffffff }
      const nt = base.indices.length / 3
      const idx: number[] = []
      for (let t = 0; t < nt; t++) {
        const a = base.indices[3 * t] as number, b = base.indices[3 * t + 1] as number, c = base.indices[3 * t + 2] as number
        const roll = rnd()
        if (roll < 0.002) continue // lost
        if (roll < 0.004) { idx.push(a, c, b); continue } // turned
        idx.push(a, b, c)
        if (roll > 0.998) idx.push(a, b, c) // doubled
      }
      const damaged = soup({ positions: base.positions, indices: Uint32Array.from(idx) }, 1e-6)
      const r = direct(damaged)
      expect(closed(r.mesh), `seed ${seed}`).toBe(true)
      expect(Math.abs(measureMesh(r.mesh).volume - full) / full, `seed ${seed}`).toBeLessThan(0.01)
    }
  })

  it('repairs 200 000 triangles with several defects in a few seconds', () => {
    const sph = uvSphere(50, 500, 201) // 500 * 400 = 200 000 triangles
    expect(sph.indices.length / 3).toBe(200000)
    // three holes, a dozen flipped triangles and a sliver of dust
    let m = punch(sph, [1, 0, 0], 0.999)
    m = punch(m, [0, 1, 0], 0.999)
    m = punch(m, [-1, 0, 0], 0.999)
    const idx = Uint32Array.from(m.indices)
    for (let t = 1000; t < 1012; t++) { const q = idx[3 * t + 1] as number; idx[3 * t + 1] = idx[3 * t + 2] as number; idx[3 * t + 2] = q }
    const dust = join({ positions: m.positions, indices: idx }, { positions: Float64Array.from([200, 0, 0, 201, 0, 0, 200, 1, 0]), indices: Uint32Array.from([0, 1, 2]) })
    const t0 = performance.now()
    const r = direct(dust)
    const ms = performance.now() - t0
    console.log(`repair 200k triangles: ${Math.round(ms)} ms, ${r.did.holesFilled} holes, ${r.did.flipped} flipped, ${r.did.islandsRemoved} island(s)`)
    expect(closed(r.mesh)).toBe(true)
    expect(r.did).toMatchObject({ holesFilled: 3, islandsRemoved: 1 })
    expect(r.did.flipped).toBe(12)
    expect(Math.abs(measureMesh(r.mesh).volume - (4 / 3) * Math.PI * 50 ** 3) / ((4 / 3) * Math.PI * 50 ** 3)).toBeLessThan(0.02)
    expect(ms).toBeLessThan(20000)
  }, 60000)
})
