// Structured errors: a stable code plus parameters, never only a sentence, so a host can show a localised message.

export interface StructuredError {
  /** Stable machine-readable code, e.g. `param.out_of_range`. */
  code: string
  /** Values the message needs (limits, names, counts). Plain JSON only. */
  params?: Record<string, unknown>
  /** Where it happened, e.g. `params.factor` or `steps[2]`. */
  path?: string
  /**
   * Where on the model it happened, for a warning: points (millimetres, in the coordinates of the step's result) and/or triangles of that result.
   * A host shows a button that marks them on the model. A malformed or out-of-range `where` is dropped by the engine, never an error.
   */
  where?: WarningPlace
}

/** A place on a model: up to `MAX_WHERE_POINTS` points and up to `MAX_WHERE_TRIANGLES` triangle numbers of the step's result mesh. */
export interface WarningPlace { points?: Array<[number, number, number]>; triangles?: number[] }
export const MAX_WHERE_POINTS = 64
export const MAX_WHERE_TRIANGLES = 20000

/**
 * The `where` of a warning, checked: finite coordinates, whole triangle numbers below `triangleCount`, within the caps. Returns the clean place
 * or undefined when nothing usable is left. A plugin (it may be untrusted) cannot make the host draw outside the model or flood it.
 */
export function cleanPlace(w: unknown, triangleCount: number): WarningPlace | undefined {
  if (typeof w !== 'object' || w === null) return undefined
  const o = w as Record<string, unknown>
  const out: WarningPlace = {}
  if (Array.isArray(o['points'])) {
    const pts = o['points'].filter((p): p is [number, number, number] => Array.isArray(p) && p.length === 3 && p.every(x => typeof x === 'number' && Number.isFinite(x))).slice(0, MAX_WHERE_POINTS)
    if (pts.length) out.points = pts.map(p => [p[0], p[1], p[2]])
  }
  if (Array.isArray(o['triangles'])) {
    const tri = o['triangles'].filter((x): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) < triangleCount).slice(0, MAX_WHERE_TRIANGLES)
    if (tri.length) out.triangles = tri
  }
  return out.points || out.triangles ? out : undefined
}

/** The warnings of a step with each `where` checked against the result it refers to. */
export function cleanWarnings(ws: StructuredError[] | undefined, triangleCount: number): StructuredError[] | undefined {
  if (!ws) return ws
  return ws.map(w => {
    if (w.where === undefined) return w
    const { where, ...rest } = w
    const clean = cleanPlace(where, triangleCount)
    return clean ? { ...rest, where: clean } : rest
  })
}

export class MeshError extends Error {
  readonly code: string
  readonly params: Record<string, unknown>
  readonly path?: string

  constructor(code: string, params: Record<string, unknown> = {}, path?: string, message?: string) {
    super(message ?? code)
    this.name = 'MeshError'
    this.code = code
    this.params = params
    this.path = path
  }

  toJSON(): StructuredError {
    const e: StructuredError = { code: this.code }
    if (Object.keys(this.params).length > 0) e.params = this.params
    if (this.path !== undefined) e.path = this.path
    return e
  }
}

/**
 * A MeshError, also one made by another copy of this package: a plugin that bundles `@ateliermesh/core` into its main.js throws its own copy of the class, which is not
 * `instanceof` the host's. Same name and a text `code` is the same thing, so an error a plugin means ("this model is not a closed solid") is not mistaken for a crash.
 */
export function isMeshErrorLike(e: unknown): e is MeshError {
  return e instanceof MeshError || (e instanceof Error && e.name === 'MeshError' && typeof (e as { code?: unknown }).code === 'string')
}

/** Turn anything thrown into a structured error. Unknown errors become `plugin.failed` with the message as a parameter. */
export function toStructured(e: unknown, fallbackCode = 'plugin.failed', extra: Record<string, unknown> = {}): StructuredError {
  if (e instanceof MeshError) return e.toJSON()
  if (isMeshErrorLike(e)) { const x = e as { code: string; params?: unknown; path?: unknown }; return { code: x.code, ...(x.params && typeof x.params === 'object' && Object.keys(x.params).length > 0 ? { params: x.params as Record<string, unknown> } : {}), ...(typeof x.path === 'string' ? { path: x.path } : {}) } }
  if (isStructured(e)) return e
  const message = e instanceof Error ? e.message : String(e)
  return { code: fallbackCode, params: { ...extra, message } }
}

/** Where in its life a plugin failed: `load` (its code could not be imported or started), `run` (it threw while working) or `worker` (its worker died or sent something unreadable). */
export type CrashPhase = 'load' | 'run' | 'worker'

/** The first line of what was thrown, trimmed and capped, for a banner. */
export function crashMessage(e: unknown): string {
  const raw = e instanceof Error ? (e.name && e.name !== 'Error' ? `${e.name}: ${e.message}` : e.message) : typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string' ? (e as { message: string }).message : String(e)
  const line = (raw.startsWith('[object') ? 'the worker stopped unexpectedly' : (raw.split('\n')[0] ?? '')).trim()
  return line.length > 200 ? `${line.slice(0, 199)}…` : line
}

/** A failure the plugin did not intend: a thrown `Error`, a failed import, a dead worker. A `MeshError` or a structured error is the plugin speaking, not crashing. */
export const isUnexpected = (e: unknown): boolean => !isMeshErrorLike(e) && !isStructured(e)

/** `plugin.crashed` with the phase and the first line of the message. The runner adds plugin, version, op and step. */
export const crashError = (phase: CrashPhase, e: unknown): MeshError => new MeshError('plugin.crashed', { phase, message: crashMessage(e) })

export function isStructured(e: unknown): e is StructuredError {
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string' && !(e instanceof Error)
}

/** The error codes this package produces. Hosts translate these; plugins may add their own with a `<plugin>.` prefix. */
export const ERROR_CODES = [
  'manifest.invalid', 'manifest.missing_license', 'manifest.missing_description', 'manifest.bad_license', 'manifest.bad_description', 'manifest.bad_contact', 'manifest.bad_package_url', 'manifest.bad_replaces', 'manifest.bad_image',
  'param.unknown', 'param.type', 'param.out_of_range', 'param.not_enum', 'param.too_long', 'param.too_short', 'param.too_many_lines', 'param.too_few_items', 'param.too_many_items', 'param.line_too_long', 'param.pattern', 'param.length', 'param.not_editable', 'param.invalid',
  'image.unsupported', 'image.invalid', 'image.too_large',
  'group.unknown', 'part.unknown', 'part.ambiguous', 'segment.bad_color', 'segment.unknown',
  'step.invalid', 'step.unknown_plugin', 'step.unknown_op', 'step.version_newer', 'step.not_personalisable',
  'input.missing_mesh',
  'run.cancelled', 'run.timeout',
  'budget.triangles', 'budget.vertices', 'budget.memory',
  'plugin.failed', 'plugin.bad_mesh', 'plugin.needs_sandbox', 'plugin.crashed', 'plugin.disabled',
  'expr.invalid', 'placement.limits_changed', 'placement.too_far', 'placement.direction_out_of_range', 'placement.size_out_of_range', 'import.invalid_project', 'export.invalid_preview',
  'recipe.not_json', 'recipe.not_a_recipe', 'recipe.version_newer', 'recipe.too_large', 'recipe.field', 'recipe.too_many_steps', 'recipe.steps_invalid', 'recipe.unsafe_key', 'recipe.bad_asset', 'recipe.assets_too_large',
  'apply.nothing_to_apply', 'apply.unknown_step', 'apply.after_rollback', 'apply.blocked', 'apply.step_failed',
] as const
