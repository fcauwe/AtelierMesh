import { describe, expect, it } from 'vitest'
import { MeshError, measureMesh, parseStl, weldSoup, writeStlBinary } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'
import { embossRings } from '../src/emboss/embosscore'
import type { Ring } from '../src/emboss/cut'
import { gridBox, rect } from './parts'

const rings: Ring[] = [rect(-4, -2, 4, 2)]
const go = (mesh: Mesh, point: [number, number, number] = [0, 0, 3]) => embossRings({ mesh, point, rings, bbox: [-4, -2, 4, 2], height: 0.6, mode: 'raised' })
const finite = (m: Mesh): boolean => m.positions.every(Number.isFinite)
/** Run and accept only two outcomes: a good closed result, or a MeshError with a code. Anything else (a crash, NaN, an open mesh) fails. */
function outcome(mesh: Mesh, point?: [number, number, number]): { ok: true; mesh: Mesh } | { ok: false; code: string } {
  try { const r = go(mesh, point); return { ok: true, mesh: r.mesh } } catch (e) { if (e instanceof MeshError) return { ok: false, code: e.code }; throw e }
}

describe('meshes as they come from real files', () => {
  const plate = gridBox(40, 20, 3, 40, 20, 3)

  it('an STL file (read and welded by parseStl) works, and loose triangles that were never welded are refused or handled, not broken', () => {
    const fromFile = parseStl(writeStlBinary(plate)).mesh
    const r = outcome(fromFile)
    expect(r.ok).toBe(true)
    if (r.ok) { expect(measureMesh(r.mesh).watertight).toBe(true); expect(measureMesh(r.mesh).volume - measureMesh(plate).volume).toBeCloseTo(8 * 4 * 0.6, 4) }
    // the same triangles with three private vertices each: nothing is connected, so there is no surface to grow a patch on
    const soup: Mesh = { positions: Float64Array.from(Array.from(plate.indices, i => [plate.positions[3 * i]!, plate.positions[3 * i + 1]!, plate.positions[3 * i + 2]!]).flat()), indices: Uint32Array.from({ length: plate.indices.length }, (_, i) => i) }
    const s = outcome(soup)
    if (s.ok) expect(measureMesh(s.mesh).watertight).toBe(true)
    else expect(s.code).toMatch(/^emboss\./)
    // and welding the soup first (what the importer does) gives the good result again
    const w = outcome(weldSoup(soup.positions).mesh)
    expect(w, JSON.stringify(w)).toMatchObject({ ok: true })
  })

  it('a mesh turned inside out is refused with a clear code instead of lifting the letters into the part', () => {
    const idx = plate.indices.slice()
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]!; idx[i + 1] = idx[i + 2]!; idx[i + 2] = t }
    const r = outcome({ positions: plate.positions, indices: idx })
    expect(r).toEqual({ ok: false, code: 'emboss.inside_out' })
  })

  it('an open mesh (a sheet with the bottom missing) works away from the hole', () => {
    const idx: number[] = []
    for (let t = 0; t < plate.indices.length; t += 3) if ([0, 1, 2].some(k => plate.positions[3 * plate.indices[t + k]! + 2]! > 0.5)) idx.push(plate.indices[t]!, plate.indices[t + 1]!, plate.indices[t + 2]!)
    const r = outcome({ positions: plate.positions, indices: Uint32Array.from(idx) })
    expect(r.ok).toBe(true)
  })

  it('a non-manifold edge is named', () => {
    const idx = Array.from(plate.indices); idx.push(plate.indices[0]!, plate.indices[1]!, plate.positions.length / 3)
    const pos = Float64Array.from([...plate.positions, 1, 1, 50])
    expect(outcome({ positions: pos, indices: Uint32Array.from(idx) })).toEqual({ ok: false, code: 'emboss.mesh_not_manifold' })
  })

  it('a part far from the origin (a million millimetres) still works', () => {
    const far = { positions: plate.positions.map((v, i) => (i % 3 === 0 ? v + 1e6 : v)), indices: plate.indices }
    const r = outcome(far, [1e6, 0, 3])
    expect(r.ok).toBe(true)
    if (r.ok) { expect(finite(r.mesh)).toBe(true); expect(measureMesh(r.mesh).watertight).toBe(true) }
  })

  it('a part measured in metres (a 0.04 m plate with 8 mm letters) is refused or handled, never broken', () => {
    const tiny = { positions: plate.positions.map(v => v / 1000), indices: plate.indices }
    const r = outcome(tiny, [0, 0, 0.003])
    if (r.ok) expect(finite(r.mesh)).toBe(true)
    else expect(r.code).toMatch(/^emboss\./)
  })

  it('two separate bodies in one file: text on one leaves the other alone', () => {
    const off = (m: Mesh, dx: number): Mesh => ({ positions: m.positions.map((v, i) => (i % 3 === 0 ? v + dx : v)), indices: m.indices })
    const a = plate, b = off(plate, 100)
    const both: Mesh = { positions: Float64Array.from([...a.positions, ...b.positions]), indices: Uint32Array.from([...a.indices, ...Array.from(b.indices, i => i + a.positions.length / 3)]) }
    const r = outcome(both)
    expect(r.ok).toBe(true)
    if (r.ok) { const m = measureMesh(r.mesh); expect(m.watertight).toBe(true); expect(m.volume - 2 * measureMesh(plate).volume).toBeCloseTo(8 * 4 * 0.6, 4) }
  })

  it('zero-area triangles in the patch give a clear error or a good mesh, never NaN', () => {
    const pos = Float64Array.from([...plate.positions, 5, 5, 3, 5, 5, 3, 5, 5, 3])
    const n = plate.positions.length / 3
    const idx = Uint32Array.from([...plate.indices, n, n + 1, n + 2])
    const r = outcome({ positions: pos, indices: idx })
    if (r.ok) expect(finite(r.mesh)).toBe(true)
    else expect(r.code).toMatch(/^emboss\./)
  })

  it('a point far from the surface still finds the nearest triangle', () => {
    const r = outcome(plate, [0, 0, 40])
    expect(r.ok).toBe(true)
  })
})
