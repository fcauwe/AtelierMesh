import { describe, expect, it } from 'vitest'
import { Registry, addStep, emptyStepList, makeStep, measureMesh, operationParamsSchema, runFixtures, runWorkflow, validateManifest } from '@ateliermesh/core'
import { boxMesh, lBracketMesh } from '@ateliermesh/core/testing'
import Ajv from 'ajv/dist/2020'
import { CORE_PLUGIN_ID, CORE_PLUGIN_VERSION, coreFixtures, coreManifest, corePlugin } from '../src'
import { cheatFixtures } from '../src/fixtures'
import { aroundPivot, multiply, rotation, scaling } from '../src/geometry'

const registry = (): Registry => new Registry().register(corePlugin())
const st = (id: string, op: string, params: Record<string, unknown>) => makeStep({ id, plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op, params })

describe('org.ateliermesh.core', () => {
  it('has a valid manifest and JSON Schemas that agree with the validator', () => {
    expect(validateManifest(coreManifest).ok).toBe(true)
    const ajv = new Ajv({ strict: false })
    for (const op of coreManifest.operations) {
      const schema = operationParamsSchema(coreManifest, op)
      const ok = ajv.validate(schema, Object.fromEntries(op.params.map(p => [p.name, p.default])))
      expect(ok, op.id).toBe(true)
    }
  })

  it('passes its conformance fixtures', async () => {
    const results = await runFixtures(coreFixtures, { registry: registry() })
    expect(results.filter(r => !r.ok)).toEqual([])
    expect(results.length).toBeGreaterThanOrEqual(9)
  })

  it('catches a cheat: the deliberate wrong expectation fails', async () => {
    const results = await runFixtures(cheatFixtures, { registry: registry() })
    expect(results.every(r => !r.ok)).toBe(true)
    expect(results[0]!.failures[0]).toContain('size')
  })

  it('resize can change one direction only (a stretch): target size without keeping proportions, or a percentage per direction', async () => {
    const box = boxMesh(10, 20, 30)
    const sz = (m: { positions: Float64Array }): number[] => { const mm = measureMesh(m as never); return mm.size }
    const one = await runWorkflow(addStep(emptyStepList(), st('r', 'resize', { mode: 'target_size', target_axis: 'z', target_mm: 60, keep_proportions: false })), { registry: registry(), source: box })
    expect(sz(one.mesh!).map(v => Math.round(v * 1e6) / 1e6)).toEqual([10, 20, 60])
    expect(measureMesh(one.mesh!).volume).toBeCloseTo(10 * 20 * 60, 6)
    const kept = await runWorkflow(addStep(emptyStepList(), st('r', 'resize', { mode: 'target_size', target_axis: 'z', target_mm: 60 })), { registry: registry(), source: box })
    expect(sz(kept.mesh!).map(v => Math.round(v * 1e6) / 1e6)).toEqual([20, 40, 60])     // proportions kept by default
    const per = await runWorkflow(addStep(emptyStepList(), st('r', 'resize', { mode: 'per_axis', percent_x: 100, percent_y: 50, percent_z: 200 })), { registry: registry(), source: box })
    expect(sz(per.mesh!).map(v => Math.round(v * 1e6) / 1e6)).toEqual([10, 10, 60])
    const rep = per.results[0]!.report as { factors: number[]; uniform: boolean; factor: number }
    expect(rep.factors).toEqual([1, 0.5, 2]); expect(rep.uniform).toBe(false); expect(rep.factor).toBeCloseTo(1, 9)   // the mean of the three
    expect(measureMesh(per.mesh!).watertight).toBe(true)
  })
  it('resize scales the volume by the factor cubed and keeps the pivot fixed', async () => {
    const r = await runWorkflow(addStep(emptyStepList(), st('r', 'resize', { percent: 250 })), { registry: registry(), source: lBracketMesh() })
    expect(measureMesh(r.mesh!).volume).toBeCloseTo(6000 * 2.5 ** 3, 3)
    const m = measureMesh(r.mesh!)
    expect((m.bbox.min[0] + m.bbox.max[0]) / 2).toBeCloseTo(20, 9)
  })

  it('reports a matrix that reproduces the result (placements can follow it)', async () => {
    const src = lBracketMesh()
    const l = [st('a', 'resize', { percent: 120 }), st('b', 'rotate', { angles: [30, 40, 50] })].reduce((x, s) => addStep(x, s), emptyStepList())
    const r = await runWorkflow(l, { registry: registry(), source: src })
    const m = r.results[1]!.report!['matrix'] as number[]
    const prev = r.results[0]!.mesh!
    const P = prev.positions, Q = r.mesh!.positions
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i]!, y = P[i + 1]!, z = P[i + 2]!
      expect(m[0]! * x + m[1]! * y + m[2]! * z + m[3]!).toBeCloseTo(Q[i]!, 9)
      expect(m[4]! * x + m[5]! * y + m[6]! * z + m[7]!).toBeCloseTo(Q[i + 1]!, 9)
      expect(m[8]! * x + m[9]! * y + m[10]! * z + m[11]!).toBeCloseTo(Q[i + 2]!, 9)
    }
  })

  it('rotation keeps the volume and an asymmetric part keeps its three different sizes', async () => {
    const r = await runWorkflow(addStep(emptyStepList(), st('r', 'rotate', { angles: [90, 0, 90], pivot: 'origin' })), { registry: registry(), source: lBracketMesh() })
    const m = measureMesh(r.mesh!)
    expect(m.volume).toBeCloseTo(6000, 6)
    expect([...m.size].sort((a, b) => a - b).map(v => Math.round(v))).toEqual([10, 20, 40])
    expect(m.watertight).toBe(true)
  })

  it('does not change the input mesh and keeps segments', async () => {
    const src = boxMesh(10, 10, 10)
    const copy = src.positions.slice()
    await runWorkflow(addStep(emptyStepList(), st('r', 'resize', { percent: 300 })), { registry: registry(), source: src })
    expect(Array.from(src.positions)).toEqual(Array.from(copy))
  })

  it('rejects out-of-range values with the usual codes, and a step with no mesh', async () => {
    const bad = await runWorkflow(addStep(emptyStepList(), st('r', 'resize', { percent: 0 })), { registry: registry(), source: boxMesh(1, 1, 1) })
    expect(bad.results[0]!.error?.code).toBe('param.out_of_range')
    const none = await runWorkflow(addStep(emptyStepList(), st('r', 'resize', {})), { registry: registry() })
    expect(none.results[0]!.error?.code).toBe('input.missing_mesh')
  })

  it('matrix helpers: pivot, order and exact right angles', () => {
    const m = aroundPivot(scaling(2), [1, 1, 1])
    expect(m[3]).toBeCloseTo(-1); expect(m[0]).toBe(2)
    expect(rotation('Z', 90)).toEqual([0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    const xy = multiply(rotation('Y', 90), rotation('X', 90)), yx = multiply(rotation('X', 90), rotation('Y', 90))
    expect(xy).not.toEqual(yx)
  })
})

describe('every built-in plugin carries its metadata', () => {
  it('has a licence, a description and a valid contact (the same rule as for external packages)', async () => {
    const { BUILT_IN_PLUGINS } = await import('../src')
    const { validateManifest } = await import('@ateliermesh/core')
    expect(BUILT_IN_PLUGINS.length).toBeGreaterThanOrEqual(11)
    for (const b of BUILT_IN_PLUGINS) {
      const m = b.entry().manifest
      const v = validateManifest(m, { requireMetadata: true })
      expect(v.errors, `${b.id}: ${JSON.stringify(v.errors)}`).toEqual([])
      expect(m.contact?.url).toBe('https://micro-fabriek.be')
    }
  })
})
