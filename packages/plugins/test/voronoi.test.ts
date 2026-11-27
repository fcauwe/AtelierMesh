import { describe, expect, it } from 'vitest'
import { Registry, addStep, emptyStepList, makeStep, measureMesh, operationParamsSchema, runFixtures, runWorkflow, segmentTable, sha256Hex, validateManifest } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'
import Ajv from 'ajv/dist/2020'
import { VORONOI_MAX_CELLS, VORONOI_MAX_VERTICES, VORONOI_PLUGIN_ID, VORONOI_PLUGIN_VERSION, corePlugin, voronoiCells, voronoiFixtures, voronoiManifest, voronoiPattern, voronoiPlugin, voronoiRng, regionPolygon } from '../src'
import type { VoronoiPatternOptions } from '../src'
import { frustum, gridBox } from './parts'

const registry = (): Registry => new Registry().register(corePlugin()).register(voronoiPlugin())
const plate = gridBox(70, 30, 4, 140, 60, 8)
const placementTop = { anchor: { point: [0, 0, 4], normal: [0, 0, 1] } }
const vo = (params: Record<string, unknown>, placement: unknown = placementTop) => makeStep({ id: 'v', plugin: { id: VORONOI_PLUGIN_ID, version: VORONOI_PLUGIN_VERSION }, op: 'voronoi', params: { placement, ...params } })
const run = async (params: Record<string, unknown>, mesh: Mesh = plate, placement: unknown = placementTop, limits?: { maxTriangles: number }, signal?: AbortSignal) =>
  (await runWorkflow(addStep(emptyStepList(), vo(params, placement)), { registry: registry(), source: mesh, ...(limits ? { limits } : {}), ...(signal ? { signal } : {}) })).results[0]!
const hash = (m: Mesh): string => sha256Hex(new Uint8Array(m.positions.buffer.slice(m.positions.byteOffset, m.positions.byteOffset + m.positions.byteLength))) + sha256Hex(new Uint8Array(m.indices.buffer.slice(m.indices.byteOffset, m.indices.byteOffset + m.indices.byteLength)))
const base: VoronoiPatternOptions = { region: 'rectangle', width: 40, height: 30, radius: 20, margin: 1, cells: 40, seed: 1, irregularity: 0.6, lineWidth: 1.2, fill: false, rounding: 0, tolerance: 0.03 }

const polyArea = (p: Array<[number, number]>): number => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i]!, r = p[(i + 1) % p.length]!; a += q[0] * r[1] - r[0] * q[1] } return a / 2 }
/** Smallest distance from a point to a polygon's edges. */
const distToPoly = (pt: [number, number], poly: Array<[number, number]>): number => {
  let best = Infinity
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / l2))
    best = Math.min(best, Math.hypot(pt[0] - a[0] - t * dx, pt[1] - a[1] - t * dy))
  }
  return best
}

describe('org.ateliermesh.voronoi', () => {
  it('has a valid manifest and a JSON Schema that agrees with the validator', () => {
    expect(validateManifest(voronoiManifest).ok).toBe(true)
    const ajv = new Ajv({ strict: false })
    for (const op of voronoiManifest.operations) {
      const ok = ajv.validate(operationParamsSchema(voronoiManifest, op), Object.fromEntries(op.params.map(p => [p.name, p.default])))
      expect(ok, op.id).toBe(true)
    }
  })

  it('passes its conformance fixtures', async () => {
    const results = await runFixtures(voronoiFixtures, { registry: registry() })
    expect(results.filter(r => !r.ok)).toEqual([])
  })
})

describe('the pattern', () => {
  it('the cells partition the region', () => {
    const region = regionPolygon(base)
    const rand = voronoiRng(5)
    const seeds = Array.from({ length: 60 }, () => [(rand() - 0.5) * 38, (rand() - 0.5) * 28] as [number, number])
    const cells = voronoiCells(seeds, region)
    expect(cells.length).toBe(60)
    expect(cells.reduce((s, c) => s + Math.abs(polyArea(c)), 0)).toBeCloseTo(Math.abs(polyArea(region)), 6)
    seeds.forEach((s, i) => { expect(distToPoly(s, cells[i]!)).toBeGreaterThanOrEqual(0) })
  })

  it('is deterministic for a seed, and a different seed gives a different pattern', () => {
    const a = voronoiPattern(base), b = voronoiPattern({ ...base }), c = voronoiPattern({ ...base, seed: 2 })
    expect(JSON.stringify(a.rings)).toBe(JSON.stringify(b.rings))
    expect(JSON.stringify(a.rings)).not.toBe(JSON.stringify(c.rings))
    expect(voronoiRng(7)()).toBe(voronoiRng(7)())
  })

  it('irregularity 0 gives even cells, 1 gives uneven ones', () => {
    const spread = (irr: number): number => {
      const p = voronoiPattern({ ...base, cells: 50, irregularity: irr, fill: true, lineWidth: 0.2 })
      const areas = p.rings.map(r => Math.abs(polyArea(r as Array<[number, number]>)))
      const mean = areas.reduce((s, a) => s + a, 0) / areas.length
      return Math.sqrt(areas.reduce((s, a) => s + (a - mean) ** 2, 0) / areas.length) / mean
    }
    expect(spread(0)).toBeLessThan(0.2)
    expect(spread(0)).toBeLessThan(spread(1))
  })

  it('leaves a gap of one line width between neighbouring cells, and the lines are about that wide', () => {
    const lw = 1.5
    const pads = voronoiPattern({ ...base, cells: 30, lineWidth: lw, fill: true, irregularity: 0.3 })
    // the smallest distance between two different pads is the gap: exactly one line width
    let gap = Infinity
    pads.rings.forEach((r, i) => pads.rings.forEach((o, j) => { if (i !== j) for (const p of r) gap = Math.min(gap, distToPoly(p as [number, number], o as Array<[number, number]>)) }))
    expect(gap).toBeGreaterThan(lw - 2e-3)
    expect(gap).toBeLessThan(lw + 2e-3)
    const lines = voronoiPattern({ ...base, cells: 30, lineWidth: lw, irregularity: 0.3 })
    expect(lines.meanStroke).toBeGreaterThan(lw * 0.85)
    expect(lines.meanStroke).toBeLessThan(lw * 1.35)
    // the pattern stays inside the area, minus the margin
    expect(lines.bbox[0]).toBeGreaterThanOrEqual(-19 - 1e-6); expect(lines.bbox[2]).toBeLessThanOrEqual(19 + 1e-6)
    expect(lines.bbox[1]).toBeGreaterThanOrEqual(-14 - 1e-6); expect(lines.bbox[3]).toBeLessThanOrEqual(14 + 1e-6)
  })

  it('rounding softens the corners (more points, smaller pads)', () => {
    const sharp = voronoiPattern({ ...base, fill: true }), round = voronoiPattern({ ...base, fill: true, rounding: 1 })
    expect(round.vertices).toBeGreaterThan(sharp.vertices)
    const area = (p: typeof sharp): number => p.rings.reduce((s, r) => s + Math.abs(polyArea(r as Array<[number, number]>)), 0)
    expect(area(round)).toBeLessThan(area(sharp))
  })

  it('a circular area stays inside its circle', () => {
    const p = voronoiPattern({ ...base, region: 'circle', radius: 10, margin: 0.5, fill: true })
    for (const r of p.rings) for (const [x, y] of r) expect(Math.hypot(x, y)).toBeLessThanOrEqual(9.5 + 1e-3)
  })

  it('refuses what cannot be made, with a code that says why', () => {
    const code = (o: Partial<VoronoiPatternOptions>): string => { try { voronoiPattern({ ...base, ...o }); return 'ok' } catch (e) { return (e as { code: string }).code } }
    expect(code({ cells: VORONOI_MAX_CELLS + 1 })).toBe('voronoi.too_many_cells')
    expect(code({ cells: 2000, width: 20, height: 20 })).toBe('voronoi.cells_too_small')
    expect(code({ width: 1.5, margin: 1 })).toBe('voronoi.empty_pattern')
    expect(code({ cells: 2000, width: 400, height: 400, lineWidth: 0.2, rounding: 2, fill: true, tolerance: 0.004 })).toBe('voronoi.too_heavy')
    expect(VORONOI_MAX_VERTICES).toBeGreaterThan(1000)
  })

  it('stops when it is cancelled', () => {
    const ac = new AbortController(); ac.abort()
    expect(() => voronoiPattern({ ...base, irregularity: 0, signal: ac.signal })).toThrow(/run.cancelled|cancel/i)
  })
})

describe('on a surface', () => {
  const vol = (m: Mesh): number => measureMesh(m).volume
  it('raised lines add material, engraved lines remove it, flat changes nothing, and every result is a closed solid', async () => {
    const v0 = vol(plate)
    const raised = await run({ mode: 'raised', height: 0.8 }), engraved = await run({ mode: 'engraved', height: 0.6 }), flat = await run({ mode: 'flat' })
    for (const [name, r] of [['raised', raised], ['engraved', engraved], ['flat', flat]] as const) {
      expect(r.status, `${name}: ${JSON.stringify(r.error)}`).toBe('ok')
      expect(measureMesh(r.mesh!).watertight, name).toBe(true)
    }
    expect(vol(raised.mesh!)).toBeGreaterThan(v0 + 100)
    expect(vol(engraved.mesh!)).toBeLessThan(v0 - 100)
    expect(vol(flat.mesh!)).toBeCloseTo(v0, 6)
    expect(raised.report!['cells']).toBe(40)
  })

  it('flat mode keeps the geometry: nothing is lifted and there is no wall part', async () => {
    const r = await run({ mode: 'flat' })
    const m = r.mesh!
    for (let i = 2; i < m.positions.length; i += 3) expect(m.positions[i]!).toBeLessThanOrEqual(4 + 1e-9)
    expect(segmentTable(m).map(s => s.name)).toEqual(['body', 'voronoi'])
  })

  it('raised mode has two parts: the top and the walls', async () => {
    const r = await run({ mode: 'raised' })
    expect(segmentTable(r.mesh!).map(s => s.name)).toEqual(['body', 'voronoi', 'voronoi_walls'])
    const one = await run({ mode: 'raised', walls_segment: '' })
    expect(segmentTable(one.mesh!).map(s => s.name)).toEqual(['body', 'voronoi'])
  })

  it('works on a cylinder (a curved surface) and stays a closed solid', async () => {
    const cyl = frustum(20, 20, 40, 96, 16)
    const r = await run({ width: 30, height_area: 20, cells: 40 }, cyl, { anchor: { point: [20, 0, 20], normal: [1, 0, 0] } })
    expect(r.status, JSON.stringify(r.error)).toBe('ok')
    expect(measureMesh(r.mesh!).watertight).toBe(true)
    expect(measureMesh(r.mesh!).volume).toBeGreaterThan(measureMesh(cyl).volume)
  })

  it('the same seed gives the same model, another seed another one', async () => {
    const a = await run({ seed: 4 }), b = await run({ seed: 4 }), c = await run({ seed: 5 })
    expect(hash(a.mesh!)).toBe(hash(b.mesh!))
    expect(hash(a.mesh!)).not.toBe(hash(c.mesh!))
  })

  it('says so when the area does not fit the surface, and when the pattern is too heavy for the triangle budget', async () => {
    const tooBig = await run({ width: 100, height_area: 100 })
    expect(tooBig.error?.code).toBe('voronoi.does_not_fit')
    const heavy = await run({ cells: 300, width: 60, height_area: 25, line_width: 0.8 }, plate, placementTop, { maxTriangles: 60000 })
    expect(heavy.error?.code).toBe('budget.triangles')
  })

  it('too many cells for the area is a clear error through the engine', async () => {
    const r = await run({ width: 10, height_area: 10, cells: 2000 })
    expect(r.error?.code).toBe('voronoi.cells_too_small')
    expect(r.error?.params).toMatchObject({ line_width: 1.2 })
  })

  it('warns when the lines are thinner than the printer lays down', async () => {
    const r = await run({ line_width: 0.4, cells: 20 })
    expect(r.status).toBe('ok')
    expect(r.warnings?.map(w => w.code)).toContain('voronoi.thin_lines')
    expect(r.warnings?.find(w => w.code === 'voronoi.thin_lines')?.params).toMatchObject({ min: 0.6, min_line: 0.6 })
  })

  it('a placement is needed', async () => {
    const r = await run({}, plate, null)
    expect(r.error?.code).toBe('voronoi.no_placement')
  })
})
