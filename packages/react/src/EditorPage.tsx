// The editor page: the step list on the left, the 3D view in the middle, the settings of the selected step on the right.
// On a phone the view fills the screen and the list and the settings sit in a bottom sheet.
// The host owns the list (`list` / `onListChange`, so it can keep the undo history and save it), the engine (`run`), three.js,
// the language, and everything around the editor: the Atelier's own column (`aside`), the buttons in the top bar (`actions`), files.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { DEFAULT_MAX_COLOURS, applyColourMap, uniqueOutputSegments, checkPartReferences, cumulativeMatrix, groupNames, makeStep, meshReport, moveStep, payloadKindOf, segmentTable, stepPersonalisable } from '@ateliermesh/core'
import type { Mesh, Operation, ParamDef, PartSet, PlacementValue, Registry, Step, StepList, WorkflowResult } from '@ateliermesh/core'
import { describeProblem } from '@ateliermesh/ui'
import type { ThreeModule, Viewer } from '@ateliermesh/ui'
import { orderHints } from '@ateliermesh/plugins'
import { BottomSheet } from './BottomSheet'
import { PicturesContext } from './PictureGrid'
import type { PictureLibrary } from './PictureGrid'
import type { SheetHeight } from './BottomSheet'
import { Dialog, useMediaQuery } from './common'
import { CrashBanner, useRegistryVersion } from './CrashBanner'
import { tx } from './common'
import type { T } from './common'
import { LeaveDialog, PluginManager, SettingsDialog, useLeaveGuard } from './Dialogs'
import { SettingsShell } from './SettingsShell'
import type { CatalogueCard, PluginManagerProps, SettingsDialogProps } from './Dialogs'
import type { SettingsShellProps } from './SettingsShell'
import { AddStepMenu } from './AddStepMenu'
import { ApplyRecipeDialog, SaveRecipeDialog } from './RecipeDialogs'
import type { RecipesHost } from './RecipeDialogs'
import { ModelView } from './PersonaliseOverlay'
import type { FontChoice } from './PersonaliseOverlay'
import type { RunWorkflow } from './PersonaliseOverlay'
import { Icon } from './icons'
import { PartsList } from './PartsList'
import { CenterLoader, WorkingRow, useAnnouncement, useProgress, useWorking } from './Working'
import { StepForm, formSupported } from './StepForm'
import { ProblemLine, StepNotes, StepListView, stepName } from './StepListView'
import { PrintReportCard } from './PrintReport'
import { StepMenu } from './StepMenu'
import { EditableTitle } from './EditableTitle'
import { StoreProvider, StoredPanel, makeStoreView, storedTabState } from './Store'
import type { StoreHost } from './Store'
import { ColoursPanel, slotShownColour } from './Colours'
import { ColumnTabs } from './ColumnTabs'
import type { ColumnTab } from './ColumnTabs'
import type { ColoursHost } from './Colours'
import { PersonaliseBox, PlacementBox } from './DesignerBoxes'

/** What a host can read from the editor, for its own toolbar and its own "Next" button. */
export interface EditorState {
  personalised: boolean
  /** Steps a customer can change. */
  personalisableSteps: number
  /** A step failed, or a plugin was switched off after a crash. */
  hasError: boolean
  /** Of the last good result; null before there is one. */
  closedSolid: boolean | null
  /** Millimetres, of the last good result; null before there is one. */
  size: { w: number; h: number; d: number } | null
  /** A step is being calculated. */
  running: boolean
}

/** The commands a host can give through a ref. The list, the history and the customer preview stay with the host (the editor is controlled). */
export interface EditorHandle {
  /** The same as the switch: turning it off with personalisable steps asks first. Resolves true when it changed, false when the user cancelled. */
  requestPersonalised(on: boolean): Promise<boolean>
  getState(): EditorState
}

export interface EditorPageProps {
  t: T
  registry: Registry
  three: ThreeModule
  list: StepList
  onListChange: (list: StepList, why: 'edit' | 'order' | 'enabled' | 'delete' | 'add' | 'personalise' | 'fix' | 'recipe') => void
  run: RunWorkflow
  /** The mesh the list starts from, for the part names a step can pick and the first segment table. */
  source?: Mesh | null
  /** The parts the file already has, for the check that a step's part exists. */
  baseParts?: PartSet
  file?: { name: string; width?: number } | null
  /** `designer`: inside the Atelier, with the per-design "Personalised design" switch. `standalone`: the switch needs the Settings option. */
  mode: 'standalone' | 'designer'
  personalised: boolean
  onPersonalised?: (on: boolean) => void
  /** Standalone: the Settings dialog and its one option. */
  settings?: { showPersonalised: boolean; onShowPersonalised: (on: boolean) => void; maxColours?: NonNullable<SettingsDialogProps['maxColours']>; catalog?: NonNullable<SettingsDialogProps['catalog']>; about?: NonNullable<SettingsDialogProps['about']>; /** With the plugins, the settings get tabs (General, Plugins, Catalogues) and these are the catalogues. */ catalogues?: CatalogueCard[]; /** Adding and removing catalogues. */ catalogueActions?: SettingsShellProps['catalogueActions'] }
  plugins?: Omit<PluginManagerProps, 't' | 'onClose'>
  /** The project's store (`useStoreHost`): adds the Stored tab, the picker for stored-item settings and the Import SVG dialog. Without it a stored-item setting keeps the host's own picker. */
  store?: StoreHost | null
  /** Several colours: adds the Colours tab, where the designer switches them on for this design and maps parts to colour slots. Without it the editor has no colour settings. */
  colours?: ColoursHost
  /** Values a new step starts with on top of the manifest's defaults, for example the shop's default font for a text step. */
  stepDefaults?: (pluginId: string, opId: string) => Record<string, unknown>
  /** The host opens its own picker for fonts and images. */
  onAsset?: (stepId: string, param: string, def: ParamDef) => void
  /** Logo and name at the left of the top bar (standalone). In the Atelier the host's own bar is used instead. */
  brand?: ReactNode
  /** A page heading that only a screen reader sees, for a host with no heading of its own (the standalone). */
  title?: string
  /** The path in the top bar. The design has none any more; kept so a host can still pass it. */
  crumbs?: string[]
  /** The fonts the font cards offer (id and family); the host loads and previews them. Without it a font parameter keeps the host's own picker. */
  fonts?: FontChoice[]
  /** The pictures a picture setting (`widget: "gallery"`) offers as a grid with thumbnails; without it the host's own picker opens. */
  pictures?: PictureLibrary
  /** "Apply permanently…" in the step menu: the host asks first and bakes the steps in. `canApply` false shows it disabled. */
  onApply?: () => void
  canApply?: boolean
  /** The end of the top bar, after the gear: the theme toggle and the language pills. */
  barEnd?: ReactNode
  /** Buttons at the right of the top bar: Export, Save, Next: preview, Preview as customer. */
  actions?: ReactNode
  /** The Atelier's own column (material, precision, infill, price) under the step settings. */
  aside?: ReactNode
  /** Recipes (an export of the steps you have): the list, the storage and the files belong to the host. Without it the Recipes entries are not shown. */
  recipes?: RecipesHost
  undo?: { canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void }
  /** Unsaved changes: the page warns before a reload and asks before `onLeave`. */
  dirty?: boolean
  savedAt?: string | null
  onSave?: () => Promise<void> | void
  /** "Open another file". When the page has unsaved changes the leave dialog comes first. */
  onLeave?: () => void
  onResult?: (result: WorkflowResult | null, shown: Mesh | null) => void
  onViewer?: (viewer: Viewer | null) => void
  debounceMs?: number
  /** `none`: no top bar at all (brand, undo/redo, the Personalised switch, actions, settings, bar end, open file). The host draws its own. Default `full`. */
  chrome?: 'full' | 'none'
  /** `embedded`: one column on the left (steps, then the selected step's settings, then `aside`) and the view on the rest. Default `columns`. */
  layout?: 'columns' | 'embedded'
  /** Phone: extra tabs in the bottom sheet, after the Steps tab. */
  sheetTabs?: Array<{ id: string; label: string; content: ReactNode; /** A name from the icon set (`printer`, `list-checks`...) shown above the label; a plain info icon without one. */ icon?: string }>
  /** Phone: the selected tab (`steps` or a `sheetTabs` id). Without it the editor keeps it. */
  sheetTab?: string
  onSheetTab?: (id: string) => void
  /** Phone: a bar under the sheet that stays visible at every height. */
  sheetFooter?: ReactNode
  /** Phone: the height the sheet starts at (default `half`). */
  sheetStart?: SheetHeight
  /** Phone: remember the sheet's height under this key in the browser (`localStorage`; a failure only means no memory). It wins over `sheetStart` once something is saved. */
  sheetRemember?: string
  /** Deprecated: the switcher of the design (56 px tabs, icon over the label) replaces the compact strip; this no longer changes anything. */
  compactTabs?: boolean
  /** Where the status line (closed solid, size, triangles) goes: `bar` (default) along the bottom of the view, `chip` a small pill at the top left of the view, `none` not drawn (a screen reader still gets it). */
  statusLine?: 'bar' | 'chip' | 'none'
  /** Embedded layout and phone sheet: a block at the very top of the left column (the sheet's first tab), above the steps. */
  header?: ReactNode
  /** Called when a field of the state changes (and once at the start). */
  onState?: (state: EditorState) => void
}

const nextId = (list: StepList): string => `s${list.steps.reduce((m, s) => Math.max(m, Number(/^s(\d+)$/.exec(s.id)?.[1] ?? 0)), 0) + 1}`

/** A setting's value by its path: `name`, or `list.2.field` for a field in a row of a list (several clicked points). */
function valueAtPath(params: Record<string, unknown>, path: string): unknown {
  const [name, row, field] = path.split('.')
  const top = params[name as string]
  if (row === undefined || field === undefined) return top
  return Array.isArray(top) ? (top[Number(row)] as Record<string, unknown> | undefined)?.[field] : undefined
}
function withValueAtPath(params: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const [name, row, field] = path.split('.')
  if (row === undefined || field === undefined) return { ...params, [path]: value }
  const rows = Array.isArray(params[name as string]) ? [...(params[name as string] as Array<Record<string, unknown>>)] : []
  rows[Number(row)] = { ...(rows[Number(row)] ?? {}), [field]: value }
  return { ...params, [name as string]: rows }
}

export const EditorPage = forwardRef<EditorHandle, EditorPageProps>(function EditorPage(props, ref): ReactElement {
  const { t, registry, three, list, onListChange, run, mode, debounceMs = 150 } = props
  const phone = useMediaQuery('(max-width: 768px)')
  const embedded = props.layout === 'embedded'
  const [ownTab, setOwnTab] = useState('steps')
  const tabs = props.sheetTabs ?? []
  const storeOn = !!props.store
  const coloursOn = !!props.colours
  const [leftTab, setLeftTab] = useState<'steps' | 'stored' | 'colours'>('steps')   // the left column on a wide screen
  const [showMapped, setShowMappedState] = useState<boolean>(() => { try { return localStorage.getItem('am.showMapped') === '1' } catch { return false } })
  const setShowMapped = (on: boolean): void => { setShowMappedState(on); try { localStorage.setItem('am.showMapped', on ? '1' : '0') } catch { /* private window */ } }
  const tab = tabs.some(x => x.id === (props.sheetTab ?? ownTab)) || (storeOn && (props.sheetTab ?? ownTab) === 'stored') || (coloursOn && (props.sheetTab ?? ownTab) === 'colours') ? (props.sheetTab ?? ownTab) : 'steps'
  const pickTab = (id: string): void => { setOwnTab(id); props.onSheetTab?.(id) }
  const [selected, setSelected] = useState<string | null>(list.steps[0]?.id ?? null)
  const [upTo, setUpTo] = useState<string | null>(null)
  // "Up to this step" follows the selected step: picking another step moves the view to it (it used to stay on the first one)
  useEffect(() => { if (selected) setUpTo(u => (u !== null && u !== selected ? selected : u)) }, [selected])
  const [result, setResult] = useState<WorkflowResult | null>(null)
  const [good, setGood] = useState<WorkflowResult | null>(null)
  // what the last step produced, for the Add a step menu (a step that takes another kind is shown disabled); a model when nothing has run
  const lastPayload = result?.payload ?? good?.payload
  const lastKind = lastPayload ? payloadKindOf(lastPayload) : null
  // the project's store, for the Stored tab and the pickers of stored-item settings: who uses what comes from the steps and the last run
  const storeView = useMemo(() => (props.store ? makeStoreView(props.store, list, registry, (result ?? good)?.results, props.source) : null), [props.store, list, registry, result, good, props.source])   // the last good run fills in what `store` steps made while a new run is under way
  const stored = storeView ? storedTabState(storeView.rows) : { count: 0, missing: 0 }
  const [running, setRunning] = useState(false)
  const [dialog, setDialog] = useState<null | 'plugins' | 'settings' | 'leave' | 'switchOff' | 'saveRecipe' | 'applyRecipe'>(null)
  const [sheet, setSheetState] = useState<SheetHeight>(() => {
    try { const v = props.sheetRemember ? localStorage.getItem(props.sheetRemember) : null; if (v === 'peek' || v === 'half' || v === 'full') return v } catch { /* no storage */ }
    return props.sheetStart ?? 'half'
  })
  const setSheet = (h: SheetHeight | ((h: SheetHeight) => SheetHeight)): void => {
    setSheetState(prev => {
      const next = typeof h === 'function' ? h(prev) : h
      if (props.sheetRemember && next !== prev) { try { localStorage.setItem(props.sheetRemember, next) } catch { /* no storage */ } }
      return next
    })
  }
  const [placing, setPlacing] = useState<{ stepId: string; param: string } | null>(null)
  const [viewerNow, setViewerNow] = useState<Viewer | null>(null)

  const switchVisible = mode === 'designer' || !!props.settings?.showPersonalised
  const ticks = switchVisible && props.personalised
  const step = list.steps.find(s => s.id === selected) ?? null
  const stepId = step?.id
  const opOf = (s: Step): Operation | undefined => registry.operation(s.plugin.id, s.op)?.op
  // a plugin switched off (after a crash) or on again changes what the steps do: run again
  const regVersion = useRegistryVersion(registry)

  // ---- running: after each change, debounced; the last good result stays on screen
  const visible = useMemo(() => {
    const i = upTo ? list.steps.findIndex(s => s.id === upTo) : -1
    return i >= 0 ? { ...list, steps: list.steps.slice(0, i + 1) } : list
  }, [list, upTo])
  const runId = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const { progress, report: onProgress, reset: clearProgress } = useProgress()
  const working = useWorking(running)
  const announce = useAnnouncement(working, t)
  useEffect(() => {
    const mine = ++runId.current
    const ac = new AbortController(); abortRef.current = ac
    setRunning(true); clearProgress()
    const timer = setTimeout(() => {
      run(visible, { signal: ac.signal, onProgress }).then(res => {
        if (mine !== runId.current) return
        setResult(res); setRunning(false)
        if (res.ok) setGood(res)
      }, () => { if (mine === runId.current) setRunning(false) })
    }, debounceMs)
    return () => { clearTimeout(timer); ac.abort() }
  }, [visible, run, debounceMs, regVersion, onProgress, clearProgress])

  const shown = good?.mesh ?? result?.mesh ?? props.source ?? null
  // "Show on the model" for a warning that says where it happened: the triangles are lit and the points get a marker. The place refers to the step's own result,
  // so the view moves to "up to this step" when a later step is shown.
  const [warnAt, setWarnAt] = useState<{ stepId: string; index: number } | null>(null)
  useEffect(() => { setWarnAt(w => (w && w.stepId !== stepId ? null : w)) }, [stepId])
  useEffect(() => {
    if (!viewerNow || !warnAt) return
    const n = visible.steps.length
    if (n === 0 || visible.steps[n - 1]!.id !== warnAt.stepId || !result?.ok) return
    const where = (result.results[n - 1]?.warnings ?? []).filter(w => !w.code.startsWith('printcheck.'))[warnAt.index]?.where
    if (!where) return
    if (where.triangles?.length) viewerNow.highlight(where.triangles, '#dc2626')
    let drop: (() => void) | undefined
    const pts = where.points
    if (pts?.length) {
      // a marker the size of about 1.5 % of the model, drawn on top of it so it is found even inside a wall
      const P = result.mesh?.positions
      let diag = 40
      if (P && P.length >= 3) { const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < P.length; i += 3) for (let a = 0; a < 3; a++) { const x = P[i + a]!; if (x < lo[a]!) lo[a] = x; if (x > hi[a]!) hi[a] = x }; diag = Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) || 40 }
      drop = viewerNow.addOverlay(({ three: T, toView }) => {
        const g = new T.Group()
        for (const p of pts) {
          const m = new T.Mesh(new T.SphereGeometry(diag * 0.015, 14, 10), new T.MeshBasicMaterial({ color: 0xdc2626, depthTest: false, transparent: true, opacity: 0.9 }))
          const v = toView(p); m.position.set(v[0], v[1], v[2]); m.renderOrder = 999; g.add(m)
        }
        return g
      })
    }
    return () => { viewerNow.highlight(null); drop?.() }
  }, [viewerNow, warnAt, visible, result])
  // "Show mapped colours": the model as the colour slots would paint it (parts no slot has keep their own colours); off: every part in its own colour
  const coloursMap = props.colours?.map ?? null, slotColours = props.colours?.colours
  const viewMesh = useMemo(() => {
    if (!showMapped || !coloursMap || !shown) return shown
    try { return applyColourMap(shown, coloursMap, { mode: 'edit', colours: Object.fromEntries(coloursMap.slots.map((x, i) => [x.id, { color: slotShownColour(x, i, slotColours) }])) }) } catch { return shown }   // a map with a problem is shown to the designer in the panel
  }, [shown, showMapped, coloursMap, slotColours])
  const onResult = props.onResult
  useEffect(() => { onResult?.(result, shown) }, [result, shown, onResult])

  const report = useMemo(() => (shown && shown.indices.length < 400_000 ? meshReport(shown) : null), [shown])
  const closed = report ? !report.issues.includes('not_watertight') : null

  const hints = useMemo(() => orderHints(list, id => (result?.results[list.steps.findIndex(s => s.id === id)]?.report as { factor?: number } | undefined)?.factor), [list, result])
  const partIssues = useMemo(() => checkPartReferences(list, registry, props.baseParts), [list, registry, props.baseParts])
  const blocking = !!result?.results.some(r => r.error && describeProblem(r.error.code, r.error.params as Record<string, unknown> | undefined).blocks)

  // ---- edits
  // recipes: after a recipe is applied the first new step is selected, and a step that needs a place on the model starts the "click to place" mode
  const needsPlace = (l: StepList, ids: string[]): Step | undefined => ids.map(id => l.steps.find(x => x.id === id)).find(st => !!st && !!registry.operation(st.plugin.id, st.op)?.op.params.some(pp => pp.type === 'placement' && !st.params[pp.name]))
  const startPlacing = (l: StepList, ids: string[]): void => {
    const np = needsPlace(l, ids)
    const first = np ?? l.steps.find(x => x.id === ids[0])
    if (first) { setSelected(first.id); if (phone) setSheet(h => (h === 'peek' ? 'half' : h)) }
    const pp = np ? registry.operation(np.plugin.id, np.op)?.op.params.find(x => x.type === 'placement') : undefined
    if (np && pp) { setPlacing({ stepId: np.id, param: pp.name }); if (phone) setSheet('peek') }
  }
  const onRecipeApplied = (next: StepList, added: string[]): void => { onListChange(next, 'recipe'); setUpTo(null); startPlacing(next, added) }
  // the buttons of a store problem: choose a drawing, import an SVG (the picker of that step answers), or open the Stored tab
  const storeAction = (action: 'choose' | 'import' | 'open_stored', stepId: string): void => {
    if (action === 'open_stored') { setLeftTab('stored'); if (phone) pickTab('stored'); return }
    window.dispatchEvent(new CustomEvent('am-store-action', { detail: { stepId, action } }))
  }
  const select = (id: string): void => { setSelected(id); if (phone) setSheet(h => (h === 'peek' ? 'half' : h)) }
  const changeList = useCallback((next: StepList, why: Parameters<EditorPageProps['onListChange']>[1]): void => {
    onListChange(next, why)
    if (why === 'delete' && selected && !next.steps.some(s => s.id === selected)) setSelected(next.steps[0]?.id ?? null)
    if (upTo && !next.steps.some(s => s.id === upTo)) setUpTo(null)
  }, [onListChange, selected, upTo])
  const [note, setNote] = useState('')
  const moveTo = (id: string, to: number): void => {
    const i = list.steps.findIndex(x => x.id === id)
    if (to < 0 || to >= list.steps.length || to === i) return
    changeList(moveStep(list, id, to), 'order')
    const x = list.steps[i]; setNote(t('order.moved', { step: x ? stepName(t, registry, x) : id, n: to + 1 }))
  }
  const addStep = (pluginId: string, opId: string): void => {
    const found = registry.operation(pluginId, opId)
    if (!found) return
    const params = { ...Object.fromEntries(found.op.params.filter(p => p.default !== undefined).map(p => [p.name, p.default])), ...(props.stepDefaults?.(pluginId, opId) ?? {}) }
    // a part parameter that asks for it starts on the first part of what the step will receive (a body, else a labelled segment)
    for (const pp of found.op.params) {
      if (pp.type !== 'part' || pp.preselect !== 'first' || params[pp.name]) continue
      const m = result?.mesh ?? props.source ?? null
      const bodies = m ? groupNames(m) : [], segs = m ? segmentTable(m).filter(x => x.id !== 0).map(x => x.name) : []
      const first = (!pp.kinds || pp.kinds.includes('group') ? bodies[0] : undefined) ?? (!pp.kinds || pp.kinds.includes('segment') ? segs[0] : undefined)
      if (first) params[pp.name] = !pp.kinds || pp.kinds.length > 1 ? (bodies.includes(first) && segs.includes(first) ? `group:${first}` : first) : first
    }
    // two steps of one kind must not write into the same segment (one part, one colour): a new step starts with names no earlier step uses (`text`, then `text_2`, ...)
    Object.assign(params, uniqueOutputSegments(list, registry, found.op, params))
    const bare = makeStep({ id: nextId(list), plugin: { id: pluginId, version: found.manifest.version }, op: opId, params })
    // the name starts as the type of the step, with a number when that name is taken ("Text", "Text 2", "Text 3")
    const base = stepName(t, registry, bare)
    const used = new Set(list.steps.map(x => stepName(t, registry, x).toLowerCase()))
    let name = base
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} ${n}`
    const s = { ...bare, name } as Step
    onListChange({ ...list, steps: [...list.steps, s] }, 'add'); setSelected(s.id); setUpTo(null)
    if (phone) setSheet('half')
  }
  const setParams = (id: string, params: Record<string, unknown>): void => onListChange({ ...list, steps: list.steps.map(s => (s.id === id ? { ...s, params } : s)) }, 'edit')
  const fix = (id: string, set: Record<string, string | number>): void => { const s = list.steps.find(x => x.id === id); if (s) onListChange({ ...list, steps: list.steps.map(x => (x.id === id ? { ...x, params: { ...s.params, ...set } } : x)) }, 'fix') }

  const personalisableCount = list.steps.filter(stepPersonalisable).length
  const switchPersonalised = (on: boolean): void => {
    if (on) { props.onPersonalised?.(true); return }
    if (personalisableCount === 0) { props.onPersonalised?.(false); return }
    setDialog('switchOff')
  }
  const pendingOff = useRef<((changed: boolean) => void) | null>(null)
  const settleOff = (changed: boolean): void => { const f = pendingOff.current; pendingOff.current = null; f?.(changed) }
  const cancelOff = (): void => { setDialog(null); settleOff(false) }
  const confirmOff = (): void => {
    onListChange({ ...list, steps: list.steps.map(s => ({ ...s, personalisable: false, personalisable_params: [], personalisable_limits: undefined } as Step)) }, 'personalise')
    props.onPersonalised?.(false); setDialog(null); settleOff(true)
  }

  // ---- what the host can read and ask (embedded use)
  const crashedNow = Object.values(registry.disabledPlugins()).some(d => d.crashed)
  const stateNow: EditorState = {
    personalised: props.personalised,
    personalisableSteps: personalisableCount,
    hasError: !!result?.results.some(r => r.error) || crashedNow,
    closedSolid: closed,
    size: report ? { w: Math.round(report.size[0] * 10) / 10, h: Math.round(report.size[1] * 10) / 10, d: Math.round(report.size[2] * 10) / 10 } : null,
    running,
  }
  const stateRef = useRef(stateNow); stateRef.current = stateNow
  const personalisedRef = useRef(props.personalised); personalisedRef.current = props.personalised
  const onStateCb = props.onState
  const stateKey = JSON.stringify(stateNow)
  useEffect(() => { onStateCb?.(stateRef.current) }, [stateKey, onStateCb])
  useImperativeHandle(ref, () => ({
    getState: () => stateRef.current,
    requestPersonalised: (on: boolean) => {
      if (on === personalisedRef.current) return Promise.resolve(false)
      if (on) { props.onPersonalised?.(true); return Promise.resolve(true) }
      if (stateRef.current.personalisableSteps === 0) { props.onPersonalised?.(false); return Promise.resolve(true) }
      settleOff(false)
      return new Promise<boolean>(resolve => { pendingOff.current = resolve; setDialog('switchOff') })
    },
  }), [props.onPersonalised])

  useLeaveGuard(!!props.dirty)
  const leave = (): void => { if (props.dirty) setDialog('leave'); else props.onLeave?.() }

  const partsAt = (id: string): { segments: string[]; groups: string[] } => {
    const i = list.steps.findIndex(s => s.id === id)
    const m = (i > 0 ? result?.results[i - 1]?.mesh : props.source) ?? props.source ?? undefined
    return { segments: m ? segmentTable(m).map(s => s.name) : [], groups: m ? groupNames(m) : [] }
  }

  // click on the model to place the selected text there
  const resultRef = useRef(result); resultRef.current = result
  const listRef = useRef(list); listRef.current = list
  useEffect(() => {
    if (!viewerNow || !placing) return
    return viewerNow.onPick(hit => {
      if (!hit) return
      const l = listRef.current
      const st = l.steps.find(x => x.id === placing.stepId)
      if (!st) return
      const old = (valueAtPath(st.params, placing.param) as { direction?: number; up_ref?: string; offset?: number[]; align?: unknown; limits?: unknown } | null) ?? {}
      const index = l.steps.findIndex(x => x.id === st.id)
      const value = { frame: cumulativeMatrix(resultRef.current?.results ?? [], index), anchor: { point: hit.point, normal: hit.normal, tri: hit.triangle }, up_ref: old.up_ref ?? 'z', direction: old.direction ?? 0, offset: old.offset ?? [0, 0], ...(old.align ? { align: old.align } : {}), ...(old.limits ? { limits: old.limits } : {}) } as PlacementValue
      setPlacing(null)
      onListChange({ ...l, steps: l.steps.map(x => (x.id === st.id ? { ...x, params: withValueAtPath(st.params, placing.param, value) } : x)) }, 'edit')
    })
  }, [viewerNow, placing, onListChange])
  useEffect(() => { if (placing && !list.steps.some(x => x.id === placing.stepId)) setPlacing(null) }, [list, placing])
  // while the user is asked to click on the model, the pointer is a crosshair
  useEffect(() => {
    const el = viewerNow?.renderer.domElement
    if (!el) return
    el.style.cursor = placing ? 'crosshair' : ''
    return () => { el.style.cursor = '' }
  }, [viewerNow, placing])
  // the marker where the selected step's text sits: a round grip on the model that can be dragged to move the text
  const placementName = step ? opOf(step)?.params.find(p => p.type === 'placement')?.name : undefined
  const placementNow = step && placementName ? (step.params[placementName] as PlacementValue | null | undefined) : undefined
  const home = useRef<{ id: string; value: PlacementValue } | null>(null)
  if (!placementNow?.anchor || !step) home.current = null
  else if (home.current?.id !== step.id) home.current = { id: step.id, value: { ...placementNow, limits: undefined } as PlacementValue }
  const dragSpec = placementNow?.anchor && step && placementName && home.current && !placing
    ? { length: Math.max(8, Number(step.params['size'] ?? 8) * 2.5), current: placementNow, designer: home.current.value, move: (next: PlacementValue) => setParams(step.id, { ...step.params, [placementName]: { ...next, limits: placementNow.limits } }) }
    : undefined

  // ---- the pieces
  // the column switcher: Steps, Stored, Colours (then the host's own tabs on the phone), with a count and a "!" (design round 7)
  const plural = (key: string, n: number, one: string, other: string): string => tx(t, key, n === 1 ? one : other, { count: n })
  const colourSlots = props.colours?.map?.slots.length ?? 0
  const colourMax = props.colours ? (props.colours.maxColours === null ? Infinity : props.colours.maxColours ?? DEFAULT_MAX_COLOURS) : Infinity
  const stepsBad = !!result?.results.some(r => r.status === 'error')
  const switcherTabs = (active: string, withHost: boolean): ColumnTab[] => {
    const stepsLabel = tx(t, 'editor.tab.steps', t('editor.steps')), storedLabel = tx(t, 'store.tab', 'Stored'), coloursLabel = tx(t, 'colours.tab', tx(t, 'colours.title', 'Colours'))
    const stepsAlert = stepsBad && active !== 'steps' ? tx(t, 'editor.stepsAlert', 'A step has a problem.') : null
    const storedAlert = stored.missing > 0 ? plural('store.alert', stored.missing, 'A step needs an item that is missing.', 'Steps need {{count}} items that are missing.') : null
    const coloursAlert = colourSlots > colourMax ? tx(t, 'colours.alert.tooMany', 'Uses {{count}} colours; this printer takes {{max}}.', { count: colourSlots, max: colourMax }) : null
    const out: ColumnTab[] = [{ id: 'steps', label: stepsLabel, icon: 'listOrdered', about: tx(t, 'editor.stepsAbout', 'Steps run from top to bottom. Each step works on the result of the step above it.'), alert: stepsAlert,
      name: stepsAlert ? `${stepsLabel}, ${tx(t, 'editor.tab.stepsProblem', '1 step with a problem')}` : stepsLabel }]
    if (storeOn) out.push({ id: 'stored', label: storedLabel, icon: 'archive', count: stored.count, about: tx(t, 'store.about', 'Drawings and models this project keeps. Steps use them by name.'), alert: storedAlert,
      name: `${stored.count === 0 ? tx(t, 'store.tabLabel_zero', 'Stored, nothing yet') : plural('store.tabLabel', stored.count, 'Stored, 1 item', 'Stored, {{count}} items')}${stored.missing > 0 ? `, ${plural('store.tabMissing', stored.missing, '1 missing', '{{count}} missing')}` : ''}` })
    if (coloursOn) out.push({ id: 'colours', label: coloursLabel, icon: 'palette', count: colourSlots >= 2 ? colourSlots : null, about: tx(t, 'colours.about', 'Which part of the model prints in which filament.'), alert: coloursAlert,
      name: colourSlots >= 2 ? plural('colours.tabLabel', colourSlots, 'Colours, one colour', 'Colours, {{count}} colours') : coloursLabel })
    if (withHost) for (const x of tabs) out.push({ id: x.id, label: x.label, icon: x.icon ?? 'info', host: true })
    return out
  }
  const switcherOn = storeOn || coloursOn
  const addMenu = (block: boolean): ReactElement => <AddStepMenu block={block} t={t} registry={registry} onAdd={addStep} kind={lastKind} storeEntries={storeView ? storeView.rows.filter(r => !r.missing).length : 0} {...(props.plugins ? { onManage: () => setDialog('plugins') } : {})} {...(props.recipes ? { onApplyRecipe: () => setDialog('applyRecipe'), onSaveRecipe: () => setDialog('saveRecipe'), canSaveRecipe: list.steps.length > 0 } : {})} />
  const pipeline = (
    <StoreProvider value={storeView}>
      {switcherOn ? <ColumnTabs t={t} tabs={switcherTabs(leftTab, false)} value={leftTab} onChange={id => setLeftTab(id as 'steps' | 'stored' | 'colours')} label={tx(t, 'editor.panels', 'Editor panels')} idPrefix="am-ltab-" /> : null}
      {coloursOn && leftTab === 'colours' && props.colours ? <ColoursPanel t={t} host={props.colours} mesh={shown} showMapped={showMapped} onShowMapped={setShowMapped} /> : storeOn && leftTab === 'stored' && storeView && props.store ? <StoredPanel t={t} host={props.store} rows={storeView.rows} list={list} onGoToStep={id => { select(id); setLeftTab('steps') }} /> : (
      <>
      <div className="am-panelhead">{addMenu(true)}</div>
      <StepListView t={t} registry={registry} list={list} result={result} selected={selected} onSelect={select} onMove={moveTo} hints={hints} partIssues={partIssues}
        file={props.file ?? null} showBadges={ticks} upTo={upTo} onUpTo={setUpTo} runningId={working ? (progress?.stepId ?? null) : null} onFix={fix}>
        <PartsList t={t} mesh={shown} viewer={viewerNow} />
      </StepListView>
      </>
      )}
      <div className="am-sr" role="status" aria-live="polite">{note}</div>
    </StoreProvider>
  )
  const op = step ? opOf(step) : undefined
  // one column: the settings of the selected step belong to the Steps tab, the Stored and Colours tabs show only their own panel (the host's `aside` stays)
  const stepTab = !embedded || !(storeOn || coloursOn) || leftTab === 'steps'
  const settingsPane = (
    <StoreProvider value={storeView}>
    <section className="am-settingspane" {...(phone ? {} : { "aria-label": step ? stepName(t, registry, step) : t("editor.steps") })}>
      {!stepTab ? null : step && op ? (
        <>
          <div className="am-sethead">
            <EditableTitle t={t} prefix={tx(t, 'step.number', 'Step {{n}}', { n: list.steps.findIndex(x => x.id === step.id) + 1 })} name={step.name ?? ''} defaultName={stepName(t, registry, { ...step, name: '' })}
              onRename={v => onListChange({ ...list, steps: list.steps.map(x => { if (x.id !== step.id) return x; const { name: _n, ...rest } = x; return (v ? { ...rest, name: v } : rest) as Step }) }, 'edit')} />
            <StepMenu t={t} {...(props.onApply ? { onApply: props.onApply, applyDisabled: props.canApply === false } : {})} index={list.steps.findIndex(x => x.id === step.id)} count={list.steps.length} enabled={step.enabled} onMove={to => moveTo(step.id, to)}
              onToggle={() => changeList({ ...list, steps: list.steps.map(x => (x.id === step.id ? { ...x, enabled: !x.enabled } : x)) }, 'enabled')}
              onDelete={() => changeList({ ...list, steps: list.steps.filter(x => x.id !== step.id) }, 'delete')} />
          </div>
          <StepNotes t={t} registry={registry} list={list} result={result} step={step} shownWarning={warnAt && warnAt.stepId === step.id ? warnAt.index : null} onShowWarning={k => { if (k === null) setWarnAt(null); else { setWarnAt({ stepId: step.id, index: k }); if (visible.steps[visible.steps.length - 1]?.id !== step.id) setUpTo(step.id) } }} hints={hints} partIssues={partIssues} onMove={moveTo} onFix={fix} {...(props.plugins ? { onManage: () => setDialog('plugins') } : {})} {...(storeOn ? { onStore: storeAction } : {})} {...(props.plugins?.catalog ? { replacedBy: (id: string) => { const it = props.plugins?.catalog?.items.find(x => x.replaces?.includes(id)); return it ? { name: it.name } : null } } : {})} />
          <PrintReportCard t={t} result={result} list={list} step={step} viewer={viewerNow} />
          {formSupported(op) ? (
            <PicturesContext.Provider value={props.pictures ?? null}><StepForm key={step.id} t={t} step={step} op={op} list={list} ticks={ticks} {...(props.fonts ? { fonts: props.fonts } : {})}
              onParams={p => setParams(step.id, p)} onList={l => changeList(l, 'personalise')} segments={() => partsAt(step.id).segments} groups={() => partsAt(step.id).groups}
              onPlacementRequest={param => { setPlacing({ stepId: step.id, param }); if (phone) setSheet('peek') }}
              {...(props.onAsset ? { onAsset: (param: string, def: ParamDef) => props.onAsset?.(step.id, param, def) } : {})} /></PicturesContext.Provider>
          ) : (
            <>
              <p className="am-problem am-warning" role="note">{tx(t, 'step.unsupported', 'This step has a setting this app cannot show yet: {{types}}.', { types: [...new Set(op.params.filter(q => !formSupported({ ...op, params: [q] })).map(q => q.type))].join(', ') })}</p>
              <PlacementBox t={t} step={step} op={op} onParams={p => setParams(step.id, p)} />
              {ticks ? <PersonaliseBox t={t} step={step} op={op} list={list} onList={l => changeList(l, 'personalise')} /> : null}
            </>
          )}
        </>
      ) : step ? (
        // a step of a plugin this browser does not have: there is no form, but the problem and the way out are shown
        <div className="am-notes">
          <h3>{stepName(t, registry, step)}</h3>
          {(() => { const er = result?.results[list.steps.findIndex(x => x.id === step.id)]?.error; return er ? <ProblemLine t={t} code={er.code} params={er.params as Record<string, unknown> | undefined} onFix={undefined} {...(props.plugins ? { onManage: () => setDialog('plugins') } : {})} /> : null })()}
        </div>
      ) : <p className="am-help">{list.steps.length === 0 ? t('editor.addStep') : t('overlay.steps')}</p>}
      {props.aside ? <div className="am-aside">{props.aside}</div> : null}
    </section>
    </StoreProvider>
  )
  const viewerRef = useRef<Viewer | null>(null)
  const [angle, setAngle] = useState<'iso' | 'front' | 'top' | 'side'>('iso')
  const [ruler, setRuler] = useState(true)   // a ruler in mm on the build plate, along X and Y; on by default
  useEffect(() => { viewerNow?.setGuides({ ruler }) }, [viewerNow, ruler])
  const onViewer = (v: Viewer | null): void => { viewerRef.current = v; setViewerNow(v); props.onViewer?.(v) }
  const look = (a: 'iso' | 'front' | 'top' | 'side'): void => { setAngle(a); viewerRef.current?.setView(a) }
  const sizeText = report ? t('editor.size', { x: Math.round(report.size[0] * 10) / 10, y: Math.round(report.size[1] * 10) / 10, z: Math.round(report.size[2] * 10) / 10 }) : ''
  const statusEl = (
    <div className={props.statusLine === 'chip' ? 'am-status am-status-chip' : props.statusLine === 'none' ? 'am-sr' : 'am-status'} role="status">
          {report ? <span className={closed ? 'am-ok' : 'am-bad'}>{closed ? '✓ ' : ''}{closed ? t('editor.closed') : t('editor.notClosed')}</span> : null}
          {report ? <span>{sizeText}</span> : null}
          {shown ? <span>{t('editor.triangles', { count: (shown.indices.length / 3).toLocaleString('en-US').replace(/,/g, '\u202f') })}</span> : null}
          {blocking && !working ? <span className="am-bad">{t('editor.blocked')}</span> : null}
        </div>
  )
  const view = (
    <main className="am-editor-view" aria-label={t('view.label')} data-working={working ? 'true' : undefined}>
      {props.chrome === 'none' && props.title ? <h1 className="am-sr">{props.title}</h1> : null}
      <ModelView three={three} mesh={viewMesh} busy={running} t={t} drag={dragSpec} onViewer={onViewer} />
      {placing ? <div className="am-band" role="note">{t('editor.placeHint')} <button type="button" onClick={() => setPlacing(null)}>{tx(t, 'editor.placeCancel', 'Cancel')}</button></div> : upTo ? <div className="am-band" role="note">{t('view.upToNote', { n: list.steps.findIndex(s => s.id === upTo) + 1, total: list.steps.length })}</div> : null}
      <div className="am-viewfoot">
        <div className="am-seg" role="group" aria-label={t('view.label')}>
          <button type="button" aria-pressed={!upTo} onClick={() => setUpTo(null)}>{t('view.final')}</button>
          <button type="button" aria-pressed={!!upTo} disabled={!step && !upTo} onClick={() => setUpTo(upTo ? null : (step?.id ?? null))}>{t('view.upTo')}</button>
        </div>
        {phone ? null : (
          <div className="am-seg" role="group" aria-label={t('view.3d')}>
            {(['iso', 'front', 'top', 'side'] as const).map(a => <button key={a} type="button" aria-pressed={angle === a} onClick={() => look(a)}>{a === 'iso' ? t('view.3d') : t(`view.${a}`)}</button>)}
            <button type="button" aria-label={t('view.zoomOut')} onClick={() => viewerRef.current?.zoom(1.25)}><Icon name="zoomOut" size={18} /></button>
            <button type="button" aria-label={t('view.zoomIn')} onClick={() => viewerRef.current?.zoom(0.8)}><Icon name="zoomIn" size={18} /></button>
          </div>
        )}
        <div className="am-seg" role="group" aria-label={tx(t, 'view.rulerGroup', 'Measure')}>
          <button type="button" aria-pressed={ruler} title={tx(t, 'view.rulerHint', 'A ruler in mm on the plate, along X and Y, from the front left corner of the model')} onClick={() => setRuler(r => !r)}><Icon name="ruler" size={18} />{tx(t, 'view.ruler', 'Ruler')}</button>
        </div>
        {props.statusLine === 'chip' ? null : statusEl}
        {working ? <WorkingRow t={t} progress={progress} index={progress ? list.steps.findIndex(x => x.id === progress.stepId) : -1} total={list.steps.length} {...(progress ? { op: list.steps.find(x => x.id === progress.stepId)?.op } : {})} onStop={() => abortRef.current?.abort()} /> : null}
        <div className="am-sr" role="status" aria-live="polite">{announce}</div>
      </div>
      {props.statusLine === 'chip' ? statusEl : null}
      {working ? <CenterLoader /> : null}
    </main>
  )

  return (
    <div className="am-editor" data-phone={phone} data-chrome={props.chrome === 'none' ? 'none' : undefined} data-layout={embedded ? 'embedded' : undefined}>
      {props.chrome === 'none' ? null : (
      <header className="am-editor-bar">
        {props.title ? <h1 className="am-sr">{props.title}</h1> : null}
        {props.brand ? (props.onLeave
          ? <button type="button" className="am-brand am-brand-btn" aria-label={tx(t, 'app.home', 'Back to the start page')} title={tx(t, 'app.home', 'Back to the start page')} onClick={leave}>{props.brand}</button>
          : <div className="am-brand">{props.brand}</div>) : null}
        <span className="am-spacer" />
        {props.undo ? <>
          <button type="button" className="am-ib" aria-label={t('undo')} title={t('undo')} disabled={!props.undo.canUndo} onClick={props.undo.onUndo}><Icon name="undo" /></button>
          <button type="button" className="am-ib" aria-label={t('redo')} title={t('redo')} disabled={!props.undo.canRedo} onClick={props.undo.onRedo}><Icon name="redo" /></button>
        </> : null}
        {switchVisible ? <label className="am-switch" title={t('personalise.switch')}><input type="checkbox" role="switch" aria-label={t('personalise.switch')} checked={props.personalised} onChange={e => switchPersonalised(e.target.checked)} /><Icon name="user" size={16} /><span className="am-swl">{t('personalise.switch')}</span></label> : null}
        {props.actions}
        {props.onLeave ? <button type="button" className="am-ib" aria-label={t('editor.openOther')} title={t('editor.openOther')} onClick={leave}><Icon name="folder" /></button> : null}
        {props.settings ? <button type="button" className="am-ib" aria-label={t('settings.open')} title={t('settings.open')} onClick={() => setDialog('settings')}><Icon name="settings" /></button> : null}
        {props.barEnd}
      </header>
      )}
      <CrashBanner t={t} registry={registry} {...(props.plugins ? { onManage: () => setDialog('plugins') } : {})} />
      {phone ? (
        <div className="am-editor-body am-phonebody" data-sheet={sheet} {...(tabs.length > 0 || switcherOn ? { 'data-tabbed': '1' } : {})}>
          {view}
          <BottomSheet t={t} height={sheet} onHeight={setSheet} title={step ? stepName(t, registry, step) : t('editor.steps')} {...(props.sheetFooter ? { footer: props.sheetFooter } : {})} {...(tabs.length > 0 || switcherOn ? { tabs: <ColumnTabs t={t} tabs={switcherTabs(tab, true)} value={tab} onChange={id => { pickTab(id); if (sheet === 'peek') setSheet('half') }} label={tx(t, 'editor.panels', 'Editor panels')} idPrefix="am-tab-" /> } : {})}>
            {props.header ? <div className="am-sheet-header">{props.header}</div> : null}
            {tab === 'steps' ? (
              <div role={tabs.length > 0 || storeOn || coloursOn ? 'tabpanel' : undefined} aria-labelledby={tabs.length > 0 || storeOn || coloursOn ? 'am-tab-steps' : undefined}>
            {addMenu(true)}
            <div className="am-chips" role="group" aria-label={t('editor.steps')}>
              {list.steps.map((s, i) => {
                const st = !s.enabled ? 'off' : result?.results[i]?.status === 'error' ? 'error' : result?.results[i]?.status === 'ok' ? 'ok' : 'stale'
                return (
                  <button key={s.id} type="button" className="am-stepname am-chip-step" aria-current={s.id === selected} onClick={() => select(s.id)}>
                    <span className="am-chipn">{i + 1}</span>{stepName(t, registry, s)}<span className={`am-dot am-st-${st}`} aria-hidden="true" />
                  </button>
                )
              })}
            </div>
            {settingsPane}
            <PartsList t={t} mesh={shown} viewer={viewerNow} />
              </div>
            ) : (
              <div role="tabpanel" aria-labelledby={`am-tab-${tab}`}>{tab === 'colours' && props.colours ? <ColoursPanel t={t} host={props.colours} mesh={shown} showMapped={showMapped} onShowMapped={setShowMapped} /> : tab === 'stored' && storeView && props.store ? <StoredPanel t={t} host={props.store} rows={storeView.rows} list={list} onGoToStep={id => { select(id); pickTab('steps') }} /> : tabs.find(x => x.id === tab)?.content}</div>
            )}
          </BottomSheet>
        </div>
      ) : (
        embedded ? (
          <div className="am-editor-body am-embedded">
            <aside className="am-left am-embedded-col" aria-label={t('editor.steps')}>{props.header ? <div className="am-embedded-header">{props.header}</div> : null}{pipeline}{settingsPane}</aside>
            {view}
          </div>
        ) : (
          <div className="am-editor-body">
            <aside className="am-left" aria-label={t('editor.steps')}>{pipeline}</aside>
            {view}
            <aside className="am-right">{settingsPane}</aside>
          </div>
        )
      )}

      {dialog === 'saveRecipe' && props.recipes ? <SaveRecipeDialog t={t} list={list} {...(props.file?.name ? { defaultName: props.file.name.replace(/\.[^.]+$/, '') } : {})} host={props.recipes} onClose={() => setDialog(null)} /> : null}
      {dialog === 'applyRecipe' && props.recipes ? <ApplyRecipeDialog t={t} registry={registry} target={list} host={props.recipes} onClose={() => setDialog(null)} onApply={(next, added) => { setDialog(null); onRecipeApplied(next, added) }} /> : null}
      {dialog === 'plugins' && props.plugins ? (props.settings?.catalogues ? <SettingsShell t={t} initial="plugins" settings={props.settings} plugins={props.plugins} catalogues={props.settings.catalogues} {...(props.settings.catalogueActions ? { catalogueActions: props.settings.catalogueActions } : {})} onClose={() => setDialog(null)} /> : <PluginManager t={t} {...props.plugins} onClose={() => setDialog(null)} />) : null}
      {dialog === 'settings' && props.settings && props.plugins && props.settings.catalogues ? <SettingsShell t={t} initial="general" settings={props.settings} plugins={props.plugins} catalogues={props.settings.catalogues} {...(props.settings.catalogueActions ? { catalogueActions: props.settings.catalogueActions } : {})} onClose={() => setDialog(null)} /> : null}
      {dialog === 'settings' && props.settings && !(props.plugins && props.settings.catalogues) ? <SettingsDialog t={t} showPersonalised={props.settings.showPersonalised} onShowPersonalised={props.settings.onShowPersonalised} {...(props.settings.maxColours ? { maxColours: props.settings.maxColours } : {})} {...(props.settings.catalog ? { catalog: props.settings.catalog } : {})} {...(props.settings.about ? { about: props.settings.about } : {})} {...(props.plugins ? { onPlugins: () => setDialog('plugins') } : {})} onClose={() => setDialog(null)} /> : null}
      {dialog === 'leave' ? <LeaveDialog t={t} savedAt={props.savedAt ?? null} {...(props.onSave ? { onSave: async () => { await props.onSave?.(); setDialog(null); props.onLeave?.() } } : {})} onDiscard={() => { setDialog(null); props.onLeave?.() }} onStay={() => setDialog(null)} /> : null}
      {dialog === 'switchOff' ? (
        <Dialog title={t('personalise.offTitle')} onClose={cancelOff} t={t}>
          <p>{t('personalise.offBody', { count: personalisableCount })}</p>
          <div className="am-actions"><button type="button" data-autofocus onClick={cancelOff}>{t('personalise.offCancel')}</button><button type="button" className="am-primary" onClick={confirmOff}>{t('personalise.offConfirm')}</button></div>
        </Dialog>
      ) : null}
    </div>
  )
})
