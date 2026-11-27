// The project a person is editing, as a hook: the model, the steps, the store of drawings and models, undo and redo, running the steps and Apply permanently.
// A host (the standalone app, the Atelier) says how to run (registry, worker host, cache, assets, fonts) and does its own storage and file handling: this hook never
// touches IndexedDB, downloads or the page's layout, so every host gets the same behaviour for the same project.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { DEFAULT_STORE_LIMITS, STORE_NAME_RE, History, applyPermanently, applyRenames, createRunner, emptyStepList, followEarlierSteps, payloadKinds, saveProject, storeProblem } from '@ateliermesh/core'
import type { AssetResolver, ColourMap, FontService, RunListOptions, Mesh, PluginHost, PluginLockEntry, ProjectAsset, ProjectStore, Registry, ResultCache, StepList, StoreLimits, WorkflowResult } from '@ateliermesh/core'
import type { Payload, StructuredError } from '@ateliermesh/core'
import { importSvg } from '@ateliermesh/plugins'
import type { SvgImport } from '@ateliermesh/plugins'

/** The project: the model as it was given, the model the steps start from, the name, the steps, and the store the steps can use. */
/** `colours`: the design uses colour slots (present) or is one colour (absent). */
export interface ProjectDoc { base: Mesh; source: Mesh; name: string; list: StepList; rollback: string | null; store: ProjectStore; colours?: ColourMap }

interface Snap { list: string; rollback: string | null }

export interface SessionRuntime {
  registry: Registry
  host: PluginHost
  cache: ResultCache
  assets: AssetResolver
  fonts?: FontService
  /** The most triangles a step may start from. */
  maxTriangles: number
  /** The budget of the store (items and bytes). Default: `DEFAULT_STORE_LIMITS`, 20 items and 10 MB. */
  storeLimits?: StoreLimits
  /** Plugins that are still loading: `run` and `apply` wait for this, so the first run does not fail with `step.unknown_plugin` for a plugin that is not there yet. */
  ready?: Promise<unknown>
  /** Anything that changes what the steps can do (a plugin added or switched off): a new value makes `run` a new function, so the editor runs again. */
  version?: number
}

export interface StartOptions { list?: StepList; rollback?: string | null; store?: ProjectStore; colours?: ColourMap }

/** What changed the project, for `onChange`. */
export type ChangeWhy = 'start' | 'edit' | 'undo' | 'redo' | 'apply' | 'name' | 'store' | 'colours'

export interface SessionOptions {
  /** A project to start with, so the first render already has it (no `start()` from an effect). It is not a change: `onChange` is not called for it. */
  initial?: StartOptions & { mesh: Mesh; name: string }
  /** Called after the project changed (steps, name, store, undo, redo, apply, a new project), not for `initial` and not when the project is closed. */
  onChange?: (doc: ProjectDoc, why: ChangeWhy) => void
  /** Ctrl-Z, Ctrl-Shift-Z and Ctrl-Y on the whole page. Default true; false for a preview, an overlay or a frame inside someone else's page. */
  shortcuts?: boolean
}

export interface ProjectSession {
  doc: ProjectDoc | null
  /** The latest `doc`, for event handlers that must not be re-created on every change. */
  docRef: MutableRefObject<ProjectDoc | null>
  /** Begin a new project: the result cache and the undo history start over. Returns the project. */
  start(mesh: Mesh, name: string, opts?: StartOptions): ProjectDoc
  /** Leave the project (back to a start page). */
  close(): void
  setName(name: string): void
  /** The editor's change of the steps. Edits of one step within a short time are one undo step; `why` names the kind of change. */
  onListChange(next: StepList, why: string): void
  undo(): void
  redo(): void
  canUndo: boolean
  canRedo: boolean
  /** Run the steps on the model, with the store. The editor calls this on every change. */
  run(list: StepList, o: { signal: AbortSignal; onProgress?: (stepId: string, stage: string, fraction: number) => void; /** Apply a colour map to the result (see `RunListOptions.colours`). */ colours?: RunListOptions['colours'] }, quality?: 'preview' | 'export'): Promise<WorkflowResult>
  /** Bake every step into the model (`applyPermanently`): the steps leave the list, the name says so. Throws when a step fails. */
  apply(): Promise<void>
  /** Keep a drawing or model in the project's store under a name made from `hint` (made unique); returns the name, or null when that would go over the store's budget (nothing is added). */
  addStoredItem(hint: string, payload: Payload): string | null
  /** Put a drawing or model under exactly this name, replacing what is there (every step using the name follows). Returns false when the name is not a valid store name or the store would go over its budget (nothing changes). */
  putStoredItem(name: string, payload: Payload): boolean
  /**
   * Import an SVG into the store as a drawing: the SVG is kept as the source of truth, the drawing is extracted and checked now. `hint` (a file name) makes the name; refused with
   * the error to show (an `emboss.svg_*` code, or `budget.store_*` when the store is full) and nothing is stored. A drawing is never edited on its own: change it with `replaceStoredSvg`.
   */
  importStoredSvg(hint: string, svg: string, mode?: 'fill' | 'line', opts?: { name?: string; replace?: boolean }): { ok: true; name: string; imported: SvgImport } | { ok: false; error: StructuredError }
  /** Several colours: keep the colour slots of this design (`ColourMap`), or `null` for one colour. The design file saves them. Not part of undo. */
  setColours(map: ColourMap | null): void
  /** Take an item out of the store. The steps that use its name stop with `input.missing_payload` (recoverable: choose or import another). Nothing happens for a name that is not there. */
  removeStoredItem(name: string): void
  /** Replace the SVG of an imported drawing under the same name (every step that uses it follows), keeping its flags and limits; `mode` switches Fill and Line. */
  replaceStoredSvg(name: string, svg: string, mode?: 'fill' | 'line'): { ok: true; imported: SvgImport } | { ok: false; error: StructuredError }
  /** A string that changes when the project changes, to tell whether it has unsaved changes. */
  signature(d: ProjectDoc): string
  /** The project file for this document. The host adds what only it knows: the files steps use, the plugins, a preview picture. */
  projectBytes(d: ProjectDoc, extra?: { name?: string; preview?: Uint8Array; plugins?: PluginLockEntry[]; assets?: ProjectAsset[] }): Uint8Array
}

/** A name for a stored item from a file name: lowercase letters, digits and underscores, starting with a letter, at most 36 characters, not one already in `taken`. */
export function storedName(hint: string, taken: ProjectStore): string {
  const base = (hint.replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '') || 'item').slice(0, 36)
  let name = base, n = 2
  while (taken[name]) name = `${base}_${n++}`
  return name
}

export const projectSignature = (d: ProjectDoc): string => JSON.stringify([d.name, d.list, d.rollback, d.colours ?? null, Object.entries(d.store).map(([k, e]) => `${k}:${payloadKinds.key(e.payload)}`), d.base.indices.length, d.base.positions.length])

export function useProjectSession(rt: SessionRuntime, options: SessionOptions = {}): ProjectSession {
  const rtRef = useRef(rt); rtRef.current = rt
  const makeDoc = (mesh: Mesh, name: string, o: StartOptions): ProjectDoc => ({ base: mesh, source: mesh, name, list: applyRenames(o.list ?? emptyStepList(), rtRef.current.registry).list, rollback: o.rollback ?? null, store: o.store ?? {}, ...(o.colours ? { colours: o.colours } : {}) })
  const [initialDoc] = useState<ProjectDoc | null>(() => (options.initial ? makeDoc(options.initial.mesh, options.initial.name, options.initial) : null))
  const [doc, setDoc] = useState<ProjectDoc | null>(initialDoc)
  const docRef = useRef(doc); docRef.current = doc
  const history = useRef<History<Snap> | null>(null)
  if (!history.current) history.current = new History<Snap>(initialDoc ? { list: JSON.stringify(initialDoc.list), rollback: initialDoc.rollback } : { list: JSON.stringify(emptyStepList()), rollback: null })
  const hist = history.current
  const [, bump] = useState(0)

  // what changed the project, for `onChange`: noted just before the project is set, read after it has changed
  const whyRef = useRef<ChangeWhy>('start')
  const notified = useRef<ProjectDoc | null>(initialDoc)   // the first project is not a change
  const onChangeRef = useRef(options.onChange); onChangeRef.current = options.onChange
  useEffect(() => { if (doc && doc !== notified.current) { notified.current = doc; onChangeRef.current?.(doc, whyRef.current) } }, [doc])
  const change = useCallback((why: ChangeWhy, next: ProjectDoc | ((d: ProjectDoc | null) => ProjectDoc | null)): void => { whyRef.current = why; setDoc(next) }, [])

  const start = useCallback((mesh: Mesh, name: string, opts: StartOptions = {}): ProjectDoc => {
    const d = makeDoc(mesh, name, opts)
    rtRef.current.cache.clear()
    hist.clear({ list: JSON.stringify(d.list), rollback: d.rollback })
    change('start', d)
    return d
  }, [change, hist])
  const close = useCallback((): void => { setDoc(null) }, [])
  const setName = useCallback((name: string): void => { change('name', d => (d ? { ...d, name } : d)) }, [change])

  const onListChange = useCallback((next: StepList, why: string): void => {
    change('edit', d => {
      if (!d) return d
      hist.push({ list: JSON.stringify(next), rollback: d.rollback }, why === 'edit' ? 'edit' : `${why}:${Date.now()}`)
      return { ...d, list: next }
    })
    bump(n => n + 1)
  }, [change, hist])
  const restore = useCallback((s: Snap | undefined, why: 'undo' | 'redo'): void => { if (s) { change(why, d => (d ? { ...d, list: JSON.parse(s.list) as StepList, rollback: s.rollback } : d)); bump(n => n + 1) } }, [change])
  const undo = useCallback((): void => restore(hist.undo(), 'undo'), [restore, hist])
  const redo = useCallback((): void => restore(hist.redo(), 'redo'), [restore, hist])
  const shortcuts = options.shortcuts !== false
  useEffect(() => {
    if (!shortcuts) return
    const fn = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod || (e.target as HTMLElement).closest?.('input, textarea, select')) return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo() } else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo() }
    }
    addEventListener('keydown', fn); return () => removeEventListener('keydown', fn)
  }, [undo, redo, shortcuts])

  const run = useCallback<ProjectSession['run']>((list, o, quality = 'preview') => {
    const d = docRef.current
    // the shared headless runner: the same preparation of steps, rollback marker and budgets as every other host that runs a list
    return createRunner(rtRef.current).runList(list, { source: d?.base ?? null, store: d?.store ?? {}, rollback: d?.rollback ?? null, quality, signal: o.signal, ...(o.onProgress ? { onProgress: o.onProgress } : {}), ...(o.colours ? { colours: o.colours } : {}) })
    // a new model, rollback marker, store or plugin set makes the editor run again: it watches this function
  }, [doc?.base, doc?.rollback, doc?.store, rt.version])

  const apply = useCallback(async (): Promise<void> => {
    const d = docRef.current, r = rtRef.current
    if (!d) return
    if (r.ready) await r.ready
    const { state: next, event } = await applyPermanently({ base: d.base, list: d.list, rollback: d.rollback }, { registry: r.registry, host: r.host, cache: r.cache, prepareStep: followEarlierSteps(), quality: 'export', assets: r.assets, ...(r.fonts ? { fonts: r.fonts } : {}), store: d.store, limits: { ...(r.storeLimits ?? DEFAULT_STORE_LIMITS) } })
    r.cache.clear(); hist.clear({ list: JSON.stringify(next.list), rollback: next.rollback })
    change('apply', { ...d, base: next.base as Mesh, list: next.list, rollback: next.rollback, name: `${d.name} (applied ${event.applied})` })
  }, [change, hist])

  const addStoredItem = useCallback((hint: string, payload: Payload): string | null => {
    const store = docRef.current?.store ?? {}
    const name = storedName(hint, store)
    if (storeProblem({ ...store, [name]: { payload } }, rtRef.current.storeLimits ?? DEFAULT_STORE_LIMITS)) return null
    change('store', d => (d ? { ...d, store: { ...d.store, [name]: { payload } } } : d))
    return name
  }, [])

  const putStoredItem = useCallback((name: string, payload: Payload): boolean => {
    if (!STORE_NAME_RE.test(name)) return false
    const store = docRef.current?.store ?? {}
    const next = { payload }   // not the old entry's SVG source: it would no longer describe the payload
    if (storeProblem({ ...store, [name]: next }, rtRef.current.storeLimits ?? DEFAULT_STORE_LIMITS)) return false
    change('store', d => (d ? { ...d, store: { ...d.store, [name]: next } } : d))
    return true
  }, [change])

  const asError = (e: unknown): StructuredError => { const x = e as { code?: string; params?: Record<string, unknown> }; return { code: typeof x?.code === 'string' ? x.code : 'import.invalid_drawing', ...(x?.params ? { params: x.params } : {}) } }
  const importStoredSvg = useCallback<ProjectSession['importStoredSvg']>((hint, svg, mode, opts = {}) => {
    let imported: SvgImport
    try { imported = importSvg(svg, mode ? { mode } : {}) } catch (e) { return { ok: false, error: asError(e) } }
    const store = docRef.current?.store ?? {}
    // an exact name (the Import dialog's field): checked, and refused when taken unless the person chose to replace the old one
    if (opts.name !== undefined && !STORE_NAME_RE.test(opts.name)) return { ok: false, error: { code: 'store.bad_name', params: { name: opts.name } } }
    if (opts.name !== undefined && store[opts.name] && !opts.replace) return { ok: false, error: { code: 'store.name_taken', params: { name: opts.name } } }
    const name = opts.name ?? storedName(hint, store)
    const why = storeProblem({ ...store, [name]: imported.entry }, rtRef.current.storeLimits ?? DEFAULT_STORE_LIMITS)
    if (why) return { ok: false, error: why }
    change('store', d => (d ? { ...d, store: { ...d.store, [name]: imported.entry } } : d))
    return { ok: true, name, imported }
  }, [])
  // a plugin that was installed while the project is open can replace the plugin a step was saved with: the step then gets the new id (and its form), without a reload
  useEffect(() => {
    const d = docRef.current
    if (!d) return
    const r = applyRenames(d.list, rtRef.current.registry)
    if (r.renamed.length > 0) change('edit', x => (x ? { ...x, list: r.list } : x))
  }, [rt.version, change])
  const setColours = useCallback((map: ColourMap | null): void => {
    change('colours', d => { if (!d) return d; const { colours: _old, ...rest } = d; return map ? { ...rest, colours: map } : rest })
  }, [change])
  const removeStoredItem = useCallback((name: string): void => {
    if (!docRef.current?.store[name]) return
    change('store', d => { if (!d) return d; const { [name]: _gone, ...rest } = d.store; return { ...d, store: rest } })
  }, [change])
  const replaceStoredSvg = useCallback<ProjectSession['replaceStoredSvg']>((name, svg, mode) => {
    const old = docRef.current?.store[name]
    if (!old) return { ok: false, error: { code: 'input.missing_payload', params: { name } } }
    let imported: SvgImport
    try { imported = importSvg(svg, { mode: mode ?? old.source?.mode ?? 'fill' }) } catch (e) { return { ok: false, error: asError(e) } }
    const next = { ...old, payload: imported.entry.payload, source: imported.entry.source }
    const why = storeProblem({ ...(docRef.current?.store ?? {}), [name]: next }, rtRef.current.storeLimits ?? DEFAULT_STORE_LIMITS)
    if (why) return { ok: false, error: why }
    change('store', d => (d ? { ...d, store: { ...d.store, [name]: next } } : d))
    return { ok: true, imported }
  }, [])

  const projectBytes = useCallback<ProjectSession['projectBytes']>((d, extra = {}) => saveProject({
    ...(extra.preview ? { preview: extra.preview } : {}), ...(extra.plugins ? { plugins: extra.plugins } : {}),
    name: extra.name ?? d.name, base: d.base, list: d.list, rollback: d.rollback, store: d.store, ...(d.colours ? { colours: d.colours } : {}), assets: extra.assets ?? [],
  }), [])

  return { doc, docRef, start, close, setName, onListChange, undo, redo, canUndo: hist.canUndo, canRedo: hist.canRedo, run, apply, addStoredItem, putStoredItem, removeStoredItem, setColours, importStoredSvg, replaceStoredSvg, signature: projectSignature, projectBytes }
}
