// Steps and the step list. Everything here is a pure function: it returns a new list and never mutates its input.
// A UI layer wraps these in its own store (the Atelier uses Zustand).
import type { StructuredError } from './errors'
import { MeshError } from './errors'
import { hashJson } from './canonical'
import { ID_RE, PLUGIN_ID_RE, SEMVER_RE } from './validate'
import type { ValidationResult } from './validate'

/** One operation applied with concrete parameters. The shape matches the Atelier's `operations_json` (vision doc, section 3.3). */
export interface Step {
  /** Identity of this step inside its list (for the UI and for the customer view). Not part of what a step computes. */
  id: string
  plugin: { id: string; version: string }
  op: string
  /** A name the designer gives the step, shown in the step list and to the customer. Not part of what a step computes. Absent: the operation's own title. */
  name?: string
  enabled: boolean
  params: Record<string, unknown>
  /** May the customer change some parameters of this step in the preview? */
  personalisable: boolean
  /**
   * Which parameters the designer hands over. Each must be flagged `personalisable` in the manifest. For a placement parameter `p`, `p` opens everything
   * (position and direction); `p.position` and `p.direction` open one of them.
   */
  personalisable_params: string[]
  /** Limits the designer sets on what the customer types into a text parameter. Absent when there are none. */
  personalisable_limits?: Record<string, TextLimits>
}

/** Limits on a text the customer types: at most this many lines, each at most this many characters. */
export interface TextLimits { max_lines?: number; max_line_length?: number }

/** The parts of a placement the designer can open on their own. */
export type PlacementPart = 'position' | 'direction'

/** May the customer change this parameter of this step? With `part`, a placement parameter opened as a whole or just for that part. */
export function canPersonalise(step: Pick<Step, 'personalisable_params'>, name: string, part?: PlacementPart): boolean {
  return step.personalisable_params.includes(name) || (part !== undefined && step.personalisable_params.includes(`${name}.${part}`))
}

/** Is any part of this parameter open to the customer? */
export const hasPersonalisable = (step: Pick<Step, 'personalisable_params'>, name: string): boolean => step.personalisable_params.some(x => x === name || x.startsWith(`${name}.`))

/** Sets (or, with null, removes) the limits on a text parameter for the customer. */
export function setPersonalisableLimits(list: StepList, id: string, param: string, limits: TextLimits | null): StepList {
  if (!list.steps.some(s => s.id === id)) throw missing(id)
  return { ...list, steps: list.steps.map(s => {
    if (s.id !== id) return s
    const rest = { ...(s.personalisable_limits ?? {}) }
    if (limits && (limits.max_lines !== undefined || limits.max_line_length !== undefined)) rest[param] = limits; else delete rest[param]
    const { personalisable_limits: _drop, ...bare } = s
    return Object.keys(rest).length > 0 ? { ...bare, personalisable_limits: rest } : bare
  }) }
}

export interface StepList {
  schema_version: 1
  steps: Step[]
}

export const STEP_LIST_SCHEMA_VERSION = 1

export function emptyStepList(): StepList {
  return { schema_version: STEP_LIST_SCHEMA_VERSION, steps: [] }
}

export function makeStep(s: Pick<Step, 'id' | 'plugin' | 'op'> & Partial<Step>): Step {
  const step = { enabled: true, params: {}, personalisable: false, personalisable_params: [] as string[], ...s }
  return { ...step, personalisable: step.personalisable_params.length > 0 }
}

/** A step is personalisable exactly when it hands over at least one field. */
export const stepPersonalisable = (s: Pick<Step, 'personalisable_params'>): boolean => s.personalisable_params.length > 0

/** Sets the personalisable fields; the step's `personalisable` flag follows from them. */
export function setPersonalisableParams(list: StepList, id: string, names: string[]): StepList {
  if (!list.steps.some(s => s.id === id)) throw missing(id)
  const unique = [...new Set(names)]
  return { ...list, steps: list.steps.map(s => (s.id === id ? { ...s, personalisable_params: unique, personalisable: unique.length > 0 } : s)) }
}

const dup = (id: string): MeshError => new MeshError('step.invalid', { reason: 'duplicate_id', id }, 'steps')
const missing = (id: string): MeshError => new MeshError('step.invalid', { reason: 'no_such_step', id }, 'steps')

function indexOf(list: StepList, id: string): number {
  const i = list.steps.findIndex(s => s.id === id)
  if (i < 0) throw missing(id)
  return i
}

const withSteps = (list: StepList, steps: Step[]): StepList => ({ ...list, steps })

/** Insert a step at `index` (default: the end). */
export function addStep(list: StepList, step: Step, index: number = list.steps.length): StepList {
  if (list.steps.some(s => s.id === step.id)) throw dup(step.id)
  if (!Number.isInteger(index) || index < 0 || index > list.steps.length) throw new MeshError('step.invalid', { reason: 'bad_index', index }, 'steps')
  const steps = list.steps.slice(); steps.splice(index, 0, step)
  return withSteps(list, steps)
}

export function removeStep(list: StepList, id: string): StepList {
  const i = indexOf(list, id)
  return withSteps(list, list.steps.filter((_, j) => j !== i))
}

/** Move a step so that it ends up at position `toIndex` of the new list. */
export function moveStep(list: StepList, id: string, toIndex: number): StepList {
  const from = indexOf(list, id)
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= list.steps.length) throw new MeshError('step.invalid', { reason: 'bad_index', index: toIndex }, 'steps')
  const steps = list.steps.slice(); const [s] = steps.splice(from, 1); steps.splice(toIndex, 0, s as Step)
  return withSteps(list, steps)
}

/** Insert a copy right after the original. */
export function duplicateStep(list: StepList, id: string, newId: string): StepList {
  const i = indexOf(list, id), s = list.steps[i] as Step
  return addStep(list, { ...s, id: newId, params: structuredCloneJson(s.params), personalisable_params: s.personalisable_params.slice() }, i + 1)
}

export function updateStep(list: StepList, id: string, patch: Partial<Omit<Step, 'id'>>): StepList {
  const i = indexOf(list, id)
  const steps = list.steps.slice(); steps[i] = { ...(steps[i] as Step), ...patch }
  return withSteps(list, steps)
}

export const setParams = (list: StepList, id: string, params: Record<string, unknown>): StepList => updateStep(list, id, { params })
export const setEnabled = (list: StepList, id: string, enabled: boolean): StepList => updateStep(list, id, { enabled })

/** Parameters are plain JSON, so a JSON round trip is a faithful deep copy. */
function structuredCloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

// ------------------------------------------------------------------ identity and hashing

/** What a step computes, without its identity: this is what the cache keys on. */
export function stepContent(s: Step): unknown {
  return { plugin: s.plugin, op: s.op, enabled: s.enabled, params: s.params }
}

/** Stable hash of a step list: identical across runs and machines. Pass `ignoreIds` to hash only what the steps compute. */
export function stepListHash(list: StepList, opts: { ignoreIds?: boolean } = {}): string {
  return hashJson({
    schema_version: list.schema_version,
    steps: list.steps.map(s => (opts.ignoreIds ? stepContent(s) : { id: s.id, ...(s.name ? { name: s.name } : {}), ...(stepContent(s) as object), personalisable: s.personalisable, personalisable_params: s.personalisable_params, ...(s.personalisable_limits ? { personalisable_limits: s.personalisable_limits } : {}) })),
  })
}

/** Index of the first step whose content differs between two lists, or -1 if they compute the same thing. */
export function firstChangedIndex(a: StepList, b: StepList): number {
  const n = Math.min(a.steps.length, b.steps.length)
  for (let i = 0; i < n; i++) if (hashJson(stepContent(a.steps[i] as Step)) !== hashJson(stepContent(b.steps[i] as Step))) return i
  return a.steps.length === b.steps.length ? -1 : n
}

// ------------------------------------------------------------------ JSON in and out

/** The plain JSON a host stores in a database column. Round-trips through `JSON.stringify` and `JSON.parse`. */
export function serializeStepList(list: StepList): { schema_version: 1; steps: Step[] } {
  return structuredCloneJson(list)
}

/**
 * Read a stored step list. Accepts the wrapped form `{ schema_version, steps }` and a bare array of steps
 * (treated as schema version 1). Checks the shape only; plugins and parameters are checked against a registry.
 */
export function parseStepList(input: unknown): ValidationResult<StepList | null> {
  const errors: StructuredError[] = []
  const bad = (reason: string, path: string, extra: Record<string, unknown> = {}): void => { errors.push({ code: 'step.invalid', params: { reason, ...extra }, path }) }
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  let raw: unknown
  if (Array.isArray(input)) raw = input
  else if (isObj(input)) {
    if (input['schema_version'] !== STEP_LIST_SCHEMA_VERSION) bad('unsupported_schema_version', 'schema_version', { found: input['schema_version'] ?? null })
    raw = input['steps']
  } else { bad('not_a_step_list', ''); return { ok: false, errors, value: null } }
  if (!Array.isArray(raw)) { bad('steps_not_an_array', 'steps'); return { ok: false, errors, value: null } }
  const steps: Step[] = []; const ids = new Set<string>()
  raw.forEach((s0: unknown, i: number) => {
    // step lists saved before the rename used `customer_params` and `customer_limits`
    const s = isObj(s0) ? { ...s0, ...(s0['personalisable_params'] === undefined && s0['customer_params'] !== undefined ? { personalisable_params: s0['customer_params'] } : {}), ...(s0['personalisable_limits'] === undefined && s0['customer_limits'] !== undefined ? { personalisable_limits: s0['customer_limits'] } : {}) } : s0
    if (isObj(s)) { delete s['customer_params']; delete s['customer_limits'] }
    const at = `steps[${i}]`
    if (!isObj(s)) return bad('step_not_an_object', at)
    if (typeof s['id'] !== 'string' || s['id'].length === 0) bad('missing_id', `${at}.id`)
    else if (ids.has(s['id'])) bad('duplicate_id', `${at}.id`, { id: s['id'] })
    else ids.add(s['id'])
    const pl = s['plugin']
    if (!isObj(pl) || typeof pl['id'] !== 'string' || !PLUGIN_ID_RE.test(pl['id']) || typeof pl['version'] !== 'string' || !SEMVER_RE.test(pl['version'])) bad('bad_plugin', `${at}.plugin`)
    if (typeof s['op'] !== 'string' || !ID_RE.test(s['op'])) bad('bad_op', `${at}.op`)
    if (typeof s['enabled'] !== 'boolean') bad('bad_enabled', `${at}.enabled`)
    if (s['name'] !== undefined && (typeof s['name'] !== 'string' || s['name'].length > 80)) bad('bad_name', `${at}.name`)
    if (!isObj(s['params'])) bad('bad_params', `${at}.params`)
    if (typeof s['personalisable'] !== 'boolean') bad('bad_personalisable', `${at}.personalisable`)
    if (!Array.isArray(s['personalisable_params']) || !s['personalisable_params'].every((x: unknown) => typeof x === 'string')) bad('bad_personalisable_params', `${at}.personalisable_params`)
    const cl = s['personalisable_limits']
    if (cl !== undefined) {
      const okN = (v: unknown): boolean => v === undefined || (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10000)
      if (!isObj(cl) || !Object.values(cl).every(l => isObj(l) && okN(l['max_lines']) && okN(l['max_line_length']))) bad('bad_personalisable_limits', `${at}.personalisable_limits`)
    }
    steps.push(s as unknown as Step)
  })
  return { ok: errors.length === 0, errors, value: errors.length === 0 ? { schema_version: STEP_LIST_SCHEMA_VERSION, steps } : null }
}
