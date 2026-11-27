import { InProcessHost, MeshError, Registry, WorkerHost, addStep, emptyStepList, fromWebWorker, makeStep, measureMesh, payloadKindOf, runWorkflow } from '@ateliermesh/core'
import type { ProjectStore } from '@ateliermesh/core'
import { boxMesh } from '@ateliermesh/core/testing'
import { fetchPluginBytes, packageEntry, probePackage, readPluginPackage, workerFactory, withPackageAssets } from '../../src'
import type { LoadedPackage } from '../../src'
import { createFontService } from '../../../plugins/src/emboss/outlines'

const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), c => c.charCodeAt(0))
void InProcessHost; void MeshError

const api = {
  async run(b64: string, op: string, params: Record<string, unknown>, opts: { timeoutMs?: number; assets?: boolean; fontB64?: string; store?: ProjectStore; noSource?: boolean } = {}) {
    const pkg = await readPluginPackage(unb64(b64), { origin: 'test' })
    const packages = new Map<string, LoadedPackage>([[pkg.manifest.id, pkg]])
    // the page hands over plain JSON: a mesh entry gets its typed arrays back here
    const store = opts.store ? Object.fromEntries(Object.entries(opts.store).map(([k, e]) => { const p = e.payload as unknown as { positions?: number[]; indices?: number[] }; return [k, p.positions && p.indices ? { ...e, payload: { positions: Float64Array.from(p.positions), indices: Uint32Array.from(p.indices) } } : e] })) as ProjectStore : undefined
    const registry = new Registry().register(packageEntry(pkg))
    const host = new WorkerHost(workerFactory(() => { throw new Error('no built-in worker here') }, packages), { graceMs: 200 })
    const list = addStep(emptyStepList(), makeStep({ id: 's', plugin: { id: pkg.manifest.id, version: pkg.manifest.version }, op, params }))
    const t0 = performance.now()
    const r = await runWorkflow(list, { registry, host, ...(opts.noSource ? {} : { source: boxMesh(10, 10, 10) }), ...(store ? { store } : {}), assets: withPackageAssets(async () => { throw new Error('no app assets') }, packages), ...(opts.fontB64 ? { fonts: createFontService(async () => unb64(opts.fontB64 as string)) } : {}), limits: { stepTimeoutMs: opts.timeoutMs ?? 20000 } })
    const res = r.results[0]!
    return { status: res.status, error: res.error ?? null, report: res.report ?? null, payloadKind: res.payload ? payloadKindOf(res.payload) : null, paths: res.payload && payloadKindOf(res.payload) === 'drawing' ? (res.payload as { paths: unknown[] }).paths.length : null, volume: res.mesh ? measureMesh(res.mesh).volume : null, ms: performance.now() - t0, iframes: document.querySelectorAll('iframe').length }
  },
  async probe(b64: string) { return probePackage(await readPluginPackage(unb64(b64), { origin: 'test' }), { timeoutMs: 6000 }).then(r => ({ ...r, iframes: document.querySelectorAll('iframe').length })) },
  async pageAlive() { return await new Promise<number>(r => setTimeout(() => r(Date.now()), 10)) },
  async pinned(url: string) {
    try { await fetchPluginBytes(url); return 'fetched' } catch (e) { return e instanceof MeshError ? `${e.code}:${String(e.params['reason'])}` : String(e) }
  },
  fromWebWorker,
}
;(window as unknown as { __ld: typeof api }).__ld = api
