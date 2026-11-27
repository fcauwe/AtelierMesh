// Running plugins in a worker. The package never creates a worker itself (that breaks in the Vite dev server, spike S2b):
// the host creates one and hands it in as a `WorkerLike`. The same protocol works for browser Web Workers and Node worker threads.
import { MeshError, crashError, isUnexpected, toStructured } from './errors'
import type { StructuredError } from './errors'
import { abortReason, applyMigration } from './host'
import { noFonts } from './host'
import type { MigrateRequest, MigrateResult, PluginHost, RunHooks, RunRequest } from './host'
import type { Registry } from './registry'
import { isMesh } from './payload'
import type { FontOutlineOptions, FontOutlines, LogLevel, Mesh, Payload, Quality, RunContext, RunResult } from './types'

/** The part of a worker the main thread needs. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void
  terminate(): unknown
  onMessage(cb: (data: unknown) => void): void
  onError(cb: (error: unknown) => void): void
}

/** The part of the worker's own scope the worker side needs. */
export interface WorkerScope {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void
  onMessage(cb: (data: unknown) => void): void
}

// ---- adapters (structural types, so this file needs no DOM or Node typings)

export interface WebWorkerLike {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void
  terminate(): void
  addEventListener(type: 'message' | 'error' | 'messageerror', cb: (e: { data?: unknown; message?: string }) => void): void
}
export function fromWebWorker(w: WebWorkerLike): WorkerLike {
  return {
    postMessage: (m, t) => w.postMessage(m, t),
    terminate: () => w.terminate(),
    onMessage: cb => w.addEventListener('message', e => cb(e.data)),
    onError: cb => { w.addEventListener('error', e => cb(e)); w.addEventListener('messageerror', e => cb(e)) },
  }
}

export interface NodeWorkerLike {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void
  terminate(): unknown
  on(event: 'message' | 'error', cb: (value: unknown) => void): unknown
}
export function fromNodeWorker(w: NodeWorkerLike): WorkerLike {
  return { postMessage: (m, t) => w.postMessage(m, t), terminate: () => w.terminate(), onMessage: cb => { w.on('message', cb) }, onError: cb => { w.on('error', cb) } }
}

export function scopeFromWebWorker(s: { postMessage(m: unknown, t?: ArrayBuffer[]): void; addEventListener(type: 'message', cb: (e: { data: unknown }) => void): void }): WorkerScope {
  return { postMessage: (m, t) => s.postMessage(m, t), onMessage: cb => s.addEventListener('message', e => cb(e.data)) }
}
export function scopeFromNodePort(p: { postMessage(m: unknown, t?: ArrayBuffer[]): void; on(event: 'message', cb: (value: unknown) => void): unknown }): WorkerScope {
  return { postMessage: (m, t) => p.postMessage(m, t), onMessage: cb => { p.on('message', cb) } }
}

// ---- protocol

interface WireMesh { positions: Float64Array; indices: Uint32Array; groups?: Mesh['groups']; segments?: Mesh['segments'] }

type ToWorker =
  | { t: 'run'; id: number; pluginId: string; op: string; params: Record<string, unknown>; mesh?: WireMesh; payload?: Payload; payloads?: Record<string, Payload>; quality: Quality }
  | { t: 'cancel'; id: number; reason: StructuredError }
  | { t: 'migrate'; id: number; pluginId: string; fromVersion: string; op: string; params: Record<string, unknown> }
  | { t: 'asset-reply'; rid: number; bytes?: Uint8Array; error?: StructuredError }
  | { t: 'font-reply'; rid: number; outlines?: FontOutlines; error?: StructuredError }

type FromWorker =
  | { t: 'progress'; id: number; stage: string; fraction: number }
  | { t: 'log'; id: number; level: LogLevel; message: string }
  | { t: 'asset-request'; id: number; rid: number; assetId: string }
  | { t: 'font-request'; id: number; rid: number; fontId: string; text: string; options: FontOutlineOptions }
  | { t: 'result'; id: number; mesh?: WireMesh; payload?: Payload; report?: Record<string, unknown>; warnings?: StructuredError[] }
  | { t: 'migrated'; id: number; op: string; params: Record<string, unknown> }
  | { t: 'error'; id: number; error: StructuredError }

const copyMesh = (m: Mesh): WireMesh => ({
  positions: m.positions.slice(), indices: m.indices.slice(),
  ...(m.groups ? { groups: m.groups } : {}),
  ...(m.segments ? { segments: { labels: m.segments.labels.slice(), table: m.segments.table } } : {}),
})

function uniqueBuffers(m: WireMesh | undefined): ArrayBuffer[] {
  if (!m) return []
  return [...new Set<ArrayBuffer>([m.positions.buffer as ArrayBuffer, m.indices.buffer as ArrayBuffer, ...(m.segments ? [m.segments.labels.buffer as ArrayBuffer] : [])])]
}

/** The font options a plugin sent, checked and rounded into range; null when something is not a number or a known word. */
function cleanFontOptions(o: unknown): FontOutlineOptions | null {
  if (typeof o !== 'object' || o === null) return null
  const r = o as Record<string, unknown>
  const num = (v: unknown, lo: number, hi: number): number | undefined | null => (v === undefined ? undefined : typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null)
  const size = num(r['size'], 0.1, 1000), weight = num(r['weight'], 1, 1000), spacing = num(r['letterSpacing'], -100, 100), line = num(r['lineSpacing'], 0.2, 10), maxWidth = num(r['maxWidth'], 0.1, 10000), tol = num(r['tolerance'], 0.001, 1)
  if (size === undefined || size === null || weight === null || spacing === null || line === null || maxWidth === null || tol === null) return null
  const align = r['align'] === 'center' || r['align'] === 'right' ? r['align'] : r['align'] === undefined || r['align'] === 'left' ? 'left' : null
  const a = r['anchor'] as { h?: unknown; v?: unknown } | undefined
  const anchor: FontOutlineOptions['anchor'] | undefined | null = a === undefined ? undefined : (a.h === 'left' || a.h === 'center' || a.h === 'right') && (a.v === 'baseline' || a.v === 'middle') ? { h: a.h, v: a.v } : null
  if (align === null || anchor === null) return null
  return { size, ...(weight !== undefined ? { weight } : {}), ...(spacing !== undefined ? { letterSpacing: spacing } : {}), ...(line !== undefined ? { lineSpacing: line } : {}), align, ...(maxWidth !== undefined ? { maxWidth } : {}), ...(tol !== undefined ? { tolerance: tol } : {}), ...(anchor ? { anchor } : {}) }
}

const asError = (e: StructuredError): MeshError => new MeshError(e.code, e.params ?? {}, e.path)

// ---- main thread

export interface WorkerHostOptions {
  /** After a cancel request, how long the plugin gets to stop by itself before the worker is terminated. Default 1500 ms. */
  graceMs?: number
}

/**
 * Runs each operation in a fresh worker (no state is shared between runs). The input mesh is copied, so the cached
 * original stays usable; the result mesh is transferred back without copying.
 */
export class WorkerHost implements PluginHost {
  /** `create` gets the plugin id, so built-in and external plugins can run in different kinds of worker. */
  constructor(private readonly create: (pluginId: string) => WorkerLike, private readonly opts: WorkerHostOptions = {}) {}

  /** The plugin's migration runs in a worker too, where its code is: the page cannot load it. */
  migrate(req: MigrateRequest, signal?: AbortSignal): Promise<MigrateResult> {
    return new Promise<MigrateResult>((resolve, reject) => {
      if (signal?.aborted) return reject(abortReason(signal))
      const worker = this.create(req.pluginId)
      let done = false
      const onAbort = (): void => finish(() => reject(abortReason(signal as AbortSignal)))
      const finish = (settle: () => void): void => {
        if (done) return
        done = true
        signal?.removeEventListener('abort', onAbort)
        try { void worker.terminate() } catch { /* already gone */ }
        settle()
      }
      signal?.addEventListener('abort', onAbort)
      worker.onMessage(data => {
        const m = data as FromWorker
        if (done || !m || typeof m !== 'object') return
        if (m.t === 'migrated') finish(() => resolve({ op: String(m.op), params: m.params }))
        else if (m.t === 'error') finish(() => reject(asError(m.error)))
      })
      worker.onError(e => finish(() => reject(crashError('worker', e))))
      worker.postMessage({ t: 'migrate', id: 1, pluginId: req.pluginId, fromVersion: req.fromVersion, op: req.op, params: req.params } satisfies ToWorker)
    })
  }

  run(req: RunRequest, hooks: RunHooks): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
      if (hooks.signal.aborted) return reject(abortReason(hooks.signal))
      const worker = this.create(req.pluginId)
      const id = 1
      let done = false
      let grace: ReturnType<typeof setTimeout> | undefined
      const finish = (settle: () => void): void => {
        if (done) return
        done = true
        if (grace !== undefined) clearTimeout(grace)
        hooks.signal.removeEventListener('abort', onAbort)
        try { void worker.terminate() } catch { /* already gone */ }
        settle()
      }
      const onAbort = (): void => {
        if (done) return
        worker.postMessage({ t: 'cancel', id, reason: abortReason(hooks.signal).toJSON() } satisfies ToWorker)
        grace = setTimeout(() => finish(() => reject(abortReason(hooks.signal))), this.opts.graceMs ?? 1500)
      }
      hooks.signal.addEventListener('abort', onAbort)
      worker.onMessage(data => {
        const m = data as FromWorker
        if (done || !m || typeof m !== 'object') return
        switch (m.t) {
          case 'progress': hooks.onProgress?.(m.stage, m.fraction); break
          case 'log': hooks.onLog?.(m.level, m.message); break
          case 'asset-request':
            hooks.assets(m.assetId).then(
              bytes => { const copy = bytes.slice(); if (!done) worker.postMessage({ t: 'asset-reply', rid: m.rid, bytes: copy } satisfies ToWorker, [copy.buffer as ArrayBuffer]) },
              (e: unknown) => { if (!done) worker.postMessage({ t: 'asset-reply', rid: m.rid, error: toStructured(e, 'plugin.failed', { asset: m.assetId }) } satisfies ToWorker) },
            )
            break
          case 'font-request': {
            // the options come from a plugin that may be hostile: only plain numbers and the two small enums are passed on
            const o = cleanFontOptions(m.options)
            const text = typeof m.text === 'string' ? m.text : ''
            const fonts = hooks.fonts ?? noFonts
            Promise.resolve().then(() => { if (!o) throw new MeshError('fonts.bad_options'); return fonts(String(m.fontId), text, o) }).then(
              outlines => { if (!done) worker.postMessage({ t: 'font-reply', rid: m.rid, outlines } satisfies ToWorker) },
              (e: unknown) => { if (!done) worker.postMessage({ t: 'font-reply', rid: m.rid, error: toStructured(e, 'plugin.failed', { font: String(m.fontId) }) } satisfies ToWorker) },
            )
            break
          }
          case 'result': {
            // a plugin that answers with something that is not a mesh has crashed, even if its worker is alive
            const bad = (m.mesh !== undefined && !(m.mesh && m.mesh.positions instanceof Float64Array && m.mesh.indices instanceof Uint32Array))
              || (m.payload !== undefined && !(typeof m.payload === 'object' && m.payload !== null && typeof (m.payload as { kind?: unknown }).kind === 'string'))
            if (bad) finish(() => reject(crashError('worker', new Error('the result could not be read'))))
            else finish(() => resolve({ mesh: m.mesh as Mesh | undefined, ...(m.payload !== undefined ? { payload: m.payload } : {}), report: m.report, warnings: m.warnings }))
            break
          }
          case 'error': finish(() => reject(asError(m.error))); break
        }
      })
      worker.onError(e => finish(() => reject(crashError('worker', e))))
      const mesh = req.mesh ? copyMesh(req.mesh) : undefined
      worker.postMessage({ t: 'run', id, pluginId: req.pluginId, op: req.op, params: req.params, mesh, ...(req.payload !== undefined && !req.mesh ? { payload: req.payload } : {}), ...(req.payloads && Object.keys(req.payloads).length > 0 ? { payloads: req.payloads } : {}), quality: req.quality } satisfies ToWorker, uniqueBuffers(mesh))
    })
  }
}

// ---- worker side

/** Call this from the worker's entry file with the same registry the main thread uses (or one with the same plugins). */
export function installWorkerEntry(registry: Registry, scope: WorkerScope): void {
  const running = new Map<number, AbortController>()
  const pending = new Map<number, { resolve: (b: Uint8Array) => void; reject: (e: unknown) => void }>()
  const pendingFonts = new Map<number, { resolve: (o: FontOutlines) => void; reject: (e: unknown) => void }>()
  let nextRid = 1

  scope.onMessage(data => {
    const msg = data as ToWorker
    if (!msg || typeof msg !== 'object') return
    if (msg.t === 'cancel') { running.get(msg.id)?.abort(asError(msg.reason)); return }
    if (msg.t === 'asset-reply') {
      const p = pending.get(msg.rid); pending.delete(msg.rid)
      if (!p) return
      if (msg.error) p.reject(asError(msg.error)); else p.resolve(msg.bytes ?? new Uint8Array(0))
      return
    }
    if (msg.t === 'font-reply') {
      const p = pendingFonts.get(msg.rid); pendingFonts.delete(msg.rid)
      if (!p) return
      if (msg.error || !msg.outlines) p.reject(asError(msg.error ?? { code: 'fonts.unavailable' })); else p.resolve(msg.outlines)
      return
    }
    if (msg.t === 'migrate') {
      const { id } = msg
      void (async () => {
        try {
          let mod
          try { mod = await registry.module(msg.pluginId) } catch (e) { throw isUnexpected(e) ? crashError('load', e) : e }
          let out
          try { out = applyMigration(mod, { pluginId: msg.pluginId, fromVersion: msg.fromVersion, op: msg.op, params: msg.params }) } catch (e) { throw isUnexpected(e) ? crashError('run', e) : e }
          scope.postMessage({ t: 'migrated', id, op: out.op, params: out.params } satisfies FromWorker)
        } catch (e) { scope.postMessage({ t: 'error', id, error: toStructured(e, 'plugin.failed', { plugin: msg.pluginId }) } satisfies FromWorker) }
      })()
      return
    }
    if (msg.t !== 'run') return
    const { id } = msg
    const ctrl = new AbortController(); running.set(id, ctrl)
    void (async () => {
      try {
        let mod
        try { mod = await registry.module(msg.pluginId) } catch (e) { throw isUnexpected(e) ? crashError('load', e) : e }
        const ctx: RunContext = {
          params: msg.params, mesh: msg.mesh as Mesh | undefined, payload: (msg.mesh as Mesh | undefined) ?? msg.payload, payloads: msg.payloads ?? {}, quality: msg.quality, signal: ctrl.signal,
          assets: assetId => new Promise<Uint8Array>((resolve, reject) => { const rid = nextRid++; pending.set(rid, { resolve, reject }); scope.postMessage({ t: 'asset-request', id, rid, assetId } satisfies FromWorker) }),
          fonts: { outline: (fontId, text, options) => new Promise<FontOutlines>((resolve, reject) => { const rid = nextRid++; pendingFonts.set(rid, { resolve, reject }); scope.postMessage({ t: 'font-request', id, rid, fontId, text, options } satisfies FromWorker) }) },
          progress: (stage, fraction) => scope.postMessage({ t: 'progress', id, stage, fraction } satisfies FromWorker),
          log: (level, message) => scope.postMessage({ t: 'log', id, level, message } satisfies FromWorker),
        }
        let res
        try { res = await mod.run(msg.op, ctx) } catch (e) { throw isUnexpected(e) && !ctrl.signal.aborted ? crashError('run', e) : e }
        // a mesh goes back as `mesh` (its buffers are transferred); any other kind is cloned as it is
        const out = res.payload ?? res.mesh
        const mesh = (out && isMesh(out) ? out : undefined) as WireMesh | undefined
        const other = out && !isMesh(out) ? out : undefined
        scope.postMessage({ t: 'result', id, mesh, ...(other ? { payload: other } : {}), report: res.report, warnings: res.warnings } satisfies FromWorker, uniqueBuffers(mesh))
      } catch (e) {
        const error = ctrl.signal.aborted ? abortReason(ctrl.signal).toJSON() : toStructured(e, 'plugin.failed', { plugin: msg.pluginId, op: msg.op })
        scope.postMessage({ t: 'error', id, error } satisfies FromWorker)
      } finally {
        running.delete(id)
      }
    })()
  })
}
