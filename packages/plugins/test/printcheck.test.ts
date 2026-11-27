import { describe, expect, it } from 'vitest'
import { Registry, addStep, emptyStepList, makeStep, measureMesh, operationParamsSchema, runFixtures, runWorkflow, validateManifest } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'
import { boxMesh } from '@ateliermesh/core/testing'
import Ajv from 'ajv/dist/2020'
import { describeProblem } from '@ateliermesh/ui'
import { CORE_PLUGIN_ID, CORE_PLUGIN_VERSION, PRINTCHECK_PLUGIN_ID, PRINTCHECK_PLUGIN_VERSION, corePlugin, orderHints, printCheck, printcheckFixtures, printcheckManifest, printcheckPlugin } from '../src'
import type { PrintCheckOptions, PrintCheckResult } from '../src'
import { frustum, sphere } from '../src/samples'
import { tBeam } from './shapes'

const registry = (): Registry => new Registry().register(corePlugin()).register(printcheckPlugin())
const base: PrintCheckOptions = { process: 'fdm', nozzle: 0.4, layerHeight: 0.2, minWall: 0, minFeature: 0, minGap: 0, overhangAngle: 45, bridgeLength: 10, bed: [220, 220, 250], quality: 'export' }
const check = (m: Mesh, o: Partial<PrintCheckOptions> = {}): PrintCheckResult => printCheck(m, { ...base, ...o })
const find = (r: PrintCheckResult, name: string) => r.findings.find(f => f.name === name)!
const step = (params: Record<string, unknown> = {}) => makeStep({ id: 'p', plugin: { id: PRINTCHECK_PLUGIN_ID, version: PRINTCHECK_PLUGIN_VERSION }, op: 'printability', params })
const run = (mesh: Mesh, params: Record<string, unknown> = {}, signal?: AbortSignal) => runWorkflow(addStep(emptyStepList(), step(params)), { registry: registry(), source: mesh, quality: 'export', ...(signal ? { signal } : {}) })

/** Two meshes in one (separate shells), the second moved up by `dz`. */
const stack = (a: Mesh, b: Mesh, dz: number): Mesh => {
  const nv = a.positions.length / 3
  const pb = Float64Array.from(b.positions, (v, i) => (i % 3 === 2 ? v + dz : v))
  return { positions: Float64Array.from([...a.positions, ...pb]), indices: Uint32Array.from([...a.indices, ...Array.from(b.indices, v => v + nv)]) }
}
/** A box whose lowest point is on the bed (z = 0). */
const onBed = (w: number, d: number, h: number): Mesh => { const b = boxMesh(w, d, h); return { ...b, positions: Float64Array.from(b.positions, (v, i) => (i % 3 === 2 ? v + h / 2 : v)) } }

describe('org.ateliermesh.printcheck', () => {
  it('has a valid manifest, a JSON Schema that agrees with the validator, and the analyzer kind', () => {
    expect(validateManifest(printcheckManifest).ok).toBe(true)
    const op = printcheckManifest.operations[0]!
    expect(op.kind).toBe('analyzer'); expect(op.category).toBe('check'); expect(op.outputs?.mesh).toBe(false)
    const check_ = new Ajv({ strict: false }).compile(operationParamsSchema(printcheckManifest, op) as object)
    expect(check_({ process: 'resin', bed: [100, 100, 100] })).toBe(true)
    expect(check_({ process: 'sls' })).toBe(false)
    expect(check_({ overhang_angle: 120 })).toBe(false)
  })

  it('a solid cube is good to print: nothing is flagged and the score is full', () => {
    const r = check(onBed(30, 30, 30))
    expect(r.verdict).toBe('good'); expect(r.score).toBe(100); expect(r.issues).toBe(0)
    for (const n of ['not_closed', 'islands', 'thin_walls', 'thin_features', 'narrow_gaps', 'needs_support', 'long_bridges', 'tiny_base', 'too_tall', 'too_big_for_bed']) expect(find(r, n).severity, n).toBe('ok')
    expect(find(r, 'detail').count).toBe(12)
  })

  it('does not change the mesh, and gives the findings as structured data', async () => {
    const m = onBed(30, 30, 30)
    const out = await run(m, {})
    expect(out.ok).toBe(true)
    expect(out.mesh).toBe(m)                                            // the same mesh comes back
    const rep = out.results[0]!.report as unknown as PrintCheckResult
    expect(rep.verdict).toBe('good'); expect(Array.isArray(rep.findings)).toBe(true)
    expect(rep.findings.every(f => typeof f.code === 'string' && f.code.startsWith('printcheck.') && ['ok', 'info', 'warning', 'error'].includes(f.severity))).toBe(true)
    expect(out.results[0]!.warnings ?? []).toEqual([])
  })

  it('a 0.4 mm plate is flagged as a thin wall, with its thinnest value and triangles to show', () => {
    const r = check(onBed(40, 40, 0.4))
    const f = find(r, 'thin_walls')
    expect(['warning', 'error']).toContain(f.severity)
    expect(f.value).toBeCloseTo(0.4, 1)
    expect(f.share).toBeGreaterThan(0.5)                                // the two big faces are thin
    expect(f.triangles!.length).toBeGreaterThan(0)
    expect(f.at).toBeDefined()
    expect(r.verdict).not.toBe('good')
  })

  it('a thick wall is not flagged, and the wall limit can be set', () => {
    const plate = onBed(40, 40, 1.0)
    expect(find(check(plate), 'thin_walls').severity).toBe('ok')                       // 1 mm is over 0.8
    expect(['warning', 'error']).toContain(find(check(plate, { minWall: 1.5 }), 'thin_walls').severity)
    expect(find(check(onBed(40, 40, 0.7), { process: 'resin' }), 'thin_walls').severity).toBe('ok')   // resin: 0.6
  })

  it('a thin post is a thin feature, not only a thin wall', () => {
    const post = onBed(0.5, 0.5, 20)
    const r = check(post)
    const f = find(r, 'thin_features')
    expect(['warning', 'info']).toContain(f.severity); expect(f.count).toBeGreaterThan(0)
    expect(f.value).toBeLessThan(0.8)
    // a broad thin plate has no thin feature (it is thin in one direction only)
    expect(find(check(onBed(40, 40, 0.5)), 'thin_features').count).toBe(0)
  })

  it('two plates 0.2 mm apart are a narrow gap', () => {
    const m = stack(onBed(20, 20, 2), onBed(20, 20, 2), 2.2)
    const r = check(m)
    const f = find(r, 'narrow_gaps')
    expect(f.severity).toBe('warning'); expect(f.value).toBeCloseTo(0.2, 1); expect(f.share).toBeGreaterThan(0.05)
    expect(find(check(stack(onBed(20, 20, 2), onBed(20, 20, 2), 4)), 'narrow_gaps').severity).toBe('ok')   // 2 mm apart is fine
    // the same model has two shells: that is a floating piece too
    expect(find(r, 'islands').count).toBe(1)
  })

  it('a surface with a missing face is not closed', () => {
    const b = boxMesh(10, 10, 10)
    const open: Mesh = { positions: b.positions, indices: b.indices.slice(0, b.indices.length - 6) }
    const r = check(open)
    const f = find(r, 'not_closed')
    expect(f.severity).toBe('error'); expect(f.count).toBeGreaterThan(0)
    expect(r.verdict).toBe('not_printable')
  })

  it('finds the overhang of a T-beam stem down, and none with the bar down', () => {
    const stemDown = check(tBeam(50))
    const f = find(stemDown, 'needs_support')
    expect(f.severity).toBe('warning'); expect(f.value).toBeCloseTo(1500, 0); expect(f.triangles!.length).toBeGreaterThan(0)
    const flipped: Mesh = { ...tBeam(50), positions: Float64Array.from(tBeam(50).positions, (v, i) => (i % 3 === 2 ? 30 - v : v)), indices: (() => { const idx = tBeam(50).indices.slice(); for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]!; idx[i + 1] = idx[i + 2]!; idx[i + 2] = t } return idx })() }
    expect(find(check(flipped), 'needs_support').severity).toBe('ok')
  })

  it('a wide flat roof is a long bridge', () => {
    // a table: a plate 40 x 30 mm on two legs; its underside is a flat roof, spanned across its shorter side (30 mm)
    const top = onBed(40, 30, 2)
    const leg = (x: number): Mesh => ({ ...onBed(4, 30, 10), positions: Float64Array.from(onBed(4, 30, 10).positions, (v, i) => (i % 3 === 0 ? v + x : v)) })
    const legs = stack(leg(-18), leg(18), 0)                // two legs on the bed
    const table = stack(legs, top, 10)                       // the roof on top, 10 mm up
    const r = check(table)
    const f = find(r, 'long_bridges')
    expect(f.severity).toBe('warning'); expect(f.value).toBeGreaterThan(10)
    expect(find(check(table, { bridgeLength: 60 }), 'long_bridges').severity).toBe('ok')
  })

  it('a tall thin cylinder is too tall', () => {
    const r = check(frustum(2, 2, 80, 32, 2))
    const f = find(r, 'too_tall')
    expect(f.severity).toBe('error'); expect(f.value).toBeGreaterThan(15)
    expect(find(check(frustum(2, 2, 30, 32, 2)), 'too_tall').severity).toBe('warning')   // 30 mm tall, 4 mm wide: 7.5
    expect(find(check(onBed(30, 30, 30)), 'too_tall').severity).toBe('ok')
  })

  it('a ball touches the bed in one point: tiny base', () => {
    expect(find(check(sphere(15, 3)), 'tiny_base').severity).toBe('warning')
    expect(find(check(onBed(30, 30, 30)), 'tiny_base').severity).toBe('ok')
  })

  it('a model bigger than the bed is flagged; one that fits when turned is a warning with the angle', () => {
    const huge = check(onBed(300, 300, 10), { bed: [100, 100, 100] })
    expect(find(huge, 'too_big_for_bed').severity).toBe('error'); expect(huge.verdict).toBe('not_printable')
    const long = check(onBed(120, 30, 10), { bed: [50, 130, 100] })
    const f = find(long, 'too_big_for_bed')
    expect(f.severity).toBe('warning'); expect(f.params['turn']).toBeGreaterThan(0); expect(f.params['turn']).toBeLessThanOrEqual(90)   // the smallest turn (in 5 degree steps) that fits
    expect(find(check(onBed(120, 30, 10), { bed: [200, 200, 100] }), 'too_big_for_bed').severity).toBe('ok')
    // 0 on every axis leaves the check out
    expect(check(onBed(300, 300, 10), { bed: [0, 0, 0] }).findings.some(x => x.name === 'too_big_for_bed')).toBe(false)
  })

  it('the score and the verdict follow the rules: an error is not printable, a warning is fix recommended', () => {
    const good = check(onBed(30, 30, 30)), warn = check(stack(onBed(20, 20, 2), onBed(20, 20, 2), 2.2)), bad = check(onBed(300, 300, 10), { bed: [100, 100, 100] })
    expect(good.verdict).toBe('good'); expect(warn.verdict).toBe('fix_recommended'); expect(bad.verdict).toBe('not_printable')
    expect(good.score).toBeGreaterThan(warn.score); expect(warn.score).toBeGreaterThan(bad.score)
    for (const r of [good, warn, bad]) { expect(r.score).toBeGreaterThanOrEqual(0); expect(r.score).toBeLessThanOrEqual(100) }
    expect(bad.issues).toBe(bad.findings.filter(f => f.severity === 'warning' || f.severity === 'error').length)
  })

  it('warnings and errors of the report come back as warnings of the step, with texts for their codes', async () => {
    const out = await run(onBed(40, 40, 0.4), {})
    const w = out.results[0]!.warnings ?? []
    expect(w.some(x => x.code === 'printcheck.thin_walls')).toBe(true)
    for (const x of w) { const v = describeProblem(x.code, x.params as Record<string, unknown>); expect(v.kind).toBe('warning'); expect(v.blocks).toBe(false) }
    expect(describeProblem('printcheck.thin_walls', { thinnest: 0.4, min: 0.8, percent: 90 }).values).toMatchObject({ thinnest: 0.4, min: 0.8, percent: 90 })
  })

  it('is deterministic, and different thresholds give a different answer', () => {
    const m = sphere(15, 4)
    const strip = (r: PrintCheckResult): unknown => ({ ...r, ms: 0 })
    expect(strip(check(m))).toEqual(strip(check(m)))
    expect(strip(check(m, { overhangAngle: 30 }))).not.toEqual(strip(check(m)))
  })

  it('stops when asked, and reports progress', async () => {
    const ac = new AbortController(); ac.abort()
    const out = await run(sphere(10, 3), {}, ac.signal)
    expect(out.ok).toBe(false)
    const seen: number[] = []
    check(onBed(10, 10, 10), { onProgress: (_s, f) => seen.push(f) })
    expect(seen.length).toBeGreaterThan(3); expect(seen[seen.length - 1]).toBe(1)
    expect(seen.every((f, i) => i === 0 || f >= seen[i - 1]!)).toBe(true)
  })

  it('an empty mesh is refused with a clear reason', async () => {
    const out = await run({ positions: new Float64Array(0), indices: new Uint32Array(0) }, {})
    expect(out.ok).toBe(false)
  })

  it('is an analyzer: the order hint says to put it last', () => {
    const list = ['p', 'c'].reduce((l, id, i) => addStep(l, i === 0 ? step() : makeStep({ id, plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op: 'resize', params: { mode: 'percent', percent: 100 } })), emptyStepList())
    const hints = orderHints(list)
    expect(hints.some(h => h.step === 'p' && h.code === 'analyze_last')).toBe(true)
    // with only analyzers after it, nothing to say
    expect(orderHints(addStep(emptyStepList(), step())).length).toBe(0)
  })

  it('passes its conformance fixtures', async () => {
    const results = await runFixtures(printcheckFixtures, { registry: registry() })
    expect(results.filter(r => !r.ok).map(r => `${r.name}: ${JSON.stringify(r)}`)).toEqual([])
  })

  it('stays quick: a 80 000 triangle ball in a preview, about as fast in an export', () => {
    const big = sphere(25, 6)
    expect(big.indices.length / 3).toBeGreaterThan(80000)
    let t = Date.now(); const a = check(big, { quality: 'preview' }); const preview = Date.now() - t
    t = Date.now(); const b = check(big, { quality: 'export' }); const exp = Date.now() - t
    expect(a.verdict).toBeDefined(); expect(b.samples).toBeGreaterThan(a.samples)
    expect(preview).toBeLessThan(6000); expect(exp).toBeLessThan(12000)       // generous for a loaded machine: it takes about a second
    expect(measureMesh(big).watertight).toBe(true)
  })
})
