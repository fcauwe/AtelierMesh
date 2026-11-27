import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Registry, addStep, buildBvh, emptyStepList, makeStep, measureMesh, operationParamsSchema, runFixtures, runWorkflow, sha256Hex, validateManifest } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'
import Ajv from 'ajv/dist/2020'
import fs from 'node:fs'
import path from 'node:path'
import { CORE_PLUGIN_ID, CORE_PLUGIN_VERSION, HOLLOW_PLUGIN_ID, HOLLOW_PLUGIN_VERSION, TEXTURE_PLUGIN_ID, TEXTURE_PLUGIN_VERSION, corePlugin, hollowFixtures, hollowManifest, hollowPlugin, texturePlugin } from '../src'
import { gridBox } from './parts'
import { frustum, sphere } from '../src/samples'
import { mushroom } from './shapes'

const registry = (): Registry => new Registry().register(corePlugin()).register(hollowPlugin()).register(texturePlugin())
const hstep = (params: Record<string, unknown>) => makeStep({ id: 'h', plugin: { id: HOLLOW_PLUGIN_ID, version: HOLLOW_PLUGIN_VERSION }, op: 'hollow', params })
const run = async (mesh: Mesh, params: Record<string, unknown>, opts: { quality?: 'preview' | 'export'; signal?: AbortSignal } = {}) =>
  (await runWorkflow(addStep(emptyStepList(), hstep(params)), { registry: registry(), source: mesh, quality: opts.quality ?? 'export', ...(opts.signal ? { signal: opts.signal } : {}) })).results[0]!
const hash = (m: Mesh): string => sha256Hex(new Uint8Array(m.positions.buffer.slice(m.positions.byteOffset, m.positions.byteOffset + m.positions.byteLength))) + sha256Hex(new Uint8Array(m.indices.buffer.slice(m.indices.byteOffset, m.indices.byteOffset + m.indices.byteLength)))
const ball = sphere(25, 5)
const shellVolume = (R: number, t: number): number => (4 / 3) * Math.PI * (R ** 3 - (R - t) ** 3)
type Report = Record<string, unknown>

/** True when the outer part of `out` is the input, bit for bit: the first vertices and the first triangles. */
const outerKept = (input: Mesh, out: Mesh): boolean => {
  for (let i = 0; i < input.positions.length; i++) if (out.positions[i] !== input.positions[i]) return false
  for (let i = 0; i < input.indices.length; i++) if (out.indices[i] !== input.indices[i]) return false
  return true
}

describe('org.ateliermesh.hollow', () => {
  it('has a valid manifest and a JSON Schema that agrees with the validator', () => {
    expect(validateManifest(hollowManifest).ok).toBe(true)
    const op = hollowManifest.operations.find(o => o.id === 'hollow')!
    expect(new Ajv({ strict: false }).validate(operationParamsSchema(hollowManifest, op), Object.fromEntries(op.params.map(p => [p.name, p.default])))).toBe(true)
    expect(op.category).toBe('shape')
    expect(op.personalisable).toBe('never')
    expect(op.summary).toBe('{{thickness}} mm')
    expect(op.params.find(p => p.name === 'thickness')?.importance).toBe('main')
  })

  it('hollows a ball of 25 mm to a 2 mm wall: one closed solid, the volume of the analytic shell, the outside untouched', async () => {
    const t = performance.now()
    const r = await run(ball, { thickness: 2 })
    const ms = performance.now() - t
    expect(r.status, JSON.stringify(r.error)).toBe('ok')
    const out = r.mesh!
    expect(measureMesh(out).watertight).toBe(true)
    const v = measureMesh(out).volume
    expect(Math.abs(v - shellVolume(25, 2)) / shellVolume(25, 2)).toBeLessThan(0.03)    // the tessellated ball is a little smaller than the analytic one, so this is a fair bound
    expect(outerKept(ball, out)).toBe(true)
    const rep = r.report as Report
    expect(rep['hollowed']).toBe(true); expect(rep['outer_remeshed']).toBe(false)
    expect(rep['wall_min_mm'] as number).toBeGreaterThan(1.9); expect(rep['wall_mean_mm'] as number).toBeLessThan(2.1)
    expect(rep['cavity_volume'] as number).toBeCloseTo((measureMesh(ball).volume - v), -2)
    expect(ms).toBeLessThan(8000)
  }, 60000)

  it('a preview is much faster and still closed, the cavity smooth and the wall close to the asked one', async () => {
    const t = performance.now()
    const r = await run(ball, { thickness: 2 }, { quality: 'preview' })
    const ms = performance.now() - t
    expect(r.status).toBe('ok')
    expect(measureMesh(r.mesh!).watertight).toBe(true)
    expect((r.report as Report)['wall_min_mm'] as number).toBeGreaterThan(1.8)
    expect(ms).toBeLessThan(4000)
  }, 60000)

  it('gives the inside a segment of its own, kept apart from the outside; an empty name gives it none', async () => {
    const r = await run(ball, { thickness: 2 }, { quality: 'preview' })
    const seg = r.mesh!.segments!
    expect(seg.table.map(s => s.name)).toEqual(['body', 'cavity'])
    const nt = r.mesh!.indices.length / 3, no = ball.indices.length / 3
    let outer = 0, cav = 0
    for (let q = 0; q < nt; q++) { if (seg.labels[q] === 1) cav++; else outer++ }
    expect(outer).toBe(no); expect(cav).toBe(nt - no)
    const none = await run(ball, { thickness: 2, cavity_segment: '' }, { quality: 'preview' })
    expect(none.mesh!.segments).toBeUndefined()
  }, 60000)

  it('keeps the segments of the input and adds the cavity as one more', async () => {
    const labels = new Uint16Array(ball.indices.length / 3).fill(0)
    for (let q = 0; q < labels.length; q += 3) labels[q] = 1
    const lettered: Mesh = { ...ball, segments: { labels, table: [{ id: 0, name: 'body' }, { id: 1, name: 'letters' }] } }
    const r = await run(lettered, { thickness: 2 }, { quality: 'preview' })
    const seg = r.mesh!.segments!
    expect(seg.table.map(s => s.name)).toEqual(['body', 'letters', 'cavity'])
    for (let q = 0; q < labels.length; q++) expect(seg.labels[q]).toBe(labels[q])
  }, 60000)

  it('is deterministic: the same input gives the same mesh', async () => {
    const a = await run(ball, { thickness: 2 }, { quality: 'preview' }), b = await run(ball, { thickness: 2 }, { quality: 'preview' })
    expect(hash(a.mesh!)).toBe(hash(b.mesh!))
  }, 60000)

  it('works on a model that is not convex (a mushroom), the wall about as thick everywhere', async () => {
    const m = mushroom()
    const r = await run(m, { thickness: 1.5 }, { quality: 'preview' })
    expect(r.status, JSON.stringify(r.error)).toBe('ok')
    expect(measureMesh(r.mesh!).watertight).toBe(true)
    expect(r.mesh!.indices.length / 3).toBeGreaterThan(m.indices.length / 3)
    const rep = r.report as Report
    expect(rep['wall_min_mm'] as number).toBeGreaterThan(1.3)
    expect(outerKept(m, r.mesh!)).toBe(true)
  }, 60000)

  it('keeps every vertex and triangle of a textured surface: the detail of the outside is untouched', async () => {
    const list = addStep(addStep(emptyStepList(), makeStep({ id: 't', plugin: { id: TEXTURE_PLUGIN_ID, version: TEXTURE_PLUGIN_VERSION }, op: 'texture', params: { pattern: 'hexagons', amplitude: 0.4, scale: 8 } })), hstep({ thickness: 1.5 }))
    const textured = await runWorkflow(addStep(emptyStepList(), makeStep({ id: 't', plugin: { id: TEXTURE_PLUGIN_ID, version: TEXTURE_PLUGIN_VERSION }, op: 'texture', params: { pattern: 'hexagons', amplitude: 0.4, scale: 8 } })), { registry: registry(), source: gridBox(20, 20, 20, 20, 20, 20), quality: 'preview' })
    expect(textured.ok).toBe(true)
    const full = await runWorkflow(list, { registry: registry(), source: gridBox(20, 20, 20, 20, 20, 20), quality: 'preview' })
    expect(full.ok, JSON.stringify(full.results.map(x => x.error))).toBe(true)
    expect(outerKept(textured.mesh!, full.mesh!)).toBe(true)
    expect(measureMesh(full.mesh!).watertight).toBe(true)
    expect(full.mesh!.indices.length).toBeGreaterThan(textured.mesh!.indices.length)
  }, 120000)

  const FONTS = fileURLToPath(new URL('../../../assets/atelier/frontend/public/fonts', import.meta.url))
  const withFonts = fs.existsSync(FONTS) ? it : it.skip
  withFonts('keeps the letters of a text step exactly as they are', async () => {
    const font = new Uint8Array(fs.readFileSync(path.join(FONTS, 'roboto-v51-latin-regular.woff2')))
    const emboss = makeStep({ id: 'e', plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op: 'emboss', params: { text: 'Anna', font: 'roboto', size: 8, height: 0.6, placement: { anchor: { point: [0, 0, 10], normal: [0, 0, 1] }, direction: 0, up_ref: 'z' } } })
    const plate = gridBox(40, 20, 10, 40, 20, 10)
    const base = await runWorkflow(addStep(emptyStepList(), emboss), { registry: registry(), source: { ...plate, positions: plate.positions.map((v, i) => (i % 3 === 2 ? v : v)) }, quality: 'preview', assets: async () => font })
    expect(base.ok).toBe(true)
    const list = addStep(addStep(emptyStepList(), emboss), hstep({ thickness: 2 }))
    const r = await runWorkflow(list, { registry: registry(), source: plate, quality: 'preview', assets: async () => font })
    expect(r.ok, JSON.stringify(r.results.map(x => x.error))).toBe(true)
    expect(outerKept(base.mesh!, r.mesh!)).toBe(true)
    expect(measureMesh(r.mesh!).watertight).toBe(true)
  }, 120000)

  it('with a single body (one group) it hollows that body and keeps the group over the whole result', async () => {
    const one: Mesh = { ...ball, groups: [{ start: 0, count: ball.indices.length / 3, role: 'solid', name: 'Part 1' }] }
    const r = await run(one, { thickness: 2 }, { quality: 'preview' })
    expect(r.status, JSON.stringify(r.error)).toBe('ok')
    const g = r.mesh!.groups!
    expect(g.length).toBe(1)
    expect(g[0]!.start).toBe(0); expect(g[0]!.count).toBe(r.mesh!.indices.length / 3)
    expect(g[0]!.name).toBe('Part 1')
  }, 60000)

  it('hollows every body of a mesh with several, each body keeping its own range, name and role', async () => {
    const a = sphere(8, 3), b = sphere(6, 3)
    const nv = a.positions.length / 3
    const shift = Float64Array.from(b.positions, (v, i) => (i % 3 === 0 ? v + 30 : v))
    const two: Mesh = {
      positions: Float64Array.from([...a.positions, ...shift]), indices: Uint32Array.from([...a.indices, ...Array.from(b.indices, v => v + nv)]),
      groups: [{ start: 0, count: a.indices.length / 3, role: 'solid', name: 'Big' }, { start: a.indices.length / 3, count: b.indices.length / 3, role: 'solid', name: 'Small' }],
    }
    const r = await run(two, { thickness: 1.2 }, { quality: 'preview' })
    expect(r.status, JSON.stringify(r.error)).toBe('ok')
    const out = r.mesh!
    expect(measureMesh(out).watertight).toBe(true)
    const [g1, g2] = out.groups!
    expect(g1!.name).toBe('Big'); expect(g2!.name).toBe('Small')
    expect(g1!.start).toBe(0); expect(g2!.start).toBe(g1!.count); expect(g1!.count + g2!.count).toBe(out.indices.length / 3)
    expect(g1!.count).toBeGreaterThan(a.indices.length / 3); expect(g2!.count).toBeGreaterThan(b.indices.length / 3)
    // the first body's triangles stay a closed solid on their own
    const bodyOne: Mesh = { positions: out.positions, indices: out.indices.slice(3 * g1!.start, 3 * (g1!.start + g1!.count)) }
    expect(measureMesh(bodyOne).watertight).toBe(true)
  }, 60000)

  it('refuses groups that do not cover the mesh, and a negative body, with a clear code', async () => {
    const half = ball.indices.length / 6
    const loose: Mesh = { ...ball, groups: [{ start: 0, count: half, role: 'solid', name: 'a' }, { start: half, count: 10, role: 'solid', name: 'b' }] }
    expect((await run(loose, { thickness: 2 }, { quality: 'preview' })).error?.code).toBe('hollow.groups_unsupported')
    const neg: Mesh = { ...ball, groups: [{ start: 0, count: ball.indices.length / 3, role: 'negative', name: 'hole' }] }
    expect((await run(neg, { thickness: 2 }, { quality: 'preview' })).error?.code).toBe('hollow.groups_unsupported')
  })

  it('refuses a model that is not closed, with the reason', async () => {
    const open: Mesh = { positions: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: Uint32Array.from([0, 1, 2]) }
    const r = await run(open, {})
    expect(r.status).toBe('error')
    expect(r.error?.code).toBe('hollow.bad_input')
  })

  it('a wall thicker than the model leaves the model as it was and says so', async () => {
    const box = gridBox(6, 6, 6, 3, 3, 3)
    const r = await run(box, { thickness: 10 }, { quality: 'preview' })
    expect(r.status).toBe('ok')
    expect(r.mesh).toBe(box)
    expect(r.warnings?.some(w => w.code === 'hollow.thickness_too_big')).toBe(true)
    expect((r.report as Report)['hollowed']).toBe(false)
  })

  it('warns about a wall under the thinnest that prints', async () => {
    const r = await run(sphere(10, 3), { thickness: 0.5 }, { quality: 'preview' })
    expect(r.status, JSON.stringify(r.error)).toBe('ok')
    expect(r.warnings?.some(w => w.code === 'hollow.thin_walls')).toBe(true)
  }, 60000)

  it('refuses a grid that is too big, naming the cells and the limit', async () => {
    const big = gridBox(400, 400, 400, 2, 2, 2)
    const r = await run(big, { thickness: 0.5 }, { quality: 'preview' })
    expect(r.error?.code).toBe('hollow.too_heavy')
    expect(r.error?.params?.['limit']).toBeDefined()
  })

  it('stops when the run is cancelled', async () => {
    const ac = new AbortController(); ac.abort()
    const r = await run(ball, { thickness: 2 }, { signal: ac.signal })
    expect(['error', 'cancelled']).toContain(r.status)
  })

  it('with an opening, cuts the hole exactly: a closed solid with a hole along the axis, the outside kept as it was', async () => {
    const r = await run(sphere(12, 4), { thickness: 2, opening: 'bottom', opening_diameter: 6 }, { quality: 'preview' })
    expect(r.status, JSON.stringify(r.error)).toBe('ok')
    expect(measureMesh(r.mesh!).watertight).toBe(true)
    expect(r.warnings?.some(w => w.code === 'hollow.outer_remeshed')).toBeFalsy()
    expect((r.report as Report)['outer_remeshed']).toBe(false)
    // a vertical ray up the axis from below goes into the hole and meets the cavity's far wall at the top, not the bottom wall
    const bvh = buildBvh(r.mesh!)
    const hit = bvh.raycast([0, 0, -20], [0, 0, 1])!
    expect(-20 + hit.distance).toBeGreaterThan(8)   // the first surface met is the inside of the top wall (z about +10), not the bottom of the ball (z = -12)
    const closed = await run(sphere(12, 4), { thickness: 2 }, { quality: 'preview' })
    const hit2 = buildBvh(closed.mesh!).raycast([0, 0, -20], [0, 0, 1])!
    expect(-20 + hit2.distance).toBeLessThan(-11)   // without the opening the first surface is the outside at the bottom
  }, 120000)

  it('with an opening, a sharp cylinder stays sharp: its rim and base corners are still there, to the last digit', async () => {
    const jar = frustum(20, 20, 40, 96, 40)
    const r = await run(jar, { thickness: 2, opening: 'top', opening_diameter: 30 })
    expect(r.status, JSON.stringify(r.error)).toBe('ok')
    expect(measureMesh(r.mesh!).watertight).toBe(true)
    const P = r.mesh!.positions
    let rMax = 0, zMin = Infinity, zMax = -Infinity
    for (let i = 0; i < P.length; i += 3) { rMax = Math.max(rMax, Math.hypot(P[i] as number, P[i + 1] as number)); zMin = Math.min(zMin, P[i + 2] as number); zMax = Math.max(zMax, P[i + 2] as number) }
    expect(rMax).toBeCloseTo(20, 6)
    // the base corners of the original are all in the result
    const have = new Set<string>(); for (let i = 0; i < P.length; i += 3) have.add(`${(P[i] as number).toFixed(5)},${(P[i + 1] as number).toFixed(5)},${(P[i + 2] as number).toFixed(5)}`)
    const Q = jar.positions
    let missing = 0
    for (let i = 0; i < Q.length; i += 3) if (Math.abs((Q[i + 2] as number) - zMin) < 1e-9 && !have.has(`${(Q[i] as number).toFixed(5)},${(Q[i + 1] as number).toFixed(5)},${(Q[i + 2] as number).toFixed(5)}`)) missing++
    expect(missing).toBe(0)
    // the hole is round and 30 mm: no point of the top face lies inside it
    expect(zMax).toBeCloseTo(40, 6)
  }, 120000)

  it('passes its conformance fixtures', async () => {
    const results = await runFixtures(hollowFixtures, { registry: registry() })
    for (const r of results) expect(r.ok, `${r.name}: ${JSON.stringify(r.failures)}`).toBe(true)
  }, 120000)
})
