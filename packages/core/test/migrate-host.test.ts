import { describe, expect, it } from 'vitest'
import { InProcessHost, Registry, WorkerHost, addStep, emptyStepList, installWorkerEntry, makeStep, runWorkflow } from '../src'
import type { WorkerLike } from '../src'
import { TEST_PLUGIN_ID, boxMesh, createTestPlugin } from '../src/testing'

// A plugin updated to a newer version: the projects saved with the older one must keep working. Where the plugin's code lives decides where its migration runs: in a worker host
// (the Atelier's) the page cannot load the code, so asking it to would fail and switch the plugin off.
const tp = createTestPlugin('1.2.0', { migrate: (_from, params) => ({ factor: (params['scale'] as number) ?? 1 }) })
const oldList = addStep(emptyStepList(), makeStep({ id: 's', plugin: { id: TEST_PLUGIN_ID, version: '1.0.0' }, op: 'scale', params: { scale: 3 } }))
const pageRegistry = (): Registry => new Registry().register({ ...tp.entry, load: () => { throw new Error(`the code of ${TEST_PLUGIN_ID} runs in the worker, not on the page`) } })

/** A worker in this thread: the worker side is the real `installWorkerEntry` with the real plugin, the page side is the stub above. */
const inMemoryWorker = (): WorkerLike => {
  let toWorker: (d: unknown) => void = () => undefined, toMain: (d: unknown) => void = () => undefined
  installWorkerEntry(new Registry().register(tp.entry), { postMessage: m => { queueMicrotask(() => toMain(m)) }, onMessage: cb => { toWorker = cb } })
  return { postMessage: m => { queueMicrotask(() => toWorker(m)) }, terminate: () => undefined, onMessage: cb => { toMain = cb }, onError: () => undefined }
}

describe('migration where the plugin code lives', () => {
  it('runs in the worker: an old project works after a plugin upgrade although the page cannot load the code', async () => {
    const registry = pageRegistry()
    const host = new WorkerHost(() => inMemoryWorker())
    const r = await runWorkflow(oldList, { registry, host, source: boxMesh(10, 10, 10) })
    expect(r.ok, JSON.stringify(r.results[0]?.error)).toBe(true)
    expect(r.results[0]!.migratedFrom).toBe('1.0.0')
    expect(registry.isEnabled(TEST_PLUGIN_ID)).toBe(true); expect(r.crashedPlugins).toEqual([])
    const again = await runWorkflow(oldList, { registry, host, source: boxMesh(10, 10, 10) })   // the editor runs on every change: same answer
    expect(again.ok).toBe(true)
  })

  it('a host that cannot migrate marks that step; it is not a crash and the plugin stays on', async () => {
    const registry = pageRegistry()
    const r = await runWorkflow(oldList, { registry, host: new InProcessHost(registry), source: boxMesh(10, 10, 10) })
    expect(r.ok).toBe(false)
    expect(r.results[0]!.error?.code).toBe('step.migration_failed')
    expect(r.results[0]!.error?.params).toMatchObject({ plugin: TEST_PLUGIN_ID, from: '1.0.0', installed: '1.2.0' })
    expect(registry.isEnabled(TEST_PLUGIN_ID)).toBe(true); expect(r.crashedPlugins).toEqual([])
  })

  it('in the same thread the migration still runs through the registry, as before', async () => {
    const registry = new Registry().register(tp.entry)
    const r = await runWorkflow(oldList, { registry, host: new InProcessHost(registry), source: boxMesh(10, 10, 10) })
    expect(r.ok).toBe(true); expect(r.results[0]!.migratedFrom).toBe('1.0.0')
  })
})

describe('an error thrown by a plugin that bundled its own copy of MeshError', () => {
  // the class of the bundled copy is not `instanceof` the host's: it must still be the plugin's own, meant error, not a crash that switches the plugin off
  class BundledMeshError extends Error {
    readonly code: string; readonly params: Record<string, unknown>
    constructor(code: string, params: Record<string, unknown> = {}) { super(code); this.name = 'MeshError'; this.code = code; this.params = params }
  }
  it('keeps its code and leaves the plugin on', async () => {
    const entry = createTestPlugin('1.0.0', { async run() { throw new BundledMeshError('cheese.bad_input', { why: 'open' }) } }).entry
    const registry = new Registry().register(entry)
    const l = addStep(emptyStepList(), makeStep({ id: 's', plugin: { id: TEST_PLUGIN_ID, version: '1.0.0' }, op: 'scale', params: { factor: 1 } }))
    const r = await runWorkflow(l, { registry, host: new InProcessHost(registry), source: boxMesh(10, 10, 10) })
    expect(r.ok).toBe(false)
    expect(r.results[0]!.error).toEqual({ code: 'cheese.bad_input', params: { why: 'open' } })
    expect(registry.isEnabled(TEST_PLUGIN_ID)).toBe(true); expect(r.crashedPlugins).toEqual([])
  })
  it('and a plain Error is still a crash', async () => {
    const entry = createTestPlugin('1.0.0', { async run() { throw new Error('boom') } }).entry
    const registry = new Registry().register(entry)
    const l = addStep(emptyStepList(), makeStep({ id: 's', plugin: { id: TEST_PLUGIN_ID, version: '1.0.0' }, op: 'scale', params: { factor: 1 } }))
    const r = await runWorkflow(l, { registry, host: new InProcessHost(registry), source: boxMesh(10, 10, 10) })
    expect(r.results[0]!.error?.code).toBe('plugin.crashed'); expect(registry.isEnabled(TEST_PLUGIN_ID)).toBe(false)
  })
})
