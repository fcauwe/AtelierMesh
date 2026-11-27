// A host runs one operation of one plugin. The runner does not care where: in the same thread (tests, simple hosts)
// or in a worker (the browser). The package never creates a worker itself; the host does (spike S2b).
import { MeshError, crashError, isUnexpected } from './errors'
import type { Registry } from './registry'
import type { AssetResolver, FontOutlineOptions, FontOutlines, LogLevel, Mesh, Payload, Quality, RunContext, RunResult } from './types'

export interface RunRequest {
  pluginId: string
  op: string
  /** Validated, defaults filled. */
  params: Record<string, unknown>
  /** The input when it is a mesh. */
  mesh?: Mesh
  /** The input when it is not a mesh (a drawing, say). */
  payload?: Payload
  /** The payloads the step's `payload` parameters name, by parameter name. */
  payloads?: Record<string, Payload>
  quality: Quality
}

export interface RunHooks {
  signal: AbortSignal
  assets: AssetResolver
  /** The host's font service for `ctx.fonts.outline`; without it a plugin that asks gets `fonts.unavailable`. */
  fonts?: FontService
  onProgress?: (stage: string, fraction: number) => void
  onLog?: (level: LogLevel, message: string) => void
}

/** Letter outlines for a font id, made by the host (in `@ateliermesh/plugins`: `createFontService`). */
export type FontService = (fontId: string, text: string, options: FontOutlineOptions) => Promise<FontOutlines>

export const noFonts: FontService = () => Promise.reject(new MeshError('fonts.unavailable'))

/** Bringing a step saved by an older plugin version forward: done where the plugin's code is. */
export interface MigrateRequest { pluginId: string; /** The version the step was saved with. */ fromVersion: string; op: string; params: Record<string, unknown> }
export interface MigrateResult { op: string; params: Record<string, unknown> }

export interface PluginHost {
  run(req: RunRequest, hooks: RunHooks): Promise<RunResult>
  /**
   * Run the plugin's `migrateOp` and `migrate` for a step saved by an older version. A host whose plugin code does not run on the page (a worker) must offer this, because the
   * page cannot load the code; without it the engine loads the module on the page. Absent: the page does it.
   */
  migrate?(req: MigrateRequest, signal?: AbortSignal): Promise<MigrateResult>
}

/** What a plugin's own migration says for one step: the same function in the page and in the worker. */
export function applyMigration(mod: { migrateOp?: (from: string, op: string, params: Record<string, unknown>) => string; migrate?: (from: string, params: Record<string, unknown>, op: string) => Record<string, unknown> }, req: MigrateRequest): MigrateResult {
  const op = mod.migrateOp ? mod.migrateOp(req.fromVersion, req.op, req.params) : req.op
  const params = mod.migrate ? mod.migrate(req.fromVersion, JSON.parse(JSON.stringify(req.params)) as Record<string, unknown>, req.op) : req.params
  return { op, params }
}

/** Runs the plugin code in the calling thread. */
export class InProcessHost implements PluginHost {
  constructor(private readonly registry: Registry) {}

  async migrate(req: MigrateRequest): Promise<MigrateResult> {
    const mod = await this.registry.module(req.pluginId)
    return applyMigration(mod, req)
  }

  async run(req: RunRequest, hooks: RunHooks): Promise<RunResult> {
    if (hooks.signal.aborted) throw abortReason(hooks.signal)
    let mod
    try { mod = await this.registry.module(req.pluginId) } catch (e) { throw isUnexpected(e) ? crashError('load', e) : e }
    const ctx: RunContext = {
      params: req.params,
      mesh: req.mesh,
      payload: req.mesh ?? req.payload,
      payloads: req.payloads ?? {},
      assets: hooks.assets,
      fonts: { outline: hooks.fonts ?? noFonts },
      quality: req.quality,
      progress: (stage, fraction) => hooks.onProgress?.(stage, fraction),
      signal: hooks.signal,
      log: (level, message) => hooks.onLog?.(level, message),
    }
    try { return await mod.run(req.op, ctx) } catch (e) { throw isUnexpected(e) && !hooks.signal.aborted ? crashError('run', e) : e }
  }
}

/** The reason an abort signal carries, as a structured error (defaults to a plain cancellation). */
export function abortReason(signal: AbortSignal): MeshError {
  const r: unknown = signal.reason
  return r instanceof MeshError ? r : new MeshError('run.cancelled')
}
