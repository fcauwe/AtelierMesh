import { describe, expect, it } from 'vitest'
import { InProcessHost, Registry, WorkerHost, addStep, applyRenames, emptyStepList, installWorkerEntry, loadProject, makeStep, runWorkflow, saveProject, validateManifest } from '../src'
import type { Manifest, PluginEntry, WorkerLike } from '../src'
import { TEST_PLUGIN_ID, boxMesh, createTestPlugin } from '../src/testing'

// A plugin published under a new id says which old ids it replaces: designs saved with the old id keep working.
const NEW_ID = 'be.example.scaler'
const migrate = (_from: string, params: Record<string, unknown>) => ({ factor: (params['scale'] as number) ?? 1 })
/** The test plugin as `be.example.scaler` 2.0.0, replacing the id the old designs were saved with. */
const renamed = (replaces: string[] = [TEST_PLUGIN_ID], version = '2.0.0'): PluginEntry => {
  const tp = createTestPlugin(version, { migrate })
  return { ...tp.entry, manifest: { ...tp.entry.manifest, id: NEW_ID, replaces } as Manifest }
}
const oldList = addStep(emptyStepList(), makeStep({ id: 's', plugin: { id: TEST_PLUGIN_ID, version: '1.0.0' }, op: 'scale', params: { scale: 3 } }))

describe('the manifest field `replaces`', () => {
  const base = (replaces: unknown): unknown => ({ ...renamed().manifest, replaces })
  const codes = (replaces: unknown): string[] => { const r = validateManifest(base(replaces) as Manifest); return r.ok ? [] : r.errors.map(e => `${e.code}:${String((e.params as { reason?: unknown } | undefined)?.reason)}`) }
  it('is a short list of other plugins\' ids', () => {
    expect(codes(['org.old.thing'])).toEqual([]); expect(codes([])).toEqual([])
    expect(codes('org.old.thing')).toEqual(['manifest.bad_replaces:not_a_list'])
    expect(codes(Array.from({ length: 9 }, (_, i) => `org.old.p${i}`))).toEqual(['manifest.bad_replaces:too_many'])
    expect(codes(['Not An Id'])).toEqual(['manifest.bad_replaces:bad_id']); expect(codes([42])).toEqual(['manifest.bad_replaces:bad_id'])
    expect(codes([NEW_ID])).toEqual(['manifest.bad_replaces:itself'])
    expect(codes(['org.old.thing', 'org.old.thing'])).toEqual(['manifest.bad_replaces:twice'])
  })
})

describe('the registry and a renamed plugin', () => {
  it('answers with the plugin that replaces an id, never renames an installed plugin, and forgets a plugin that is removed', () => {
    const reg = new Registry().register(renamed())
    expect(reg.canonicalId(TEST_PLUGIN_ID)).toBe(NEW_ID); expect(reg.canonicalId(NEW_ID)).toBe(NEW_ID); expect(reg.canonicalId('org.else.entirely')).toBe('org.else.entirely')
    expect(reg.has(TEST_PLUGIN_ID)).toBe(false)   // `has` is exact: the old id is not installed
    expect(reg.replacedIds(NEW_ID)).toEqual([TEST_PLUGIN_ID])
    reg.register(createTestPlugin().entry)            // now the old id IS installed: it stays itself
    expect(reg.canonicalId(TEST_PLUGIN_ID)).toBe(TEST_PLUGIN_ID)
    reg.unregister(NEW_ID); reg.unregister(TEST_PLUGIN_ID)
    expect(reg.canonicalId(TEST_PLUGIN_ID)).toBe(TEST_PLUGIN_ID)
  })
  it('lets the first registered of two replacements answer', () => {
    const a = renamed(), b = { ...renamed(), manifest: { ...renamed().manifest, id: 'be.example.other' } as Manifest }
    expect(new Registry().register(a).register(b).canonicalId(TEST_PLUGIN_ID)).toBe(NEW_ID)
  })
  it('rewrites the plugin id of the steps that were renamed, and gives the same list back when none was', () => {
    const reg = new Registry().register(renamed())
    const r = applyRenames(oldList, reg)
    expect(r.list.steps[0]!.plugin).toEqual({ id: NEW_ID, version: '1.0.0' }); expect(r.renamed).toEqual([{ id: 's', from: TEST_PLUGIN_ID, to: NEW_ID }])
    expect(oldList.steps[0]!.plugin.id).toBe(TEST_PLUGIN_ID)   // the input is not changed
    const same = applyRenames(r.list, reg); expect(same.list).toBe(r.list); expect(same.renamed).toEqual([])
  })
})

describe('a design saved under the old id', () => {
  it('runs with the new plugin, through its migration, and says it was renamed', async () => {
    const registry = new Registry().register(renamed())
    const r = await runWorkflow(oldList, { registry, host: new InProcessHost(registry), source: boxMesh(10, 10, 10) })
    expect(r.ok, JSON.stringify(r.results[0]?.error)).toBe(true)
    expect(r.results[0]!.renamedFrom).toBe(TEST_PLUGIN_ID); expect(r.results[0]!.migratedFrom).toBe('1.0.0')
  })
  it('is not renamed when the old plugin is installed too', async () => {
    const registry = new Registry().register(renamed()).register(createTestPlugin('1.0.0').entry)
    const r = await runWorkflow(oldList, { registry, host: new InProcessHost(registry), source: boxMesh(10, 10, 10) })
    expect(r.results[0]!.renamedFrom).toBeUndefined()
  })
  it('stops with step.version_newer when the old design is newer than the plugin that replaces it', async () => {
    const registry = new Registry().register(renamed([TEST_PLUGIN_ID], '0.5.0'))
    const r = await runWorkflow(oldList, { registry, host: new InProcessHost(registry), source: boxMesh(10, 10, 10) })
    expect(r.results[0]!.error?.code).toBe('step.version_newer'); expect(registry.isEnabled(NEW_ID)).toBe(true)
  })
  it('runs in a worker host, where the page cannot load the plugin\'s code: the migration happens in the worker', async () => {
    const page = new Registry().register({ ...renamed(), load: () => { throw new Error('runs in the worker, not on the page') } })
    let toWorker: (d: unknown) => void = () => undefined, toMain: (d: unknown) => void = () => undefined
    const worker = (): WorkerLike => {
      installWorkerEntry(new Registry().register(renamed()), { postMessage: m => { queueMicrotask(() => toMain(m)) }, onMessage: cb => { toWorker = cb } })
      return { postMessage: m => { queueMicrotask(() => toWorker(m)) }, terminate: () => undefined, onMessage: cb => { toMain = cb }, onError: () => undefined }
    }
    const r = await runWorkflow(oldList, { registry: page, host: new WorkerHost(() => worker()), source: boxMesh(10, 10, 10) })
    expect(r.ok, JSON.stringify(r.results[0]?.error)).toBe(true); expect(r.results[0]!.renamedFrom).toBe(TEST_PLUGIN_ID)
  })
  it('is opened with the new id, and is not "missing a plugin"', async () => {
    const registry = new Registry().register(renamed())
    const bytes = saveProject({ name: 'p', base: boxMesh(10, 10, 10), list: oldList, rollback: null, assets: [] })
    const p = await loadProject(bytes, { registry })
    expect(p.missingPlugins).toEqual([]); expect(p.renamedPlugins).toEqual([{ id: 's', from: TEST_PLUGIN_ID, to: NEW_ID }])
    expect(p.list.steps[0]!.plugin.id).toBe(NEW_ID)
    // without the plugin that replaces it, it is missing the old one, as before
    const none = await loadProject(bytes, { registry: new Registry() })
    expect(none.missingPlugins).toEqual([TEST_PLUGIN_ID]); expect(none.renamedPlugins).toEqual([])
  })
})
