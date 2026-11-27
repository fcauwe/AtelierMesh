// The workflow runner: runs the steps in order and reuses everything that has not changed.
// Each step's cache key chains from the source mesh and every step before it, so editing step 3 of 5 re-runs
// steps 3 to 5 only. A failing or cancelled step leaves the earlier results intact and marks the later ones stale.
import { MemoryCache } from './cache'
import type { ResultCache } from './cache'
import { canonicalJson, sha256Hex } from './canonical'
import { MeshError, cleanWarnings, crashMessage, isMeshErrorLike, isStructured, toStructured } from './errors'
import type { CrashPhase } from './errors'
import type { StructuredError } from './errors'
import { meshColourProblem } from './colors'
import { checkOperationLimits } from './budget'
import { measureMesh } from './measure'
import { InProcessHost, abortReason } from './host'
import type { FontService, PluginHost } from './host'
import { isMesh, operationPayload, payloadKindOf, payloadKinds } from './payload'
import { migrateStep } from './migrate'
import { renameStep } from './rename'
import { ORIGINAL_NAME, STORE_PLUGIN_ID, storeProblem } from './store'
import type { ProjectStore } from './store'
import type { Registry } from './registry'
import type { Step, StepList } from './stack'
import type { AssetResolver, LogLevel, Mesh, Payload, Quality, RunResult } from './types'

export type StepStatus = 'ok' | 'stale' | 'running' | 'error' | 'cancelled' | 'disabled'

export interface StepResult {
  stepId: string
  status: StepStatus
  /** The cache key of this step (a disabled step keeps the key of the step before it). */
  key?: string
  /** The mesh after this step (a pass-through step returns its input). Absent when the result is not a mesh. */
  mesh?: Mesh
  /** What the step produced, whatever its kind (the same object as `mesh` when it is a mesh). */
  payload?: Payload
  report?: Record<string, unknown>
  warnings?: StructuredError[]
  /** The first problem, for a step in `error` status. */
  error?: StructuredError
  /** All problems found (validation can find several). */
  errors?: StructuredError[]
  ms?: number
  fromCache?: boolean
  /** The step was stored by an older plugin version and migrated before running. */
  migratedFrom?: string
  /** The step was saved under the id of a plugin that was renamed (`replaces` in the manifest of the plugin that ran it): the old id. */
  renamedFrom?: string
}

/** A plugin that crashed during a run: what the host needs to tell the user and, if it wants, to remember. */
export interface PluginCrash {
  plugin: string
  version: string
  op: string
  /** The step that was running. */
  step: string
  phase: CrashPhase
  /** The first line of what was thrown. */
  message: string
}

export interface WorkflowResult {
  results: StepResult[]
  /** The mesh after the last step that finished (absent when that result is not a mesh). */
  mesh?: Mesh
  /** What the last step that finished produced, whatever its kind. */
  payload?: Payload
  /** Every step finished (`ok` or `disabled`). */
  ok: boolean
  /** Index of the first step that failed, was cancelled or went stale; -1 if none. */
  firstProblem: number
  /** How many steps actually ran, and how many came from the cache. */
  ran: number
  fromCache: number
  /** Plugins that crashed in this run (they are switched off in the registry unless `deactivateOnCrash` is false). */
  crashedPlugins: PluginCrash[]
}

export interface RunOptions {
  registry: Registry
  /** Where plugin code runs. Default: in this thread. */
  host?: PluginHost
  /** What the workflow starts from: a mesh, a drawing or another registered kind. Absent when the first step is a generator. */
  source?: Payload | null
  /** A key for the source mesh, if the host already has one (for example a content hash of the uploaded file). */
  sourceKey?: string
  assets?: AssetResolver
  /**
   * The project's imported store entries (`ProjectStore`), by name. A step's `payload` parameter, and the `load` operation, find a name here unless an earlier `store`
   * step wrote it. A `store` step may not reuse the name of one of these entries (`store.name_taken`).
   */
  store?: ProjectStore
  /** The font service behind `ctx.fonts.outline` (`createFontService` in `@ateliermesh/plugins`). Without it a plugin that asks gets `fonts.unavailable`. */
  fonts?: FontService
  /**
   * A fingerprint of an asset's content, for the cache key (a replaced font or texture under the same id must not give a stale result).
   * Default: the hash of the bytes the resolver returns. A host that already knows a content hash can return it here and save the read.
   */
  assetKey?: (id: string) => string | Promise<string>
  quality?: Quality
  signal?: AbortSignal
  /** Budgets. A source over a budget is refused before anything runs; a step result over it is an error. Triangles and vertices count for meshes, paths and points for drawings. */
  limits?: { maxTriangles?: number; maxVertices?: number; maxPaths?: number; maxPoints?: number; stepTimeoutMs?: number; maxStoreBytes?: number; maxStoreEntries?: number }
  cache?: ResultCache
  /** Lets the host adjust a step just before it runs, with the results of the steps before it (for example to move placements). */
  prepareStep?: (step: Step, index: number, results: ReadonlyArray<StepResult | undefined>) => Step
  /** Called when a step starts and when it finishes. */
  onStatus?: (index: number, result: StepResult) => void
  onProgress?: (stepId: string, stage: string, fraction: number) => void
  onLog?: (stepId: string, level: LogLevel, message: string) => void
  /**
   * A plugin crashed (it threw something it did not mean to, its code failed to load, or its worker died). By default the runner
   * switches the plugin off in the registry (`registry.setEnabled(id, false, message)`), so the next run does not meet it again and the host
   * can tell the user. Pass `false` to leave that to the host. A cancellation or a timeout is never a crash.
   */
  deactivateOnCrash?: boolean
  /** Called once per crash, after the step was published. */
  onPluginCrash?: (crash: PluginCrash) => void
}

const noAssets: AssetResolver = id => Promise.reject(new MeshError('plugin.failed', { reason: 'no_asset_resolver', asset: id }))

export async function runWorkflow(list: StepList, opts: RunOptions): Promise<WorkflowResult> {
  const { registry, limits = {} } = opts
  const host = opts.host ?? new InProcessHost(registry)
  const cache = opts.cache ?? new MemoryCache()
  const quality: Quality = opts.quality ?? 'export'
  const source = opts.source ?? undefined
  if (source) payloadKinds.budget(source, limits, 'source')
  if (opts.store) { const bad = storeProblem(opts.store, limits); if (bad) throw new MeshError(bad.code, bad.params) }
  // what `store` steps have written so far in this run: the nearest earlier writer of a name wins, then the project's own entry
  const produced = new Map<string, Payload>()
  const checkedEntries = new WeakSet<object>()
  const sourceKind = source ? payloadKindOf(source) : 'mesh'
  let prevKey = 'src:' + (source ? (sourceKind === 'mesh' ? '' : sourceKind + ':') + (opts.sourceKey ?? payloadKinds.key(source)) : 'none')
  let prev: Payload | undefined = source
  const shown = (p: Payload | undefined): { mesh?: Mesh; payload?: Payload } => (p ? { ...(isMesh(p) ? { mesh: p } : {}), payload: p } : {})
  const results: StepResult[] = []
  const crashedPlugins: PluginCrash[] = []
  let ran = 0, hits = 0, problem = -1

  const publish = (i: number, r: StepResult): void => { results[i] = r; opts.onStatus?.(i, r) }
  /**
   * Decide whether a failure is a plugin crash. A crash is something the plugin did not mean: an unexpected exception, a failed load, a dead
   * worker, or an error a sandbox reports as a bare `plugin.failed` with a message. Everything else keeps its own code.
   */
  const classify = (e: unknown, step: Step, phase: CrashPhase): StructuredError => {
    const structured = isMeshErrorLike(e) ? toStructured(e) : isStructured(e) ? e : null
    let crashed: { phase: CrashPhase; message: string } | null = null
    if (structured === null) crashed = { phase, message: crashMessage(e) }
    else if (structured.code === 'plugin.crashed') crashed = { phase: ((structured.params?.['phase'] as CrashPhase | undefined) ?? phase), message: String(structured.params?.['message'] ?? '') }
    else if (structured.code === 'plugin.failed' && typeof structured.params?.['message'] === 'string' && structured.params['reason'] === undefined) crashed = { phase, message: crashMessage(structured.params['message']) }
    if (!crashed) return structured ?? toStructured(e, 'plugin.failed', { plugin: step.plugin.id, op: step.op })
    const version = registry.manifest(step.plugin.id)?.version ?? step.plugin.version
    const record: PluginCrash = { plugin: step.plugin.id, version, op: step.op, step: step.id, phase: crashed.phase, message: crashed.message }
    crashedPlugins.push(record)
    if (opts.deactivateOnCrash !== false) registry.setEnabled(step.plugin.id, false, record.message, true)
    queueMicrotask(() => opts.onPluginCrash?.(record))
    return { code: 'plugin.crashed', params: { ...record, name: registry.manifest(step.plugin.id)?.name ?? step.plugin.id } }
  }
  // content fingerprints of the assets, read once per run
  const assetKeys = new Map<string, Promise<string>>()
  const assetFingerprint = (id: string): Promise<string> => {
    let k = assetKeys.get(id)
    if (!k) {
      k = Promise.resolve().then(async () => (opts.assetKey ? opts.assetKey(id) : sha256Hex(await (opts.assets ?? noAssets)(id)))).catch(() => `unresolved:${id}`)
      assetKeys.set(id, k)
    }
    return k
  }

  for (let i = 0; i < list.steps.length; i++) {
    const original = list.steps[i] as Step
    if (problem >= 0) { publish(i, { stepId: original.id, status: 'stale' }); continue }
    if (!original.enabled) { publish(i, { stepId: original.id, status: 'disabled', key: prevKey, ...shown(prev) }); continue }
    if (opts.signal?.aborted) { problem = i; publish(i, { stepId: original.id, status: 'cancelled', error: abortReason(opts.signal).toJSON() }); continue }

    // check (and if needed migrate) the step against the installed plugin
    let step = opts.prepareStep ? opts.prepareStep(original, i, results) : original
    // a step saved under the id of a plugin that was renamed runs with the plugin that replaces it
    const renamed = renameStep(step, registry)
    step = renamed.step
    const renamedFrom = renamed.renamedFrom
    let migratedFrom: string | undefined
    if (registry.has(step.plugin.id) && !registry.isEnabled(step.plugin.id)) {
      problem = i
      const off = registry.disabledPlugins()[step.plugin.id]
      const e: StructuredError = { code: 'plugin.disabled', params: { plugin: step.plugin.id, name: registry.manifest(step.plugin.id)?.name ?? step.plugin.id, op: step.op, step: step.id, reason: off?.reason ?? '', crashed: off?.crashed === true } }
      publish(i, { stepId: step.id, status: 'error', error: e, errors: [e] }); continue
    }
    let v = registry.validateStep(step)
    if (v.needsMigration) {
      try { const m = await migrateStep(step, registry, opts.host); step = m.step; migratedFrom = m.from; v = registry.validateStep(step) }
      catch (e) {
        // a step that cannot be brought forward is a problem of that step, not a crash: the plugin stays on and every other project keeps working
        problem = i
        const known = e instanceof MeshError && ['step.unknown_plugin', 'step.unknown_op', 'step.version_newer'].includes(e.code)
        const err: StructuredError = known ? (e as MeshError).toJSON() : { code: 'step.migration_failed', params: { plugin: step.plugin.id, name: registry.manifest(step.plugin.id)?.name ?? step.plugin.id, from: step.plugin.version, installed: registry.manifest(step.plugin.id)?.version ?? '', message: crashMessage(e) } }
        publish(i, { stepId: step.id, status: 'error', error: err, errors: [err] }); continue
      }
    }
    if (!v.ok) { problem = i; publish(i, { stepId: step.id, status: 'error', error: v.errors[0], errors: v.errors }); continue }
    const found = registry.operation(step.plugin.id, step.op)
    if (!found) { problem = i; const e: StructuredError = { code: 'step.unknown_op', params: { plugin: step.plugin.id, op: step.op } }; publish(i, { stepId: step.id, status: 'error', error: e, errors: [e] }); continue }
    const { op } = found
    const kinds = operationPayload(op)
    if (op.kind !== 'generator' && op.inputs?.mesh?.required !== false && !prev) {
      problem = i
      const e: StructuredError = kinds.in === 'mesh' ? { code: 'input.missing_mesh', params: { op: op.id } } : { code: 'input.missing_payload', params: { op: op.id, kind: kinds.in } }
      publish(i, { stepId: step.id, status: 'error', error: e, errors: [e] }); continue
    }
    // a step takes the kind it declares: a drawing cannot go into a mesh step, and the other way round (an extrusion is the step that turns one into the other)
    if (op.kind !== 'generator' && prev && kinds.in !== '*' && payloadKindOf(prev) !== kinds.in) {
      problem = i
      const e: StructuredError = { code: 'input.wrong_kind', params: { op: op.id, expected: kinds.in, got: payloadKindOf(prev) } }
      publish(i, { stepId: step.id, status: 'error', error: e, errors: [e] }); continue
    }

    const params = v.value.params
    const fail = (e: StructuredError): void => { problem = i; publish(i, { stepId: step.id, status: 'error', error: e, errors: [e] }) }
    // the stored payloads the step asks for: found by name, checked once, and part of what the step computes
    const payloads: Record<string, Payload> = {}
    const payloadKeys: Record<string, string> = {}
    let payloadFailure: StructuredError | null = null
    for (const p of op.params) {
      if (p.type !== 'payload') continue
      const name = params[p.name]
      if (typeof name !== 'string') { if (step.plugin.id === STORE_PLUGIN_ID) payloadFailure = { code: 'input.missing_payload', params: { op: op.id, param: p.name, kind: p.accept.join(',') } }; continue }
      const entry = produced.get(name) ?? opts.store?.[name]?.payload ?? (name === ORIGINAL_NAME ? source : undefined)   // `original`: the model the project started from
      if (!entry) { payloadFailure = { code: 'input.missing_payload', params: { op: op.id, param: p.name, name, kind: p.accept.join(',') } }; break }
      const kind = payloadKindOf(entry)
      if (!p.accept.includes('*') && !p.accept.includes(kind)) { payloadFailure = { code: 'input.wrong_kind', params: { op: op.id, param: p.name, name, expected: p.accept.join(','), got: kind } }; break }
      if (!checkedEntries.has(entry)) {
        try {
          const why = payloadKinds.problem(entry)
          if (why) throw new MeshError('store.bad_entry', { name, problem: why })
          payloadKinds.budget(entry, { ...limits, ...(opts.store?.[name]?.limits ?? {}) }, 'source')
        } catch (e) { payloadFailure = toStructured(e); break }
        checkedEntries.add(entry)
      }
      payloads[p.name] = entry
      payloadKeys[p.name] = kind + ':' + payloadKinds.key(entry)
    }
    if (payloadFailure) { fail(payloadFailure); continue }
    if (step.plugin.id === STORE_PLUGIN_ID) {
      // the store operations are the runner's own: no plugin code runs, and nothing is cached (they cost nothing)
      if (step.op === 'store') {
        const name = params['name'] as string
        if (opts.store?.[name] || name === ORIGINAL_NAME) { fail({ code: 'store.name_taken', params: { name, op: op.id } }); continue }
        if (!prev) { fail({ code: 'input.missing_payload', params: { op: op.id, kind: '*' } }); continue }
        produced.set(name, prev)
        const k = sha256Hex(prevKey + '|store:' + name)
        prevKey = k
        publish(i, { stepId: step.id, status: 'ok', key: k, ...shown(prev), report: { stored: name, kind: payloadKindOf(prev) }, migratedFrom, ...(renamedFrom ? { renamedFrom } : {}) })
        continue
      }
      const entry = payloads['name']
      if (!entry) { fail({ code: 'input.missing_payload', params: { op: op.id, param: 'name', kind: '*' } }); continue }
      const k = sha256Hex(prevKey + '|load:' + String(params['name']) + '|' + payloadKeys['name'])
      prevKey = k; prev = entry
      publish(i, { stepId: step.id, status: 'ok', key: k, ...shown(prev), migratedFrom, ...(renamedFrom ? { renamedFrom } : {}) })
      continue
    }
    // the content of the assets a step uses is part of what it computes
    const assets: Record<string, string> = {}
    for (const p of op.params) if (p.type === 'asset' && typeof params[p.name] === 'string') assets[p.name] = await assetFingerprint(params[p.name] as string)
    const key = sha256Hex(prevKey + '|' + canonicalJson({ plugin: step.plugin, op: step.op, params, quality, ...(Object.keys(assets).length > 0 ? { assets } : {}), ...(Object.keys(payloadKeys).length > 0 ? { payloads: payloadKeys } : {}) }))
    const hit = cache.get(key)
    if (hit) {
      hits++
      prevKey = key; prev = hit.payload ?? hit.mesh ?? prev
      publish(i, { stepId: step.id, status: 'ok', key, ...shown(prev), report: hit.report, warnings: hit.warnings, fromCache: true, migratedFrom, ...(renamedFrom ? { renamedFrom } : {}) })
      continue
    }

    // the operation's own limits on what goes in
    if (prev && isMesh(prev)) { try { checkOperationLimits(prev, op.limits, 'input', op.id) } catch (e) { problem = i; const err = toStructured(e); publish(i, { stepId: step.id, status: 'error', error: err, errors: [err] }); continue } }

    publish(i, { stepId: step.id, status: 'running', key })
    const needsFonts = registry.manifest(step.plugin.id)?.uses?.includes('fonts') === true && !opts.fonts
    const t0 = now()
    // one controller per step: the caller's signal and the step timeout both abort it, with a structured reason
    const ctrl = new AbortController()
    const onOuter = (): void => { if (!ctrl.signal.aborted) ctrl.abort(opts.signal ? abortReason(opts.signal) : new MeshError('run.cancelled')) }
    opts.signal?.addEventListener('abort', onOuter)
    const timer = limits.stepTimeoutMs ? setTimeout(() => { if (!ctrl.signal.aborted) ctrl.abort(new MeshError('run.timeout', { ms: limits.stepTimeoutMs })) }, limits.stepTimeoutMs) : undefined
    try {
      if (needsFonts) throw new MeshError('plugin.needs_fonts', { plugin: step.plugin.id })
      const res: RunResult = await Promise.race([
        host.run({ pluginId: step.plugin.id, op: step.op, params, ...(prev && isMesh(prev) ? { mesh: prev } : prev ? { payload: prev } : {}), ...(Object.keys(payloads).length > 0 ? { payloads } : {}), quality }, {
          signal: ctrl.signal, assets: opts.assets ?? noAssets, ...(opts.fonts ? { fonts: opts.fonts } : {}),
          onProgress: (stage, fraction) => opts.onProgress?.(step.id, stage, fraction),
          onLog: (level, message) => opts.onLog?.(step.id, level, message),
        }),
        new Promise<never>((_, reject) => ctrl.signal.addEventListener('abort', () => reject(abortReason(ctrl.signal)))),
      ])
      ran++
      const made: Payload | undefined = res.payload ?? res.mesh
      if (!made && (op.kind === 'generator' || op.kind === 'modifier')) throw new MeshError('plugin.failed', { reason: kinds.out === 'mesh' ? 'no_mesh_returned' : 'no_output_returned', plugin: step.plugin.id, op: step.op })
      if (res.payload && res.mesh) throw new MeshError('plugin.bad_output', { plugin: step.plugin.id, op: step.op, problem: 'both mesh and payload' })
      if (made && payloadKindOf(made) !== kinds.out) throw new MeshError('plugin.bad_output', { plugin: step.plugin.id, op: step.op, expected: kinds.out, got: payloadKindOf(made) })
      const out: Payload | undefined = made ?? prev
      if (made && !payloadKinds.has(kinds.out)) throw new MeshError('payload.unknown_kind', { kind: kinds.out })
      if (made && (registry.isUntrusted(step.plugin.id) || !isMesh(made))) { const problem = payloadKinds.problem(made); if (problem) throw new MeshError('plugin.bad_mesh', { plugin: step.plugin.id, problem }) }
      if (made && isMesh(made)) { const colour = meshColourProblem(made); if (colour) throw new MeshError('plugin.bad_mesh', { plugin: step.plugin.id, problem: colour }) }   // colour lives on parts: #rrggbb or nothing
      if (made) payloadKinds.budget(made, limits, 'result')
      if (made && isMesh(made)) checkOperationLimits(made, op.limits, 'result', op.id)
      // a plugin that promises a closed result must deliver one (when what it received was closed)
      if (made && isMesh(made) && op.outputs?.closed && prev && isMesh(prev) && measureMesh(prev).watertight && !measureMesh(made).watertight) throw new MeshError('plugin.bad_mesh', { plugin: step.plugin.id, problem: 'not_closed' })
      const warnings = cleanWarnings(res.warnings, made && isMesh(made) ? made.indices.length / 3 : prev && isMesh(prev) ? prev.indices.length / 3 : 0)
      cache.set(key, { ...(made ? (isMesh(made) ? { mesh: made } : { payload: made }) : {}), report: res.report, warnings })
      prevKey = key; prev = out
      publish(i, { stepId: step.id, status: 'ok', key, ...shown(out), report: res.report, warnings, ms: now() - t0, migratedFrom, ...(renamedFrom ? { renamedFrom } : {}) })
    } catch (e) {
      problem = i
      const err = ctrl.signal.aborted ? abortReason(ctrl.signal).toJSON() : classify(e, step, 'run')
      publish(i, { stepId: step.id, status: err.code === 'run.cancelled' ? 'cancelled' : 'error', error: err, errors: [err], ms: now() - t0 })
    } finally {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onOuter)
    }
  }
  return { results, ...shown(prev), ok: problem < 0, firstProblem: problem, ran, fromCache: hits, crashedPlugins }
}

// performance.now is available in every browser, worker and Node version we support; Date.now is the fallback
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())
