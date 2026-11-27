// Apply permanently: bake steps into the base mesh (SPEC 2.6). Pure and async: it returns the new state and never changes its input,
// so a failing step leaves everything as it was. The host keeps the undo history and clears it when it receives the event.
import { MeshError } from './errors'
import type { Step, StepList } from './stack'
import { runWorkflow } from './runner'
import type { RunOptions } from './runner'
import type { Mesh, Payload } from './types'

/** What the editor holds: the base mesh, the step list that runs on it, and the rollback marker (a step id, or null). */
export interface EditorState<B extends Payload = Mesh> {
  /** The base: a mesh (the default type) or a drawing. Null when the first step is a generator. */
  base: B | null
  list: StepList
  /** The viewer shows the model as of this step. Steps after it are hidden, and cannot be applied. */
  rollback: string | null
}

/** Told to the host when the base changed, so it can save. */
export interface BaseReplacedEvent {
  type: 'base-replaced'
  /** How many steps were baked in (disabled ones count: they are removed from the list too). */
  applied: number
  stepIds: string[]
  /** Undo history before this point can no longer be restored: the host clears it. */
  clearHistory: true
}

export interface ApplyOptions extends Omit<RunOptions, 'source'> {
  /** Host rule that blocks Apply (for example a step in the range is personalisable). Return a reason to block. */
  block?: (steps: Step[]) => string | undefined
  /** Called once, after the new state is ready. */
  onBaseReplaced?: (event: BaseReplacedEvent) => void
}

export type CanApply = { ok: true; count: number } | { ok: false; code: string; params?: Record<string, unknown> }

function range(state: EditorState<Payload>, upTo?: string): { count: number } | { code: string; params?: Record<string, unknown> } {
  const steps = state.list.steps
  if (steps.length === 0) return { code: 'apply.nothing_to_apply' }
  let last = steps.length - 1
  if (upTo !== undefined) {
    last = steps.findIndex(s => s.id === upTo)
    if (last < 0) return { code: 'apply.unknown_step', params: { id: upTo } }
  }
  if (state.rollback !== null) {
    const m = steps.findIndex(s => s.id === state.rollback)
    if (m >= 0 && last > m) return { code: 'apply.after_rollback', params: { marker: state.rollback, id: (steps[last] as Step).id } }
  }
  return { count: last + 1 }
}

/** May the host offer Apply? False for an empty list, an unknown step, or a step after the marker. The host's own rules come on top. */
export function canApplyPermanently(state: EditorState<Payload>, upTo?: string): CanApply {
  const r = range(state, upTo)
  return 'count' in r ? { ok: true, count: r.count } : { ok: false, ...r }
}

/**
 * Run the steps from the first one up to `upTo` (default: all) and make the result the new base. The applied steps leave the list.
 * Throws a MeshError (`apply.*`) and changes nothing if the range is not allowed or a step fails.
 */
export async function applyPermanently<B extends Payload = Mesh, R extends Payload = Mesh>(state: EditorState<B>, opts: ApplyOptions, upTo?: string): Promise<{ state: EditorState<R>; event: BaseReplacedEvent }> {
  const r = range(state, upTo)
  if (!('count' in r)) throw new MeshError(r.code, r.params ?? {})
  const applied = state.list.steps.slice(0, r.count)
  const blocked = opts.block?.(applied)
  if (blocked !== undefined) throw new MeshError('apply.blocked', { reason: blocked })

  const { block: _block, onBaseReplaced, ...run } = opts
  const res = await runWorkflow({ ...state.list, steps: applied }, { ...run, source: state.base })
  if (!res.ok) {
    const bad = res.results[res.firstProblem]
    throw new MeshError('apply.step_failed', { step: bad?.stepId ?? null, cause: bad?.error ?? null }, `steps[${res.firstProblem}]`)
  }
  if (!res.payload) throw new MeshError('apply.nothing_to_apply', { reason: 'no_mesh' })

  const markerIndex = state.rollback === null ? -1 : state.list.steps.findIndex(s => s.id === state.rollback)
  const next: EditorState<R> = {
    base: res.payload as R,
    list: { ...state.list, steps: state.list.steps.slice(r.count) },
    rollback: markerIndex >= r.count ? state.rollback : null,
  }
  const event: BaseReplacedEvent = { type: 'base-replaced', applied: r.count, stepIds: applied.map(s => s.id), clearHistory: true }
  onBaseReplaced?.(event)
  return { state: next, event }
}
