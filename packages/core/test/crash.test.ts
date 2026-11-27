import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Registry, WorkerHost, addStep, emptyStepList, fromNodeWorker, makeStep, runWorkflow, MeshError } from '../src'
import type { PluginCrash, Step } from '../src'
import { boxMesh, createTestPlugin, TEST_PLUGIN_ID } from '../src/testing'

const st = (id: string, op: string, params: Record<string, unknown> = {}): Step => makeStep({ id, plugin: { id: TEST_PLUGIN_ID, version: '1.0.0' }, op, params })
const list = (...s: Step[]) => s.reduce((l, x) => addStep(l, x), emptyStepList())
const src = boxMesh(10, 10, 10)

describe('a plugin that crashes (in this thread)', () => {
  it('returns plugin.crashed with the plugin, step and first line, and switches the plugin off', async () => {
    const registry = new Registry().register(createTestPlugin().entry)
    const seen: PluginCrash[] = []
    const r = await runWorkflow(list(st('a', 'scale', { factor: 2 }), st('c', 'crash'), st('b', 'scale')), { registry, source: src, onPluginCrash: c => seen.push(c) })
    expect(r.results.map(x => x.status)).toEqual(['ok', 'error', 'stale'])
    const e = r.results[1]!.error!
    expect(e.code).toBe('plugin.crashed')
    expect(e.params).toMatchObject({ plugin: TEST_PLUGIN_ID, version: '1.0.0', op: 'crash', step: 'c', phase: 'run', message: 'ReferenceError: voronoiPlugin is not defined', name: 'Test plugin' })
    expect(r.results[0]!.mesh).toBeDefined()               // the step before keeps its result
    expect(r.crashedPlugins).toHaveLength(1)
    expect(registry.isEnabled(TEST_PLUGIN_ID)).toBe(false)
    expect(registry.disabledPlugins()[TEST_PLUGIN_ID]).toMatchObject({ reason: 'ReferenceError: voronoiPlugin is not defined', crashed: true })
    await Promise.resolve()
    expect(seen).toHaveLength(1)
  })
  it('the next run says plugin.disabled and does not run the plugin; switching it on again runs it', async () => {
    const tp = createTestPlugin(); const registry = new Registry().register(tp.entry)
    await runWorkflow(list(st('c', 'crash')), { registry, source: src })
    const before = tp.calls['scale'] ?? 0
    const r = await runWorkflow(list(st('a', 'scale', { factor: 2 })), { registry, source: src })
    expect(r.results[0]!.error).toMatchObject({ code: 'plugin.disabled', params: { plugin: TEST_PLUGIN_ID, op: 'scale', step: 'a', crashed: true } })
    expect(tp.calls['scale'] ?? 0).toBe(before)
    registry.setEnabled(TEST_PLUGIN_ID, true)
    expect((await runWorkflow(list(st('a', 'scale', { factor: 2 })), { registry, source: src })).ok).toBe(true)
  })
  it('a plugin that fails to load is a crash in the load phase, and a retry after switching on loads again', async () => {
    let attempts = 0
    const entry = { ...createTestPlugin().entry, load: () => { attempts++; if (attempts === 1) throw new SyntaxError('Unexpected token }'); return createTestPlugin().entry.load() } }
    const registry = new Registry().register(entry)
    const r = await runWorkflow(list(st('a', 'scale')), { registry, source: src })
    expect(r.results[0]!.error).toMatchObject({ code: 'plugin.crashed', params: { phase: 'load', message: 'SyntaxError: Unexpected token }' } })
    registry.setEnabled(TEST_PLUGIN_ID, true)
    expect((await runWorkflow(list(st('a', 'scale')), { registry, source: src })).ok).toBe(true)
    expect(attempts).toBe(2)
  })
  it('keeps only the first line of the message', async () => {
    const registry = new Registry().register(createTestPlugin().entry)
    const r = await runWorkflow(list(st('d', 'die')), { registry, source: src })
    expect(r.results[0]!.error?.params?.['message']).toBe('TypeError: Cannot read properties of undefined (reading \'x\')')
  })
  it('the plugin\'s own errors, cancellations and timeouts do not crash it', async () => {
    const registry = new Registry().register(createTestPlugin().entry)
    expect((await runWorkflow(list(st('f', 'fail')), { registry, source: src })).results[0]!.error?.code).toBe('test.deliberate')
    const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 50)
    expect((await runWorkflow(list(st('w', 'slow', { ms: 3000 })), { registry, source: src, signal: ctrl.signal })).results[0]!.status).toBe('cancelled')
    const t = await runWorkflow(list(st('w', 'slow', { ms: 3000 })), { registry, source: src, limits: { stepTimeoutMs: 80 } })
    expect(t.results[0]!.error?.code).toBe('run.timeout')
    expect(registry.isEnabled(TEST_PLUGIN_ID)).toBe(true)
    expect(registry.disabledPlugins()).toEqual({})
  })
  it('deactivateOnCrash: false leaves the decision to the host', async () => {
    const registry = new Registry().register(createTestPlugin().entry)
    const r = await runWorkflow(list(st('c', 'crash')), { registry, source: src, deactivateOnCrash: false })
    expect(r.crashedPlugins).toHaveLength(1)
    expect(registry.isEnabled(TEST_PLUGIN_ID)).toBe(true)
  })
  it('only the crashing plugin is switched off; another plugin keeps working', async () => {
    const other = createTestPlugin()
    const second = { manifest: { ...other.entry.manifest, id: 'test.other', name: 'Other' }, load: other.entry.load }
    const registry = new Registry().register(createTestPlugin().entry).register(second)
    const l = addStep(list(st('c', 'crash')), makeStep({ id: 'o', plugin: { id: 'test.other', version: '1.0.0' }, op: 'box' }))
    await runWorkflow(l, { registry, source: src })
    expect(registry.isEnabled('test.other')).toBe(true)
    expect(registry.isEnabled(TEST_PLUGIN_ID)).toBe(false)
    expect((await runWorkflow(list(makeStep({ id: 'o', plugin: { id: 'test.other', version: '1.0.0' }, op: 'box' })), { registry })).ok).toBe(true)
  })
  it('the error has the same shape every time (a stable code and the same parameters)', async () => {
    const shape = async () => { const r = await runWorkflow(list(st('c', 'crash')), { registry: new Registry().register(createTestPlugin().entry), source: src }); return r.results[0]!.error }
    expect(await shape()).toEqual(await shape())
  })
  it('subscribers hear about switching off and on', () => {
    const registry = new Registry().register(createTestPlugin().entry)
    let n = 0; const stop = registry.subscribe(() => n++)
    const v = registry.version
    registry.setEnabled(TEST_PLUGIN_ID, false, 'x'); registry.setEnabled(TEST_PLUGIN_ID, false, 'x'); registry.setEnabled(TEST_PLUGIN_ID, true)
    expect(n).toBe(2); expect(registry.version).toBe(v + 2)
    stop(); registry.setEnabled(TEST_PLUGIN_ID, false); expect(n).toBe(2)
    expect(registry.setEnabled('nope.x', false)).toBe(false)
  })
  it('a MeshError thrown by the plugin is not a crash', async () => {
    const entry = { ...createTestPlugin().entry, load: () => ({ run: () => { throw new MeshError('test.mine', { a: 1 }) } }) }
    const registry = new Registry().register(entry)
    const r = await runWorkflow(list(st('a', 'scale')), { registry, source: src })
    expect(r.results[0]!.error?.code).toBe('test.mine')
    expect(registry.isEnabled(TEST_PLUGIN_ID)).toBe(true)
  })
})

describe('a plugin that crashes in a worker thread', () => {
  let dir = '', file = '', badFile = ''
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'am-crash-'))
    file = join(dir, 'worker.mjs')
    await build({ entryPoints: [join(__dirname, 'fixtures/worker-entry.ts')], bundle: true, platform: 'node', format: 'esm', outfile: file, logLevel: 'silent' })
    // a worker whose code is broken: it dies on start, before it can answer
    badFile = join(dir, 'dead.mjs'); writeFileSync(badFile, 'throw new Error("sandbox error: the worker failed to start\\nat line 2")\n')
  })
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
  const host = (f: () => string) => new WorkerHost(() => fromNodeWorker(new Worker(f())), { graceMs: 300 })

  it('an exception inside the plugin comes back as plugin.crashed (phase run) and the plugin is switched off', async () => {
    const registry = new Registry().register(createTestPlugin().entry)
    const r = await runWorkflow(list(st('a', 'scale', { factor: 2 }), st('c', 'crash')), { registry, host: host(() => file), source: src })
    expect(r.results[0]!.status).toBe('ok')
    expect(r.results[1]!.error).toMatchObject({ code: 'plugin.crashed', params: { phase: 'run', op: 'crash', step: 'c', message: 'ReferenceError: voronoiPlugin is not defined' } })
    expect(registry.isEnabled(TEST_PLUGIN_ID)).toBe(false)
  })
  it('a worker that dies is plugin.crashed (phase worker) with the first line', async () => {
    const registry = new Registry().register(createTestPlugin().entry)
    const r = await runWorkflow(list(st('a', 'scale')), { registry, host: host(() => badFile), source: src })
    expect(r.results[0]!.error).toMatchObject({ code: 'plugin.crashed', params: { phase: 'worker', message: 'sandbox error: the worker failed to start' } })
    expect(registry.isEnabled(TEST_PLUGIN_ID)).toBe(false)
  })
  it('cancelling a stubborn plugin does not switch it off', async () => {
    const registry = new Registry().register(createTestPlugin().entry)
    const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 100)
    const r = await runWorkflow(list(st('x', 'stubborn', { ms: 5000 })), { registry, host: host(() => file), source: src, signal: ctrl.signal })
    expect(r.results[0]!.status).toBe('cancelled')
    expect(registry.isEnabled(TEST_PLUGIN_ID)).toBe(true)
  })
})
