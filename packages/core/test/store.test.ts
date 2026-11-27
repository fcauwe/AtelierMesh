import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STORE_LIMITS, ORIGINAL_NAME, InProcessHost, MemoryCache, Registry, createRunner, STORE_PLUGIN_ID, payloadKinds, readZip, storeProblem, operationAvailability, runFixture, addStep, emptyStepList, listStore, loadProject, makeStep, measureMesh, payloadKindOf, registerStore, runWorkflow, saveProject, storeManifest, validateManifest,
  type Drawing, type Mesh, type ProjectStore, type Step,
} from '../src'
import { SHAPES_PLUGIN_ID, TEST_PLUGIN_ID, boxMesh, createShapesPlugin, createTestPlugin } from '../src/testing'

const st = (id: string, plugin: string, op: string, params: Record<string, unknown> = {}): Step => makeStep({ id, plugin: { id: plugin, version: '1.0.0' }, op, params })
const sh = (id: string, op: string, params: Record<string, unknown> = {}): Step => st(id, SHAPES_PLUGIN_ID, op, params)
const store = (id: string, name: string): Step => st(id, STORE_PLUGIN_ID, 'store', { name })
const load = (id: string, name: string | null): Step => st(id, STORE_PLUGIN_ID, 'load', { name })
const list = (...s: Step[]) => s.reduce((l, x) => addStep(l, x), emptyStepList())
const square = (s: number): Drawing => ({ kind: 'drawing', paths: [{ closed: true, points: [[0, 0], [s, 0], [s, s], [0, s]] }] })
const setup = () => { const s = createShapesPlugin(); return { reg: registerStore(new Registry().register(s.entry).register(createTestPlugin().entry)), calls: s.calls } }
const logo = (s = 10): ProjectStore => ({ logo: { payload: square(s) } })

describe('the store plugin manifest', () => {
  it('is a valid manifest and registers once', () => {
    expect(validateManifest(storeManifest).ok).toBe(true)
    const reg = registerStore(new Registry())
    expect(registerStore(reg)).toBe(reg)
    expect(reg.has(STORE_PLUGIN_ID)).toBe(true)
  })
})

describe('the payload parameter: a mesh step that also takes a stored drawing', () => {
  it('gives the plugin the project entry by parameter name', async () => {
    const { reg } = setup()
    const r = await runWorkflow(list(sh('s', 'stamp', { shape: 'logo' })), { registry: reg, source: boxMesh(10, 10, 10), store: logo(7) })
    expect(r.ok, JSON.stringify(r.results[0]?.error)).toBe(true)
    expect(r.results[0]!.report).toEqual({ shapePaths: 1, shapeWidth: 7 })
  })

  it('fails with a name when there is no such entry, and marks the rest stale', async () => {
    const { reg } = setup()
    const r = await runWorkflow(list(sh('s', 'stamp', { shape: 'nope' }), sh('t', 'stamp', { shape: 'nope' })), { registry: reg, source: boxMesh(10, 10, 10), store: logo() })
    expect(r.results[0]!.error).toEqual({ code: 'input.missing_payload', params: { op: 'stamp', param: 'shape', name: 'nope', kind: 'drawing' } })
    expect(r.results[1]!.status).toBe('stale')
  })

  it('refuses an entry of another kind than the parameter accepts', async () => {
    const { reg } = setup()
    const r = await runWorkflow(list(sh('s', 'stamp', { shape: 'plate' })), { registry: reg, source: boxMesh(10, 10, 10), store: { plate: { payload: boxMesh(1, 1, 1) } } })
    expect(r.results[0]!.error).toEqual({ code: 'input.wrong_kind', params: { op: 'stamp', param: 'shape', name: 'plate', expected: 'drawing', got: 'mesh' } })
  })

  it('refuses a malformed entry and an entry over its own limit', async () => {
    const { reg } = setup()
    const bad = { kind: 'drawing', paths: [{ closed: true, points: [[0, 0]] }] } as unknown as Drawing
    await expect(runWorkflow(list(sh('s', 'stamp', { shape: 'logo' })), { registry: reg, source: boxMesh(1, 1, 1), store: { logo: { payload: bad } } })).rejects.toMatchObject({ code: 'store.bad_entry' })
    const r = await runWorkflow(list(sh('s', 'stamp', { shape: 'logo' })), { registry: reg, source: boxMesh(1, 1, 1), store: { logo: { payload: square(5), limits: { maxPoints: 3 } } } })
    expect(r.results[0]!.error?.code).toBe('budget.points')
  })

  it('refuses a store over the total budget before anything runs', async () => {
    const { reg } = setup()
    await expect(runWorkflow(list(), { registry: reg, store: logo(), limits: { maxStoreBytes: 10 } })).rejects.toMatchObject({ code: 'budget.store_bytes' })
    await expect(runWorkflow(list(), { registry: reg, store: { ...logo(), b: { payload: square(1) } }, limits: { maxStoreEntries: 1 } })).rejects.toMatchObject({ code: 'budget.store_entries' })
  })

  it('puts the entry in the cache key: editing the drawing re-runs that step and later ones, not the steps before it', async () => {
    const { reg, calls } = setup()
    const cache = new MemoryCache()
    const l = list(st('a', TEST_PLUGIN_ID, 'scale', { factor: 2 }), sh('s', 'stamp', { shape: 'logo' }), st('b', TEST_PLUGIN_ID, 'scale', { factor: 2 }))
    const run = (s: ProjectStore) => runWorkflow(l, { registry: reg, source: boxMesh(10, 10, 10), store: s, cache })
    const first = await run(logo(5))
    expect(first.ran).toBe(3)
    const same = await run(logo(5))
    expect(same.fromCache).toBe(3)
    const edited = await run(logo(9))
    expect(edited.fromCache).toBe(1)
    expect(edited.ran).toBe(2)
    expect(calls['stamp']).toBe(2)
    expect(edited.results[1]!.report).toMatchObject({ shapeWidth: 9 })
  })

  it('hands a plugin a null parameter as no entry', async () => {
    const { reg } = setup()
    const r = await runWorkflow(list(sh('s', 'stamp', { shape: null })), { registry: reg, source: boxMesh(1, 1, 1) })
    expect(r.results[0]!.status).toBe('error')   // the plugin says "no shape"
  })
})

describe('store and load', () => {
  it('stores what a step produced and a later step takes it as a side input', async () => {
    const { reg } = setup()
    const r = await runWorkflow(list(sh('a', 'square', { size: 12 }), store('st', 'outline'), sh('x', 'extrude', { height: 2 }), sh('s', 'stamp', { shape: 'outline' })), { registry: reg })
    expect(r.ok, JSON.stringify(r.results.map(x => x.error))).toBe(true)
    expect(r.results[1]!.report).toEqual({ stored: 'outline', kind: 'drawing' })
    expect(r.results[3]!.report).toMatchObject({ shapeWidth: 12 })
  })

  it('load replaces the main payload by the entry, whatever came before', async () => {
    const { reg } = setup()
    const r = await runWorkflow(list(load('l', 'logo'), sh('x', 'extrude', { height: 4 })), { registry: reg, source: boxMesh(1, 1, 1), store: logo(10) })
    expect(r.ok, JSON.stringify(r.results.map(x => x.error))).toBe(true)
    expect(payloadKindOf(r.results[0]!.payload!)).toBe('drawing')
    expect(measureMesh(r.mesh as Mesh).volume).toBeCloseTo(10 * 10 * 4)
  })

  it('load can bring a stored mesh back after other steps', async () => {
    const { reg } = setup()
    const r = await runWorkflow(list(store('s', 'body'), st('a', TEST_PLUGIN_ID, 'scale', { factor: 3 }), load('l', 'body')), { registry: reg, source: boxMesh(10, 10, 10) })
    expect(r.ok).toBe(true)
    expect(measureMesh(r.mesh as Mesh).volume).toBeCloseTo(1000)
  })

  it('refuses a store step that reuses a project name, and a load of a name nobody wrote', async () => {
    const { reg } = setup()
    const a = await runWorkflow(list(store('s', 'logo')), { registry: reg, source: boxMesh(1, 1, 1), store: logo() })
    expect(a.results[0]!.error).toEqual({ code: 'store.name_taken', params: { name: 'logo', op: 'store' } })
    const b = await runWorkflow(list(load('l', 'ghost')), { registry: reg, store: logo() })
    expect(b.results[0]!.error?.code).toBe('input.missing_payload')
    const c = await runWorkflow(list(load('l', null)), { registry: reg, store: logo() })
    expect(c.results[0]!.error?.code).toBe('input.missing_payload')
  })

  it('a store step needs something to store', async () => {
    const { reg } = setup()
    const r = await runWorkflow(list(store('s', 'x')), { registry: reg })
    expect(r.results[0]!.error?.code).toBe('input.missing_payload')
  })

  it('the nearest earlier writer wins when a name is stored twice', async () => {
    const { reg } = setup()
    const r = await runWorkflow(list(sh('a', 'square', { size: 4 }), store('s1', 'o'), sh('b', 'square', { size: 9 }), store('s2', 'o'), sh('c', 'extrude'), sh('d', 'stamp', { shape: 'o' })), { registry: reg })
    expect(r.results[5]!.report).toMatchObject({ shapeWidth: 9 })
  })

  it('looks backwards only: a name stored later is not found by an earlier step', async () => {
    const { reg } = setup()
    const r = await runWorkflow(list(sh('d', 'stamp', { shape: 'o' }), sh('a', 'square'), store('s', 'o')), { registry: reg, source: boxMesh(1, 1, 1) })
    expect(r.results[0]!.error?.code).toBe('input.missing_payload')
  })

  it('a disabled store step writes nothing', async () => {
    const { reg } = setup()
    const off = { ...store('s', 'o'), enabled: false }
    const r = await runWorkflow(list(sh('a', 'square'), off, sh('x', 'extrude'), sh('d', 'stamp', { shape: 'o' })), { registry: reg })
    expect(r.results[3]!.error?.code).toBe('input.missing_payload')
  })

  it('validates the name of a store step', () => {
    const { reg } = setup()
    expect(reg.validateStep(store('s', 'Bad Name')).ok).toBe(false)
    expect(reg.validateStep(store('s', 'good_name')).ok).toBe(true)
    expect(reg.validateStep(sh('s', 'stamp', { shape: 'Bad Name' })).ok).toBe(false)
    expect(reg.validateStep(sh('s', 'stamp', { shape: null })).ok).toBe(true)
  })
})

describe('what a Store step makes is generated: rebuilt every run, never saved in the project file', () => {
  it('is in the result of the run and not in the file; only imported items are saved', async () => {
    const { reg } = setup()
    const l = list(sh('a', 'square'), store('s', 'tag'), sh('b', 'extrude'))
    const r = await runWorkflow(l, { registry: reg, store: logo(5) })
    expect(r.ok, JSON.stringify(r.results.map(x => x.error))).toBe(true)
    const rows = listStore(logo(5), l, { registry: reg, results: r.results })
    expect(rows.map(x => [x.name, x.origin])).toEqual([['logo', 'project'], ['tag', 'step']])   // the list says which is which
    // what the project keeps is the store it was given: the generated `tag` is not in it, whatever ran
    const bytes = saveProject({ name: 'p', base: null, list: l, rollback: null, assets: [], store: logo(5) })
    const names = (await readZip(bytes)).map(e => e.name)
    expect(names.filter(n => n.startsWith('store/')).sort()).toEqual(['store/logo.amdraw'])
    const back = await loadProject(bytes, { baseKinds: ['mesh', 'drawing'] })
    expect(Object.keys(back.store ?? {})).toEqual(['logo'])
    // and the Store step still works after a reload: it is made again from the steps
    const again = await runWorkflow(back.list, { registry: reg, store: back.store! })
    expect(listStore(back.store, back.list, { registry: reg, results: again.results }).find(x => x.name === 'tag')?.payload).toBeDefined()
  })
})

describe('the project file carries the store', () => {
  const base = (s?: ProjectStore) => ({ name: 'p', base: boxMesh(10, 10, 10), list: list(sh('s', 'stamp', { shape: 'logo' })), rollback: null, assets: [], ...(s ? { store: s } : {}) })

  it('round-trips a drawing and a mesh with their flags and limits', async () => {
    const s: ProjectStore = { logo: { payload: square(8), personalisable: true, limits: { maxPaths: 5, maxPoints: 100 } }, plate: { payload: boxMesh(2, 3, 4) } }
    const bytes = saveProject(base(s))
    const back = await loadProject(bytes, { baseKinds: ['mesh', 'drawing'] })
    expect(Object.keys(back.store!).sort()).toEqual(['logo', 'plate'])
    expect(back.store!['logo']).toEqual({ payload: square(8), personalisable: true, limits: { maxPaths: 5, maxPoints: 100 } })
    expect(measureMesh(back.store!['plate']!.payload as Mesh).volume).toBeCloseTo(24)
    const { reg } = setup()
    const r = await runWorkflow(back.list, { registry: reg, source: back.base, store: back.store! })
    expect(r.results[0]!.report).toMatchObject({ shapeWidth: 8 })
  })

  it('carries the SVG a drawing came from, as its own file, and gives it back (the SVG is the source of truth)', async () => {
    const source = { kind: 'svg' as const, text: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>', mode: 'line' as const, importer: 3 }
    const bytes = saveProject(base({ logo: { payload: square(8), source, personalisable: true } }))
    const names = (await readZip(bytes)).map(e => e.name)
    expect(names).toContain('store/logo.svg'); expect(names).toContain('store/logo.amdraw')
    const back = await loadProject(bytes, { baseKinds: ['mesh', 'drawing'] })
    expect(back.store!['logo']!.source).toEqual(source)
    expect(back.store!['logo']!.payload).toEqual(square(8))
    expect(listStore(back.store, back.list)[0]).toMatchObject({ name: 'logo', source: { kind: 'svg', mode: 'line' } })
  })
  it('refuses a damaged source, and counts the source text in the store budget', async () => {
    const good = { kind: 'svg' as const, text: '<svg/>', mode: 'fill' as const, importer: 1 }
    expect(storeProblem({ a: { payload: square(1), source: { ...good, mode: 'x' as 'fill' } } })).toMatchObject({ code: 'store.bad_entry' })
    expect(storeProblem({ a: { payload: square(1), source: { ...good, text: 'x'.repeat(2_000_001) } } })).toMatchObject({ code: 'store.bad_entry' })
    const withText = { payload: square(1), source: { ...good, text: 'x'.repeat(5000) } }
    expect(storeProblem({ a: withText }, { maxStoreBytes: payloadKinds.bytes(square(1)) + 4000 })).toMatchObject({ code: 'budget.store_bytes' })
    const bytes = saveProject(base({ logo: { payload: square(8), source: good } }))
    const files = new Map((await readZip(bytes)).map(e => [e.name, e.data]))
    expect(new TextDecoder().decode(files.get('store/logo.svg'))).toBe('<svg/>')
  })
  it('writes nothing for a project without a store, exactly as before', async () => {
    const bytes = saveProject(base())
    const back = await loadProject(bytes)
    expect(back.store).toBeUndefined()
  })

  it('a host that only knows meshes is not handed a drawing', async () => {
    const bytes = saveProject(base(logo()))
    await expect(loadProject(bytes)).rejects.toMatchObject({ code: 'import.invalid_project', params: { reason: 'store_kind_not_allowed' } })
    await expect(loadProject(bytes, { storeKinds: ['drawing'] })).resolves.toBeDefined()
  })

  it('refuses a bad name on save, and a store over the budget on load', async () => {
    expect(() => saveProject(base({ 'Bad Name': { payload: square(1) } }))).toThrow()
    const bytes = saveProject(base(logo()))
    await expect(loadProject(bytes, { baseKinds: ['mesh', 'drawing'], limits: { maxStoreBytes: 10 } })).rejects.toMatchObject({ params: { reason: 'bad_store' } })
  })
})

describe('listStore', () => {
  it('lists imported and produced entries, what each is, and which steps use them', async () => {
    const { reg } = setup()
    const l = list(sh('a', 'square', { size: 6 }), store('keep', 'outline'), sh('x', 'extrude'), sh('s1', 'stamp', { shape: 'outline' }), sh('s2', 'stamp', { shape: 'logo' }), sh('s3', 'stamp', { shape: 'ghost' }))
    const run = await runWorkflow(l, { registry: reg, store: logo(10) })
    const rows = listStore(logo(10), l, { registry: reg, results: run.results })
    expect(rows.map(r => [r.name, r.origin, r.kind, r.missing ?? false])).toEqual([['logo', 'project', 'drawing', false], ['outline', 'step', 'drawing', false], ['ghost', 'project', '', true]])
    expect(rows[0]!.size).toMatchObject({ paths: 1, points: 4 })
    expect(rows[0]!.usedBy).toEqual([{ step: 's2', param: 'shape' }])
    expect(rows[1]).toMatchObject({ step: 'keep', usedBy: [{ step: 's1', param: 'shape' }] })
    expect(rows[2]!.usedBy).toEqual([{ step: 's3', param: 'shape' }])
  })

  it('lists a produced entry without a size before the run has reached it', () => {
    const { reg } = setup()
    const rows = listStore(undefined, list(store('keep', 'o')), { registry: reg })
    expect(rows).toEqual([{ name: 'o', kind: '', origin: 'step', step: 'keep', usedBy: [] }])
  })

  it('counts a mesh by triangles and vertices', () => {
    const rows = listStore({ plate: { payload: boxMesh(1, 1, 1) } }, emptyStepList())
    expect(rows[0]!.size).toMatchObject({ triangles: 12, vertices: 8 })
  })
})

describe('conformance fixtures with drawings and a store', () => {
  it('start from a drawing, take a stored drawing, and check a drawing result', async () => {
    const { reg } = setup()
    const shift = await runFixture({ name: 'shift a drawing', input: square(10), steps: [sh('a', 'shift', { dx: 5 })], expect: { payload: { kind: 'drawing', paths: 1, points: 4, bounds: { value: [5, 0, 15, 10], tol: 1e-9 } } } }, { registry: reg })
    expect(shift.failures).toEqual([])
    const stamp = await runFixture({ name: 'stamp', input: { kind: 'generator', name: 'box' }, store: { logo: square(7) }, steps: [sh('s', 'stamp', { shape: 'logo' })], expect: { step_reports: [{ step: 0, key: 'shapeWidth', expect: 7 }] } }, { registry: reg })
    expect(stamp.failures).toEqual([])
    const wrong = await runFixture({ name: 'wrong', input: square(10), steps: [sh('a', 'shift')], expect: { payload: { kind: 'mesh' }, triangles: 12 } }, { registry: reg })
    expect(wrong.ok).toBe(false)
    expect(wrong.failures.join(' ')).toMatch(/result kind: expected mesh, got drawing/)
  })
})

describe('operationAvailability (the "Add a step" menu)', () => {
  const op = (kind: 'modifier' | 'generator', payload?: { in?: string; out?: string }, id = 'x') => ({ id, kind, ...(payload ? { payload } : {}) })
  it('a step takes what is there; another kind is disabled with a reason; nothing is hidden', () => {
    expect(operationAvailability('p', op('modifier'), { kind: 'mesh' })).toEqual({ state: 'available' })
    expect(operationAvailability('p', op('modifier'), {})).toEqual({ state: 'available' })           // unknown means a mesh
    expect(operationAvailability('p', op('modifier', { in: 'drawing', out: 'mesh' }), { kind: 'mesh' })).toEqual({ state: 'disabled', reason: 'needs.drawing' })
    expect(operationAvailability('p', op('modifier'), { kind: 'drawing' })).toEqual({ state: 'disabled', reason: 'needs.mesh' })
    expect(operationAvailability('p', op('modifier', { in: 'drawing' }), { kind: 'drawing' })).toEqual({ state: 'available' })
  })
  it('a generator and a step that takes anything are always available', () => {
    expect(operationAvailability('p', op('generator', { out: 'drawing' }), { kind: 'mesh' })).toEqual({ state: 'available' })
    expect(operationAvailability('p', op('modifier', { in: '*', out: '*' }), { kind: 'drawing' })).toEqual({ state: 'available' })
  })
  it('load needs something in the store; store does not', () => {
    const load = storeManifest.operations.find(o => o.id === 'load')!, put = storeManifest.operations.find(o => o.id === 'store')!
    expect(operationAvailability(STORE_PLUGIN_ID, load, { kind: 'mesh', storeEntries: 0 })).toEqual({ state: 'disabled', reason: 'needs.stored' })
    expect(operationAvailability(STORE_PLUGIN_ID, load, { kind: 'mesh', storeEntries: 2 })).toEqual({ state: 'available' })
    expect(operationAvailability(STORE_PLUGIN_ID, put, { kind: 'mesh', storeEntries: 0 })).toEqual({ state: 'available' })
  })
})

describe('operation importance and plugin icon (the "Add a step" menu)', () => {
  it('the manifest may say importance and icon; a bad value is refused', () => {
    const ok = { ...storeManifest, icon: 'spline' }
    expect(validateManifest(ok).ok).toBe(true)
    expect(validateManifest({ ...storeManifest, icon: 'Not An Icon' }).ok).toBe(false)
    const bad = { ...storeManifest, operations: storeManifest.operations.map(o => ({ ...o, importance: 'huge' })) }
    expect(JSON.stringify(validateManifest(bad).errors)).toContain('bad_operation_importance')
    expect(storeManifest.operations.every(o => o.importance === 'low')).toBe(true)
  })
})

describe('the default store budget', () => {
  it('is 20 items and 10 MB', () => {
    expect(DEFAULT_STORE_LIMITS).toEqual({ maxStoreEntries: 20, maxStoreBytes: 10 * 1024 * 1024 })
  })
  it('accepts 20 items and refuses a 21st; refuses a store over 10 MB', () => {
    const items = (n: number): ProjectStore => Object.fromEntries(Array.from({ length: n }, (_, i) => [`item_${i}`, { payload: square(1) }]))
    expect(storeProblem(items(20), DEFAULT_STORE_LIMITS)).toBeNull()
    expect(storeProblem(items(21), DEFAULT_STORE_LIMITS)).toMatchObject({ code: 'budget.store_entries', params: { entries: 21, max: 20 } })
    const big: Drawing = { kind: 'drawing', paths: [{ closed: true, points: Array.from({ length: 700_000 }, (_, i) => [i, i % 7] as [number, number]) }] }   // about 11 MB at 16 bytes a point
    expect(storeProblem({ big: { payload: big } }, DEFAULT_STORE_LIMITS)).toMatchObject({ code: 'budget.store_bytes' })
  })
})

describe('createRunner: running a list with no document', () => {
  const rt = () => { const { reg } = setup(); return { registry: reg, host: new InProcessHost(reg), assets: async () => new Uint8Array(0), maxTriangles: 1_000_000 } }
  it('runs a list on a source with a store, at export quality by default, and says so with a cache of its own', async () => {
    const r = createRunner(rt())
    const res = await r.runList(list(sh('s', 'stamp', { shape: 'logo' })), { source: boxMesh(10, 10, 10), store: logo(7) })
    expect(res.ok, JSON.stringify(res.results[0]?.error)).toBe(true)
    expect(res.results[0]!.report).toEqual({ shapePaths: 1, shapeWidth: 7 })
  })
  it('stops after the rollback marker', async () => {
    const r = createRunner(rt())
    const res = await r.runList(list(sh('a', 'square'), sh('b', 'shift'), sh('c', 'extrude')), { rollback: 'b' })
    expect(res.results.map(x => x.stepId)).toEqual(['a', 'b'])
    expect(res.ok).toBe(true)
  })
  it('refuses a store over the default budget (20 items) and takes the host\'s own budget', async () => {
    const many: ProjectStore = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`item_${i}`, { payload: square(1) }]))
    await expect(createRunner(rt()).runList(list(), { store: many })).rejects.toMatchObject({ code: 'budget.store_entries' })
    await expect(createRunner({ ...rt(), storeLimits: { maxStoreEntries: 30 } }).runList(list(), { store: many })).resolves.toBeDefined()
  })
  it('waits for plugins that are still loading before it runs', async () => {
    const { reg } = setup()
    let release!: () => void
    const ready = new Promise<void>(r => { release = r })
    const base = { registry: reg, host: new InProcessHost(reg), assets: async () => new Uint8Array(0), maxTriangles: 1_000_000, ready }
    let done = false
    const p = createRunner(base).runList(list(sh('a', 'square')), {}).then(r => { done = true; return r })
    await new Promise(r => setTimeout(r, 30))
    expect(done).toBe(false)
    release()
    expect((await p).ok).toBe(true)
  })
  it('shares a cache when given one, so a second run is answered from it', async () => {
    const cache = new MemoryCache()
    const a = createRunner({ ...rt(), cache }), b = createRunner({ ...rt(), cache })
    const l = list(sh('a', 'square'))
    await a.runList(l, {})
    expect((await b.runList(l, {})).fromCache).toBe(1)
  })
})

describe('the original model in the store', () => {
  const tp = (id: string, op: string, params: Record<string, unknown> = {}): Step => st(id, TEST_PLUGIN_ID, op, params)
  it('a Load step named original brings the model the project started from back, whatever the steps before did', async () => {
    const { reg } = setup()
    const src = boxMesh(10, 10, 10)
    const r = await runWorkflow(list(tp('a', 'scale', { factor: 3 }), load('l', ORIGINAL_NAME)), { registry: reg, source: src })
    expect(r.ok, JSON.stringify(r.results.map(x => x?.error))).toBe(true)
    expect(measureMesh(r.mesh as Mesh).bbox).toEqual(measureMesh(src).bbox)
  })
  it('a stored item of that name wins, and a Store step cannot take the name', async () => {
    const { reg } = setup()
    const own = boxMesh(1, 1, 1)
    const a = await runWorkflow(list(load('l', ORIGINAL_NAME)), { registry: reg, source: boxMesh(10, 10, 10), store: { [ORIGINAL_NAME]: { payload: own } } })
    expect(measureMesh(a.mesh as Mesh).bbox).toEqual(measureMesh(own).bbox)
    const b = await runWorkflow(list(store('s', ORIGINAL_NAME)), { registry: reg, source: boxMesh(10, 10, 10) })
    expect(b.results[0]?.error?.code).toBe('store.name_taken')
  })
  it('listStore shows it first, read only, and who uses it, only when the host asks', () => {
    const { reg } = setup()
    const l = list(load('l', ORIGINAL_NAME))
    const rows = listStore(undefined, l, { registry: reg, original: boxMesh(10, 10, 10) })
    expect(rows[0]).toMatchObject({ name: ORIGINAL_NAME, kind: 'mesh', origin: 'original', usedBy: [{ step: 'l', param: 'name' }] })
    expect(rows.some(r => r.missing)).toBe(false)
    expect(listStore(undefined, l, { registry: reg }).map(r => [r.name, r.missing])).toEqual([[ORIGINAL_NAME, true]])   // without the option it is as before: a name nothing provides
  })
})
