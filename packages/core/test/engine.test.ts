import { describe, expect, it } from 'vitest'
import {
  Registry, addStep, makeStep, moveStep, removeStep, duplicateStep, setParams, setEnabled, emptyStepList, parseStepList, serializeStepList,
  stepListHash, firstChangedIndex, runWorkflow, MemoryCache, migrateStepList, MeshError, measureMesh, runFixtures, validateManifest, type Fixture, type Step, type StepList,
} from '../src'
import { boxMesh, createTestPlugin, TEST_PLUGIN_ID } from '../src/testing'

const P = { id: TEST_PLUGIN_ID, version: '1.0.0' }
const st = (id: string, op: string, params: Record<string, unknown> = {}, extra: Partial<Step> = {}): Step => makeStep({ id, plugin: P, op, params, ...extra })
const list = (...steps: Step[]): StepList => steps.reduce((l, s) => addStep(l, s), emptyStepList())
function setup(version = '1.0.0') { const tp = createTestPlugin(version); return { tp, registry: new Registry().register(tp.entry) } }

describe('stack operations are pure', () => {
  const l = list(st('a', 'scale'), st('b', 'scale'), st('c', 'scale'))
  it('add, remove, move, duplicate, params, enabled', () => {
    expect(removeStep(l, 'b').steps.map(s => s.id)).toEqual(['a', 'c'])
    expect(moveStep(l, 'c', 0).steps.map(s => s.id)).toEqual(['c', 'a', 'b'])
    expect(duplicateStep(l, 'a', 'a2').steps.map(s => s.id)).toEqual(['a', 'a2', 'b', 'c'])
    expect(setParams(l, 'a', { factor: 3 }).steps[0]!.params).toEqual({ factor: 3 })
    expect(setEnabled(l, 'a', false).steps[0]!.enabled).toBe(false)
    expect(l.steps.map(s => s.id)).toEqual(['a', 'b', 'c'])
    expect(() => addStep(l, st('a', 'scale'))).toThrow()
    expect(() => removeStep(l, 'zz')).toThrow()
  })
  it('round-trips as JSON and hashes stably', () => {
    const back = parseStepList(JSON.parse(JSON.stringify(serializeStepList(l))))
    expect(back.ok).toBe(true)
    expect(back.value).toEqual(l)
    expect(stepListHash(back.value!)).toBe(stepListHash(l))
    expect(parseStepList([{ id: 'x' }]).ok).toBe(false)
    expect(parseStepList(l.steps).ok).toBe(true)
  })
  it('firstChangedIndex', () => {
    expect(firstChangedIndex(l, l)).toBe(-1)
    expect(firstChangedIndex(l, setParams(l, 'b', { factor: 2 }))).toBe(1)
    expect(firstChangedIndex(l, removeStep(l, 'c'))).toBe(2)
  })
})

describe('registry and step validation', () => {
  const { registry } = setup()
  it('unknown plugin, op, newer version, bad params', () => {
    expect(registry.validateStep(makeStep({ id: 'x', plugin: { id: 'nope.x', version: '1.0.0' }, op: 'a' })).errors[0]?.code).toBe('step.unknown_plugin')
    expect(registry.validateStep(st('x', 'wat')).errors[0]?.code).toBe('step.unknown_op')
    expect(registry.validateStep(makeStep({ id: 'x', plugin: { id: TEST_PLUGIN_ID, version: '2.0.0' }, op: 'scale' })).errors[0]?.code).toBe('step.version_newer')
    expect(registry.validateStep(st('x', 'scale', { factor: 99 })).errors[0]?.code).toBe('param.out_of_range')
  })
  it('refuses a personalisable_params entry that is not personalisable in the manifest', () => {
    expect(registry.validateStep(st('x', 'scale', {}, { personalisable_params: ['mode'] })).errors[0]?.code).toBe('step.not_personalisable')
    expect(registry.validateStep(st('x', 'scale', {}, { personalisable_params: ['factor'], personalisable: true })).ok).toBe(true)
    expect(registry.validateStep(st('x', 'measure', {}, { personalisable: true })).ok).toBe(true)
  })
  it('customer role: only handed-over parameters may change', () => {
    const base = list(st('s', 'scale', { factor: 1 }, { personalisable: true, personalisable_params: ['factor'] }))
    expect(registry.validateStepList(setParams(base, 's', { factor: 2 }), { role: 'customer', base }).ok).toBe(true)
    expect(registry.validateStepList(setParams(base, 's', { factor: 2, mode: 'xy' }), { role: 'customer', base }).errors[0]?.code).toBe('param.not_editable')
    expect(registry.validateStepList(addStep(base, st('t', 'scale')), { role: 'customer', base }).ok).toBe(false)
    const widened = { ...base, steps: [{ ...base.steps[0]!, personalisable_params: ['factor', 'label'] }] }
    expect(registry.validateStepList(widened, { role: 'customer', base }).ok).toBe(false)
  })
  it('refuses duplicate plugin and invalid manifests', () => {
    expect(() => registry.register(createTestPlugin().entry)).toThrow(MeshError)
    expect(() => new Registry().register({ manifest: { manifest_version: 1, id: 'bad' } as never, load: () => ({ run: async () => ({}) }) })).toThrow(MeshError)
  })
})

describe('runner', () => {
  it('runs a chain and measures', async () => {
    const { registry } = setup()
    const r = await runWorkflow(list(st('s', 'scale', { factor: 2 }), st('m', 'measure')), { registry, source: boxMesh(10, 10, 10) })
    expect(r.ok).toBe(true)
    expect(r.results[1]!.report!['volume']).toBeCloseTo(8000)
    expect(measureMesh(r.mesh!).volume).toBeCloseTo(8000)
  })
  it('a generator needs no source; a modifier without one fails', async () => {
    const { registry } = setup()
    expect((await runWorkflow(list(st('b', 'box', { width: 2, depth: 3, height: 4 })), { registry })).ok).toBe(true)
    const r = await runWorkflow(list(st('s', 'scale')), { registry })
    expect(r.results[0]!.error?.code).toBe('input.missing_mesh')
  })
  it('changing step 3 of 5 re-runs only steps 3 to 5', async () => {
    const { registry, tp } = setup()
    const cache = new MemoryCache()
    const l = list(...[1, 2, 3, 4, 5].map(i => st(`s${i}`, 'scale', { factor: 1 + i / 10 })))
    const src = boxMesh(10, 10, 10)
    const a = await runWorkflow(l, { registry, source: src, cache })
    expect(a.ran).toBe(5)
    tp.calls['scale'] = 0
    const b = await runWorkflow(setParams(l, 's3', { factor: 5 }), { registry, source: src, cache })
    expect(b.ran).toBe(3); expect(b.fromCache).toBe(2); expect(tp.calls['scale']).toBe(3)
    tp.calls['scale'] = 0
    const c = await runWorkflow(l, { registry, source: src, cache })
    expect(c.ran).toBe(0); expect(tp.calls['scale']).toBe(0)
  })
  it('disabled steps pass through', async () => {
    const { registry } = setup()
    const r = await runWorkflow(setEnabled(list(st('s', 'scale', { factor: 2 })), 's', false), { registry, source: boxMesh(10, 10, 10) })
    expect(r.results[0]!.status).toBe('disabled'); expect(measureMesh(r.mesh!).volume).toBeCloseTo(1000)
  })
  it('a failing step marks later steps stale and keeps earlier results', async () => {
    const { registry } = setup()
    const r = await runWorkflow(list(st('a', 'scale', { factor: 2 }), st('f', 'fail'), st('b', 'scale')), { registry, source: boxMesh(10, 10, 10) })
    expect(r.ok).toBe(false); expect(r.firstProblem).toBe(1)
    expect(r.results.map(x => x.status)).toEqual(['ok', 'error', 'stale'])
    expect(r.results[0]!.mesh).toBeDefined()
    expect(r.results[1]!.error?.code).toBe('test.deliberate')
    expect(measureMesh(r.mesh!).volume).toBeCloseTo(8000)
  })
  it('a modifier that returns no mesh is an error', async () => {
    const { registry } = setup()
    expect((await runWorkflow(list(st('n', 'nomesh')), { registry, source: boxMesh(1, 1, 1) })).results[0]!.error?.code).toBe('plugin.failed')
  })
  it('a cancelled run leaves earlier results intact', async () => {
    const { registry } = setup()
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 40)
    const r = await runWorkflow(list(st('a', 'scale', { factor: 2 }), st('w', 'slow', { ms: 3000 }), st('b', 'scale')), { registry, source: boxMesh(10, 10, 10), signal: ctrl.signal })
    expect(r.results.map(x => x.status)).toEqual(['ok', 'cancelled', 'stale'])
    expect(r.results[0]!.mesh).toBeDefined()
  })
  it('a stubborn plugin is abandoned at the timeout', async () => {
    const { registry } = setup()
    const t0 = Date.now()
    const r = await runWorkflow(list(st('x', 'stubborn', { ms: 3000 })), { registry, source: boxMesh(1, 1, 1), limits: { stepTimeoutMs: 80 } })
    expect(Date.now() - t0).toBeLessThan(1500)
    expect(r.results[0]!.error?.code).toBe('run.timeout')
  })
  it('enforces triangle budgets on source and result', async () => {
    const { registry } = setup()
    await expect(runWorkflow(list(st('s', 'scale')), { registry, source: boxMesh(1, 1, 1), limits: { maxTriangles: 5 } })).rejects.toMatchObject({ code: 'budget.triangles' })
    const r = await runWorkflow(list(st('b', 'big', { triangles: 100 })), { registry, limits: { maxTriangles: 50 } })
    expect(r.results[0]!.error?.code).toBe('budget.triangles')
  })
  it('migrates steps stored by an older plugin version', async () => {
    const tp = createTestPlugin('1.2.0', { migrate: (from, params) => ({ ...params, factor: ((params['scale'] as number) ?? 1), ...(from === '1.0.0' ? {} : {}) }) })
    const registry = new Registry().register(tp.entry)
    const old = list(makeStep({ id: 's', plugin: { id: TEST_PLUGIN_ID, version: '1.0.0' }, op: 'scale', params: { scale: 3 } }))
    const m = await migrateStepList(old, registry)
    expect(m.migrated).toEqual([{ id: 's', from: '1.0.0' }]); expect(m.list.steps[0]!.plugin.version).toBe('1.2.0')
    const r = await runWorkflow(old, { registry, source: boxMesh(10, 10, 10) })
    expect(r.ok).toBe(false) // 'scale' is not a parameter of the new version, so the migrated params still fail validation
    expect(r.results[0]!.error?.code).toBe('param.unknown')
  })
})

describe('conformance fixtures', () => {
  const { registry } = setup()
  const fx: Fixture[] = [
    { name: 'scale x2', input: { kind: 'generator', name: 'box', params: { width: 10, depth: 10, height: 10 } }, steps: [st('s', 'scale', { factor: 2 })], expect: { volume: { value: 8000, tol: 1e-6 }, triangles: 12, watertight: true, size: { value: [20, 20, 20], tol: 1e-9 } } },
    { name: 'bad param fails', input: null, steps: [st('s', 'scale', { factor: 99 })], expect: { ok: false, error_code: 'param.out_of_range' } },
    { name: 'wrong expectation is reported', input: { kind: 'generator', name: 'box' }, steps: [st('m', 'measure')], expect: { volume: { value: 5, tol: 1 } } },
  ]
  it('passes, fails as expected, and reports mismatches', async () => {
    const r = await runFixtures(fx, { registry })
    expect(r.map(x => x.ok)).toEqual([true, true, false])
    expect(r[2]!.failures[0]).toContain('volume')
  })
})

describe('operations limited to a segment', () => {
  it('label_top then lift touches only the segment and keeps its border', async () => {
    const { registry } = setup()
    const src = boxMesh(10, 10, 10)
    const l = list(st('l', 'label_top', { name: 'top' }), st('u', 'lift', { segment: 'top', dz: 5 }), st('x', 'lift', { segment: 'nope' }))
    const r = await runWorkflow(l, { registry, source: src })
    expect(r.results[0]!.status).toBe('ok'); expect(r.results[1]!.status).toBe('ok')
    expect(r.results[1]!.report!['moved']).toBe(0) // all four vertices of a box top are on its border
    expect(r.results[2]!.error?.code).toBe('segment.unknown')
    expect(r.results[2]!.status).toBe('error')
    const labelled = r.results[0]!.mesh!
    expect(labelled.segments!.table.map(s => s.name)).toEqual(['body', 'top'])
    expect([...labelled.segments!.labels].filter(x => x === 1).length).toBe(2)
    expect([...r.results[1]!.mesh!.positions]).toEqual([...labelled.positions])
  })
  it('a fan on a pyramid moves its interior and leaves everything else alone', async () => {
    const { registry } = setup()
    const flat = { positions: Float64Array.from([0, 0, 1, 10, 0, 1, 10, 10, 1, 0, 10, 1, 5, 5, 1, 5, 5, -3]), indices: Uint32Array.from([0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4, 0, 5, 1, 1, 5, 2, 2, 5, 3, 3, 5, 0]) }
    const r = await runWorkflow(list(st('l', 'label_top', { name: 'top' }), st('u', 'lift', { segment: 'top', dz: 2 })), { registry, source: flat })
    const out = r.results[1]!.mesh!
    expect(r.results[1]!.report!['moved']).toBe(1) // only the centre vertex is interior to the labelled fan
    expect(out.positions[3 * 4 + 2]).toBe(3)
    for (const v of [0, 1, 2, 3, 5]) expect(out.positions[3 * v + 2]).toBe(flat.positions[3 * v + 2])
  })
})

describe('untrusted plugins', () => {
  const { entry } = createTestPlugin()
  const hostile = (positions: Float64Array, indices: Uint32Array, untrusted: boolean): Registry => new Registry().register({
    ...entry, untrusted, manifest: { ...entry.manifest, id: 'ext.hostile' },
    load: () => ({ run: async () => ({ mesh: { positions, indices } }) }),
  })
  const step = makeStep({ id: 'x', plugin: { id: 'ext.hostile', version: '1.0.0' }, op: 'nomesh', params: {} })
  const l = addStep(emptyStepList(), step)
  it('rejects a mesh with NaN positions or indices past the end, but only from untrusted plugins', async () => {
    const nan = await runWorkflow(l, { registry: hostile(Float64Array.from([0, 0, NaN, 1, 0, 0, 0, 1, 0]), Uint32Array.from([0, 1, 2]), true), source: boxMesh(1, 1, 1) })
    expect(nan.results[0]!.error).toMatchObject({ code: 'plugin.bad_mesh' })
    const range = await runWorkflow(l, { registry: hostile(Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), Uint32Array.from([0, 1, 9]), true), source: boxMesh(1, 1, 1) })
    expect(range.results[0]!.error).toMatchObject({ code: 'plugin.bad_mesh' })
    const ok = await runWorkflow(l, { registry: hostile(Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), Uint32Array.from([0, 1, 2]), true), source: boxMesh(1, 1, 1) })
    expect(ok.results[0]!.status).toBe('ok')
  })
  it('records where a plugin came from', () => {
    const reg = new Registry().register({ ...entry, source: { kind: 'package', hash: 'abc', signed: false, origin: 'x.amplugin' }, untrusted: true })
    expect(reg.sourceOf(TEST_PLUGIN_ID)).toMatchObject({ kind: 'package', hash: 'abc' })
    expect(reg.isUntrusted(TEST_PLUGIN_ID)).toBe(true)
    expect(new Registry().register(entry).sourceOf(TEST_PLUGIN_ID)).toEqual({ kind: 'builtin' })
  })
})

describe('permissions in a manifest', () => {
  it('accepts a list of simple permission strings and refuses anything else', () => {
    const base = { manifest_version: 1, id: 'a.b', name: 'x', version: '1.0.0', operations: [{ id: 'o', kind: 'modifier', params: [] }] }
    expect(validateManifest({ ...base, permissions: ['network:https://example.org', 'wasm'] }).ok).toBe(true)
    expect(validateManifest({ ...base, permissions: ['Network:with space'] }).ok).toBe(false)
    expect(validateManifest({ ...base, permissions: 'network' }).ok).toBe(false)
  })
})
