// The project store (docs/proposals/project-store-plan.md): named payloads (meshes, drawings, any registered kind) that live in the project, next to the steps.
// A step takes one to the side of its main input through a `payload` parameter; the `store` and `load` operations move payloads in and out of the run.
// An entry is either IMPORTED (it lives in the project file and an editor can change it) or PRODUCED (a `store` step wrote it during the run).
import { MeshError } from './errors'
import type { StructuredError } from './errors'
import type { Manifest, Operation } from './manifest'
import { operationPayload, payloadKinds } from './payload'
import type { PayloadKindId } from './payload'
import type { PluginEntry, Registry } from './registry'
import type { StepResult } from './runner'
import type { Step, StepList } from './stack'
import type { Payload } from './types'
import { STORE_NAME_RE } from './validate'

export { STORE_NAME_RE }

/** The reserved name of the model the project started from. A `load` step (or any `payload` setting that takes a model) can name it, so a project can always go back to the original; a stored item or a `store` step cannot take the name. */
export const ORIGINAL_NAME = 'original'

/** One imported entry of the project store. */
/**
 * Where an entry's `payload` comes from, when it is derived from a file the person gave: for a drawing, the SVG. **The source is the single source of truth**: the payload is
 * extracted from it when it is imported (and checked then), is never edited on its own, and is rebuilt from the source when `importer` is not the current version of the
 * importer. Editing or replacing an entry means changing the source; the payload follows.
 */
export interface StoreSource {
  kind: 'svg'
  /** The file's text. */
  text: string
  /** `fill`: the filled areas; `line`: the strokes at their width. */
  mode: 'fill' | 'line'
  /** The version of the importer that made `payload` from `text` (`SVG_IMPORTER_VERSION` in `@ateliermesh/plugins`). */
  importer: number
}

/** The most text a source may have (an SVG is refused above 2 MB when it is imported). */
export const MAX_SOURCE_BYTES = 2_000_000

export interface StoreEntry {
  payload: Payload
  /** What `payload` was extracted from, if anything. Absent for an entry that is its own source (a stored model, a drawing made by a step). */
  source?: StoreSource
  /** May the customer replace or edit this entry? (A host reads it; the engine does not enforce it.) */
  personalisable?: boolean
  /** Tighter limits than the host's general budget, for what a customer may put here (a drawing: `maxPaths`, `maxPoints`). */
  limits?: { maxPaths?: number; maxPoints?: number; maxTriangles?: number; maxVertices?: number }
}

/** The imported entries by name. */
export type ProjectStore = Record<string, StoreEntry>

export const STORE_PLUGIN_ID = 'org.ateliermesh.store'
export const STORE_PLUGIN_VERSION = '1.0.0'

/**
 * The two generic operations. `store` saves a copy of what it receives under a name and passes it on unchanged; `load` ignores what it receives and
 * returns the entry of that name. The runner runs them itself (there is no plugin code), so a host only has to register this manifest: `registerStore(registry)`.
 */
export const storeManifest: Manifest = {
  manifest_version: 1,
  id: STORE_PLUGIN_ID,
  name: 'Project store',
  version: STORE_PLUGIN_VERSION,
  description: 'Keep the result of a step under a name, and bring a stored mesh or drawing back into the workflow.',
  contact: { url: 'https://micro-fabriek.be' },
  license: 'AGPL-3.0-or-later',
  operations: [
    {
      id: 'store', title: 'Store', kind: 'modifier', category: 'prepare', icon: 'archive', importance: 'low', summary: '{{name}}',
      payload: { in: '*', out: '*' },
      params: [{ name: 'name', type: 'string', label: 'Name', default: 'item', pattern: STORE_NAME_RE.source, min_length: 1, max_length: 40 }],
    },
    {
      id: 'load', title: 'Load', kind: 'generator', category: 'prepare', icon: 'archive-restore', importance: 'low', summary: '{{name}}',
      payload: { out: '*' },
      params: [{ name: 'name', type: 'payload', label: 'Stored item', default: null, accept: ['*'] }],
    },
  ],
}

/** The registry entry of the store operations. There is no plugin code: the runner runs them itself. */
export const storePlugin = (): PluginEntry => ({ manifest: storeManifest, load: () => ({ run: () => { throw new MeshError('plugin.failed', { reason: 'store_runs_in_the_runner' }) } }) })

/** Registers the `store` and `load` operations (a host that uses `registerBuiltInPlugins` from `@ateliermesh/plugins` gets them there). Use the same call in the page and in the worker. */
export function registerStore<R extends Registry>(registry: R): R {
  if (!registry.has(STORE_PLUGIN_ID)) registry.register(storePlugin())
  return registry
}

export type Availability =
  | { state: 'available' }
  /** `reason` is `needs.<kind>` (`needs.drawing`, `needs.mesh`: the input is not what the step takes) or `needs.stored` (`load` with an empty store). A menu shows it under the name. */
  | { state: 'disabled'; reason: string }

/**
 * Can this operation be added at this point? `kind` is what the previous step produced (or the source), `mesh` when unknown; `storeEntries` how many items the store holds
 * at that point. Simple on purpose: a step whose input is of another kind is disabled with a reason, nothing is hidden, and `load` needs something in the store.
 */
export function operationAvailability(pluginId: string, op: Pick<Operation, 'id' | 'kind' | 'payload'>, ctx: { kind?: string | null; storeEntries?: number }): Availability {
  if (pluginId === STORE_PLUGIN_ID && op.id === 'load') return (ctx.storeEntries ?? 0) > 0 ? { state: 'available' } : { state: 'disabled', reason: 'needs.stored' }
  if (op.kind === 'generator') return { state: 'available' }
  const wants = operationPayload(op).in
  const have = ctx.kind ?? 'mesh'
  return wants === '*' || wants === have ? { state: 'available' } : { state: 'disabled', reason: `needs.${wants}` }
}

export const isStoreStep = (s: Pick<Step, 'plugin'>): boolean => s.plugin.id === STORE_PLUGIN_ID

/**
 * The default budget of a project's store (design round 6): at most 20 items and 10 MB together. A host passes it as `limits` to `runWorkflow` and `loadProject` (the editor hooks
 * do), or its own numbers; the Atelier sets its own. Per-item limits (`StoreEntry.limits`) are separate and tighter.
 */
export const DEFAULT_STORE_LIMITS = { maxStoreEntries: 20, maxStoreBytes: 10 * 1024 * 1024 } as const satisfies StoreLimits

export interface StoreLimits {
  /** All imported entries together may take at most this many bytes (`PayloadKind.bytes`). */
  maxStoreBytes?: number
  /** At most this many imported entries. */
  maxStoreEntries?: number
}

/** The problem with an imported store, or null: names, kinds, shapes of the payloads, and the totals. Used on every store that comes from a file or from outside. */
export function storeProblem(store: ProjectStore, limits: StoreLimits = {}): StructuredError | null {
  const names = Object.keys(store)
  if (limits.maxStoreEntries !== undefined && names.length > limits.maxStoreEntries) return { code: 'budget.store_entries', params: { entries: names.length, max: limits.maxStoreEntries } }
  let bytes = 0
  for (const name of names) {
    if (!STORE_NAME_RE.test(name)) return { code: 'store.bad_name', params: { name } }
    const e = store[name] as StoreEntry
    const kind = e?.payload ? payloadKinds.kindOf(e.payload) : ''
    if (!payloadKinds.has(kind)) return { code: 'payload.unknown_kind', params: { kind, name } }
    const why = payloadKinds.problem(e.payload)
    if (why) return { code: 'store.bad_entry', params: { name, problem: why } }
    bytes += payloadKinds.bytes(e.payload)
    if (e.source !== undefined) {
      const src = e.source as Partial<StoreSource>
      const ok = src.kind === 'svg' && typeof src.text === 'string' && (src.mode === 'fill' || src.mode === 'line') && Number.isInteger(src.importer)
      if (!ok) return { code: 'store.bad_entry', params: { name, problem: 'bad source' } }
      if ((src.text as string).length > MAX_SOURCE_BYTES) return { code: 'store.bad_entry', params: { name, problem: 'source too large' } }
      bytes += (src.text as string).length
    }
  }
  if (limits.maxStoreBytes !== undefined && bytes > limits.maxStoreBytes) return { code: 'budget.store_bytes', params: { bytes, max: limits.maxStoreBytes } }
  return null
}

// ------------------------------------------------------------------ what is in the store

export interface StoreRow {
  name: string
  kind: PayloadKindId
  /** `project`: an imported entry. `step`: written by the `store` step `step` during the run. `original`: the model the project started from (read only, never counted in the budget). */
  origin: 'project' | 'step' | 'original'
  /** The id of the `store` step that writes it (origin `step`). */
  step?: string
  /** How big it is, by kind: a mesh has `triangles` and `vertices`, a drawing `paths` and `points`; every kind has `bytes`. Absent for a produced entry the run has not reached. */
  size?: { bytes: number; triangles?: number; vertices?: number; paths?: number; points?: number }
  personalisable?: boolean
  /** The entry was extracted from a file (`svg`): edit or replace the file, never the payload. */
  source?: { kind: StoreSource['kind']; mode: StoreSource['mode'] }
  /** The payload itself, for a thumbnail. Absent for a produced entry the run has not reached. */
  payload?: Payload
  /** Steps that read it (a `payload` parameter naming it), in step order. */
  usedBy: Array<{ step: string; param: string }>
  /** For a name no entry or `store` step provides: the steps that use it anyway. Such rows have `kind: ''` and `origin: 'project'`, and `missing: true`. */
  missing?: boolean
}

function sizeOf(p: Payload): NonNullable<StoreRow['size']> {
  const bytes = payloadKinds.bytes(p)
  const o = p as unknown as Record<string, unknown>
  if (payloadKinds.kindOf(p) === 'mesh') return { bytes, triangles: ((o['indices'] as Uint32Array).length / 3) | 0, vertices: ((o['positions'] as Float64Array).length / 3) | 0 }
  if (Array.isArray(o['paths'])) return { bytes, paths: o['paths'].length, points: (o['paths'] as Array<{ points: unknown[] }>).reduce((n, q) => n + q.points.length, 0) }
  return { bytes }
}

/**
 * Everything in the store, for a list in the editor: the imported entries (by name), then the entries `store` steps write (in step order), each with the steps that use it.
 * Names that steps use but nothing provides come last, marked `missing`. Pass the results of a run to fill in the produced entries.
 */
export function listStore(store: ProjectStore | undefined, list: StepList, opts: { registry?: Registry; results?: ReadonlyArray<StepResult | undefined>; /** The model the project started from: listed first as the read-only row `original` (only when the host asks, so a host that draws its own list is not changed). */ original?: Payload | null } = {}): StoreRow[] {
  const rows: StoreRow[] = []
  if (opts.original) rows.push({ name: ORIGINAL_NAME, kind: payloadKinds.kindOf(opts.original), origin: 'original', size: sizeOf(opts.original), payload: opts.original, usedBy: [] })
  const imported = store ?? {}
  for (const name of Object.keys(imported).sort()) {
    const e = imported[name] as StoreEntry
    rows.push({ name, kind: payloadKinds.kindOf(e.payload), origin: 'project', size: sizeOf(e.payload), ...(e.personalisable ? { personalisable: true } : {}), ...(e.source ? { source: { kind: e.source.kind, mode: e.source.mode } } : {}), payload: e.payload, usedBy: [] })
  }
  const uses: Array<{ name: string; step: string; param: string; after: number }> = []
  list.steps.forEach((s, i) => {
    if (isStoreStep(s) && s.op === 'store' && typeof s.params['name'] === 'string') {
      const r = opts.results?.[i]
      const made = r?.status === 'ok' ? r.payload : undefined
      rows.push({ name: s.params['name'], kind: made ? payloadKinds.kindOf(made) : '', origin: 'step', step: s.id, ...(made ? { size: sizeOf(made), payload: made } : {}), usedBy: [] })
    }
    const op = opts.registry?.operation(s.plugin.id, s.op)?.op
    for (const p of op?.params ?? []) if (p.type === 'payload' && typeof s.params[p.name] === 'string') uses.push({ name: s.params[p.name] as string, step: s.id, param: p.name, after: i })
  })
  const stepIndex = new Map(list.steps.map((s, i) => [s.id, i]))
  for (const u of uses) {
    // the nearest earlier `store` step with that name, else the imported entry
    let target: StoreRow | undefined
    for (let k = rows.length - 1; k >= 0; k--) { const r = rows[k] as StoreRow; if (r.name === u.name && r.origin === 'step' && (stepIndex.get(r.step as string) as number) < u.after) { target = r; break } }
    target ??= rows.find(r => r.name === u.name && r.origin === 'project')
    target ??= rows.find(r => r.name === u.name && r.origin === 'original')
    if (!target) { target = { name: u.name, kind: '', origin: 'project', missing: true, usedBy: [] }; rows.push(target) }
    target.usedBy.push({ step: u.step, param: u.param })
  }
  return rows
}
