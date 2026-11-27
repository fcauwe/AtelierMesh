// The personalise overlay: what a customer sees after pressing the pen button on the Atelier's preview.
// Full screen: Reset and Done on top, the steps the designer opened on the left, the live model in the middle, the opened fields on the right.
// The host owns everything outside it: running the workflow (`run`), the language (`t`), three.js, the fonts, the price and the quote.
import { ChangeDrawing, StoreProvider, StoredPicker, makeStoreView, useStoreView } from './Store'
import type { StoreHost } from './Store'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { applyColourMap, clampParam, evalExpr, clampPlacementToLimits, mergeCustomerList, canPersonalise, fitTextToLimits, isPlacement, readingFrame, setParams, stepPersonalisable } from '@ateliermesh/core'
import type { ColourMap, Mesh, Operation, ParamDef, PlacementValue, Registry, Step, StepList, WorkflowResult } from '@ateliermesh/core'
import { describeProblem, loadViewer } from '@ateliermesh/ui'
import type { Handle, ThreeModule, Viewer, ViewerOptions } from '@ateliermesh/ui'
import { CenterLoader, WorkingRow, useAnnouncement, useProgress, useWorking } from './Working'
import { Icon, NamedIcon, ShapeIcon, iconKey } from './icons'
import { problemText } from './common'
import { PictureGrid, PicturesContext, usePictures } from './PictureGrid'
import type { PictureLibrary } from './PictureGrid'
import { slotShownColour } from './Colours'

/** `onProgress` is the engine's own: pass it on to `runWorkflow` so the indicator can name the stage and move its bar. */
export type RunWorkflow = (list: StepList, o: { signal: AbortSignal; onProgress?: (stepId: string, stage: string, fraction: number) => void }) => Promise<WorkflowResult>
export interface FontChoice { id: string; family: string }

export interface PersonaliseOverlayProps {
  /** The designer's version. Reset returns to it; the customer's changes are held against it. */
  list: StepList
  /**
   * The customer's list from an earlier visit. The overlay starts from it; Reset still returns to `list`, and the "changed" marks compare with `list`.
   * Only the values of the parameters that `list` opens are taken (`mergeCustomerList`): a step the designer has removed, a field the designer has closed,
   * or a step that claims to be open on its own never reaches the customer, and a text is cut to the designer's limits.
   */
  initialList?: StepList
  registry: Registry
  run: RunWorkflow
  /** Looks a key up in the host's language files (design's keys: `overlay.*`, `text.*`, `mesh.*`, `fix.*`, ...). */
  t: (key: string, values?: Record<string, string | number>) => string
  three: ThreeModule
  /** The fonts a customer can pick; `family` is a CSS font family the host has loaded, used for the previews. */
  fonts?: FontChoice[]
  /** The pictures a customer can pick for a picture setting (`widget: "gallery"`): a grid with thumbnails instead of the host's file picker. */
  pictures?: PictureLibrary
  title?: string
  subtitle?: string
  /** The designer's check: shows the band "Preview as customer" and a Back to the editor button instead of the close button. */
  previewAsCustomer?: boolean
  /** The customer pressed Done and the last run was good. */
  onDone: (list: StepList) => void
  onClose: () => void
  /** The project's store (`useStoreHost`): a drawing setting the customer may change gets "Change drawing" (their own SVG, within `customerLimits`). Without it the host's own picker is used. */
  store?: StoreHost | null
  /** For an asset parameter that asks for no grid (no `widget`), the host opens its own picker and the step is changed by the host. */
  onAssetRequest?: (stepId: string, param: string) => void
  /** Gives the host the viewer once it exists (null when it is gone): for a snapshot, or its own overlays. */
  onViewer?: (viewer: Viewer | null) => void
  /** Options for the overlay's own viewer (`environment`, `finish`, `shadow`, `toneMapping`, `color`). They are read when the viewer is made; change the finish later through `onViewer` and `setFinish`. Default: the plain look. */
  viewerOptions?: ViewerOptions
  /**
   * The design's colour slots: the model on screen is painted as the slots say, each part in the colour of its slot (what the host's own preview shows). `colours` gives the colour of
   * each slot by slot id; a slot without one gets a preview colour. Without `map` the model is shown as the steps made it (one colour when the parts have none of their own).
   */
  colours?: { map: ColourMap; colours?: Record<string, { color: string }> }
  /** Delay before a change is run (ms). Default 150. */
  debounceMs?: number
}

const opOf = (registry: Registry, s: Step): Operation | undefined => registry.operation(s.plugin.id, s.op)?.op
const stepTitle = (t: PersonaliseOverlayProps['t'], s: Step): string => s.name?.trim() || t(`step.op.${s.op === 'emboss' ? 'text' : s.op === 'emboss_svg' ? 'svg' : s.op}`)
const wordingOf = (s: Step): string => (typeof s.params['text'] === 'string' ? s.params['text'] : '')

export function PersonaliseOverlay(props: PersonaliseOverlayProps): ReactElement {
  const { list: designerList, registry, run, t, three, fonts = [], onDone, onClose, onViewer, viewerOptions, debounceMs = 150 } = props
  const [list, setList] = useState<StepList>(() => mergeCustomerList(designerList, props.initialList, { registry }))
  const [result, setResult] = useState<WorkflowResult | null>(null)
  const [good, setGood] = useState<WorkflowResult | null>(null)      // the last result without errors: it stays on screen
  const [running, setRunning] = useState(false)
  const [ranFor, setRanFor] = useState<StepList | null>(null)         // the list `result` was computed from
  const [resetNote, setResetNote] = useState(false)
  const open = useMemo(() => list.steps.filter(stepPersonalisable), [list])
  const [selected, setSelected] = useState<string | null>(open[0]?.id ?? null)
  const step = list.steps.find(s => s.id === selected) ?? open[0]
  const runId = useRef(0)
  const abort = useRef<AbortController | null>(null)
  const { progress, report: onProgress, reset: clearProgress } = useProgress()
  const working = useWorking(running)
  const announce = useAnnouncement(working, t)

  // run the workflow after each change (debounced), keeping the last good result on screen
  useEffect(() => {
    const mine = ++runId.current
    abort.current?.abort()
    const ac = new AbortController(); abort.current = ac
    setRunning(true); clearProgress()
    const timer = setTimeout(() => {
      run(list, { signal: ac.signal, onProgress }).then(res => {
        if (mine !== runId.current) return
        setResult(res); setRanFor(list); setRunning(false)
        if (res.ok) setGood(res)
      }, () => { if (mine === runId.current) setRunning(false) })
    }, debounceMs)
    return () => { clearTimeout(timer); ac.abort() }
  }, [list, run, debounceMs])

  const problems = useMemo(() => {
    const out: Array<{ stepId: string; code: string; params: Record<string, unknown> | undefined; warning: boolean }> = []
    result?.results.forEach(r => {
      if (r.error) out.push({ stepId: r.stepId, code: r.error.code, params: r.error.params as Record<string, unknown> | undefined, warning: false })
      for (const w of r.warnings ?? []) out.push({ stepId: r.stepId, code: w.code, params: w.params as Record<string, unknown> | undefined, warning: true })
    })
    return out
  }, [result])
  const blocking = problems.some(p => !p.warning && describeProblem(p.code, p.params, p.warning ? { channel: 'warning' } : {}).blocks)

  // Done is available only when the result on screen is the result of the list the customer has now, and it is good. While the model is recalculating it is greyed out.
  // the label while the model recalculates; a host that has no `overlay.calculating` text yet gets `overlay.finishing`, then the plain Done
  const calculating = ((): string => { for (const k of ['overlay.calculating', 'overlay.finishing']) { const v = t(k); if (v !== k) return v } return t('overlay.done') })()
  const ready = !running && result !== null && ranFor === list && result.ok && !blocking

  const change = useCallback((id: string, params: Record<string, unknown>) => { setResetNote(false); setList(l => setParams(l, id, params)) }, [])
  const reset = (): void => { setList(designerList); setResetNote(true) }
  const base = (id: string): Record<string, unknown> => designerList.steps.find(s => s.id === id)?.params ?? {}

  const shown = good?.mesh ?? result?.mesh
  const slotMap = props.colours?.map, slotColours = props.colours?.colours
  const viewMesh = useMemo(() => {
    if (!shown || !slotMap || slotMap.slots.length === 0) return shown
    try { return applyColourMap(shown, slotMap, { mode: 'preview', colours: Object.fromEntries(slotMap.slots.map((x, i) => [x.id, { color: slotShownColour(x, i, slotColours) }])) }) } catch { return shown }   // a map with a problem: the model as it is
  }, [shown, slotMap, slotColours])

  // dragging the text on the model, when the position is personalisable: the text stays inside the dashed circle of "move at most"
  const drag = useMemo(() => {
    if (!step) return undefined
    const op = opOf(registry, step)
    const pname = op?.params.find(p => p.type === 'placement')?.name
    const cur = pname ? step.params[pname] : undefined
    const designer = pname ? base(step.id)[pname] : undefined
    if (!pname || !isPlacement(cur) || !isPlacement(designer) || !canPersonalise(step, pname, 'position')) return undefined
    return { current: cur, designer, move: (next: PlacementValue) => change(step.id, { ...step.params, [pname]: clampPlacementToLimits(designer, next) }) }
  }, [step, registry, designerList, change])
  return (
    <div className="am-overlay" role="dialog" aria-modal="true" aria-label={props.title ?? t('overlay.title')}>
      <header className="am-overlay-bar">
        <button type="button" className="am-icon" aria-label={t(props.previewAsCustomer ? 'overlay.backToEditor' : 'overlay.close')} onClick={onClose}>×</button>
        <div><strong>{props.title ?? t('overlay.title')}</strong>{props.subtitle ? <div className="am-sub">{props.subtitle}</div> : null}</div>
        <span className="am-spacer" />
        <button type="button" onClick={reset}>{t('overlay.reset')}</button>
        <button type="button" className="am-primary" onClick={() => { if (ready) onDone(list) }} disabled={!ready} aria-busy={running || undefined} title={blocking ? t('editor.blocked') : undefined}>
          {running ? calculating : t('overlay.done')}
        </button>
      </header>
      {props.previewAsCustomer ? <div className="am-band" role="note">{t('overlay.previewBanner')}</div> : null}
      {resetNote ? <div className="am-quiet" role="status">{t('overlay.resetDone')}</div> : null}
      {open.length === 0 ? (
        <div className="am-empty" role="status"><p>{t('overlay.nothingOpen')}</p><button type="button" onClick={onClose}>{t('overlay.backToEditor')}</button></div>
      ) : (
        <div className={open.length === 1 ? 'am-overlay-body am-one' : 'am-overlay-body'}>
          <nav className="am-steps" aria-label={t('overlay.steps')}>
            <h2>{t('overlay.steps')}</h2>
            <ul>
              {open.map(s => (
                <li key={s.id}>
                  <button type="button" aria-current={s.id === step?.id} onClick={() => setSelected(s.id)}>
                    <span>{stepTitle(t, s)} · {wordingOf(s)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <ModelView three={three} mesh={viewMesh ?? null} busy={running} t={t} drag={drag} onViewer={onViewer} {...(viewerOptions ? { viewerOptions } : {})}
            working={working ? <><CenterLoader /><WorkingRow t={t} progress={progress} index={progress ? list.steps.findIndex(x => x.id === progress.stepId) : -1} total={list.steps.length} {...(progress ? { op: list.steps.find(x => x.id === progress.stepId)?.op } : {})} onStop={() => abort.current?.abort()} /></> : null} />
          <section className="am-fields" aria-label={step ? stepTitle(t, step) : undefined}>
            {step ? <StoreProvider value={props.store ? makeStoreView(props.store, list, registry) : null}><PicturesContext.Provider value={props.pictures ?? null}><Fields key={step.id} step={step} op={opOf(registry, step)} base={base(step.id)} fonts={fonts} t={t} onChange={p => change(step.id, p)} onAsset={name => props.onAssetRequest?.(step.id, name)} /></PicturesContext.Provider></StoreProvider> : null}
            {problems.filter(p => !step || p.stepId === step.id).map((p, i) => (
              <Problem key={`${p.code}${i}`} warning={p.warning} stepId={p.stepId} code={p.code} params={p.params} t={t} step={list.steps.find(s => s.id === p.stepId)} onFix={set => { const s = list.steps.find(x => x.id === p.stepId); if (s) change(s.id, { ...s.params, ...set }) }} />
            ))}
          </section>
        </div>
      )}
      <div className="am-sr" role="status" aria-live="polite">{announce}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------- the model

export interface DragSpec {
  current: PlacementValue; designer: PlacementValue; move: (next: PlacementValue) => void
  /** Length of the reading-direction arrow in mm (about the width of the text). Default 12. */
  length?: number
}

export function ModelView({ three, mesh, t, drag, onViewer, working, viewerOptions }: { three: ThreeModule; viewerOptions?: ViewerOptions; mesh: Mesh | null; busy: boolean; working?: ReactNode; t: PersonaliseOverlayProps['t']; drag: DragSpec | undefined; onViewer: ((v: Viewer | null) => void) | undefined }): ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const viewer = useRef<Viewer | null>(null)
  const first = useRef(true)
  const [ready, setReady] = useState<Viewer | null>(null)
  const latest = useRef<Mesh | null>(mesh)
  latest.current = mesh
  useEffect(() => {
    if (!host.current) return
    let gone = false
    let made: Viewer | null = null
    // the viewer is its own chunk: it is fetched when the overlay opens
    void loadViewer().then(m => {
      if (gone || !host.current) return
      made = m.createViewer(three, host.current, { background: null, ruler: true, ...viewerOptions }); viewer.current = made
      made.setMesh(latest.current, { fit: true }); if (latest.current) first.current = false
      setReady(made); onViewer?.(made)
    })
    return () => { gone = true; made?.dispose(); viewer.current = null; first.current = true; setReady(null); onViewer?.(null) }
  }, [three])
  const dragRef = useRef(drag); dragRef.current = drag
  const grip = useRef<Handle | null>(null)
  // the grip on the text and the dashed circle around the shop's spot
  const designerAnchor = drag?.designer.anchor, maxDistance = drag?.designer.limits?.max_distance, upRef = drag?.designer.up_ref
  const hasDrag = !!drag
  useEffect(() => {
    const v = ready
    if (!v || !hasDrag || !designerAnchor) return
    const a = designerAnchor
    const lift = (p: [number, number, number], n: [number, number, number], by = 0.3): [number, number, number] => [p[0] + n[0] * by, p[1] + n[1] * by, p[2] + n[2] * by]
    const cur = dragRef.current!.current.anchor
    grip.current = v.addHandle(lift(cur.point, cur.normal, 0.06), {
      onDrag: hit => {
        const d = dragRef.current; if (!d || !hit) return
        d.move({ ...d.current, anchor: { point: hit.point, normal: hit.normal, tri: hit.triangle } })
      },
    }, { color: '#6366f1', opacity: 0.45, normal: cur.normal })
    let removeRing: (() => void) | null = null
    if (maxDistance !== undefined && maxDistance > 0) {
      removeRing = v.addOverlay(({ three: T, toView }) => {
        const fr = readingFrame(a.normal, upRef === 'x' ? [1, 0, 0] : upRef === 'y' ? [0, 1, 0] : [0, 0, 1], 0)
        const pts: unknown[] = []
        for (let i = 0; i <= 96; i++) {
          const th = (i / 96) * Math.PI * 2, c = Math.cos(th) * maxDistance, s = Math.sin(th) * maxDistance
          const p: [number, number, number] = [a.point[0] + fr.ex[0] * c + fr.ey[0] * s + a.normal[0] * 0.3, a.point[1] + fr.ex[1] * c + fr.ey[1] * s + a.normal[1] * 0.3, a.point[2] + fr.ex[2] * c + fr.ey[2] * s + a.normal[2] * 0.3]
          const q = toView(p); pts.push(new T.Vector3(q[0], q[1], q[2]))
        }
        const line = new T.Line(new T.BufferGeometry().setFromPoints(pts as never[]), new T.LineDashedMaterial({ color: 0x6366f1, dashSize: 0.8, gapSize: 0.5 }))
        line.computeLineDistances()
        return line
      })
    }
    return () => { grip.current?.remove(); grip.current = null; removeRing?.() }
  }, [ready, hasDrag, designerAnchor, maxDistance, upRef])
  const anchor = drag?.current.anchor
  useEffect(() => { if (grip.current && anchor) grip.current.setPosition([anchor.point[0] + anchor.normal[0] * 0.06, anchor.point[1] + anchor.normal[1] * 0.06, anchor.point[2] + anchor.normal[2] * 0.06], anchor.normal) }, [anchor])
  // the reading direction: an arrow from the grip along the line the text is read in (it turns with the direction setting)
  const dirDeg = drag?.current.direction ?? 0, upCur = drag?.current.up_ref, arrowLen = drag?.length ?? 12
  useEffect(() => {
    const v = ready
    if (!v || !anchor) return
    return v.addOverlay(({ three: T, toView }) => {
      const fr = readingFrame(anchor.normal, upCur === 'x' ? [1, 0, 0] : upCur === 'y' ? [0, 1, 0] : [0, 0, 1], dirDeg)
      const o = toView([anchor.point[0] + anchor.normal[0] * 0.3, anchor.point[1] + anchor.normal[1] * 0.3, anchor.point[2] + anchor.normal[2] * 0.3])
      const d = toView(fr.ex)
      const arrow = new T.ArrowHelper(new T.Vector3(d[0], d[1], d[2]).normalize(), new T.Vector3(o[0], o[1], o[2]), arrowLen, 0x6366f1, arrowLen * 0.16, arrowLen * 0.08)
      for (const m of [arrow.line.material, arrow.cone.material] as Array<{ transparent: boolean; opacity: number; depthTest: boolean }>) { m.transparent = true; m.opacity = 0.75; m.depthTest = false }
      arrow.renderOrder = 9
      return arrow
    })
  }, [ready, anchor, dirDeg, upCur, arrowLen])
  useEffect(() => { if (viewer.current) { viewer.current.setMesh(mesh, { fit: first.current && !!mesh }); if (mesh) first.current = false } }, [mesh])
  return (
    <div className="am-view" data-working={working ? 'true' : undefined}>
      <div ref={host} className="am-canvas" role="img" aria-label={t('view.label')} />
      {working}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------- the opened fields

function Fields({ step, op, base, fonts, t, onChange, onAsset }: { step: Step; op: Operation | undefined; base: Record<string, unknown>; fonts: FontChoice[]; t: PersonaliseOverlayProps['t']; onChange: (p: Record<string, unknown>) => void; onAsset: (name: string) => void }): ReactElement | null {
  if (!op) return null
  const set = (name: string, value: unknown): void => onChange({ ...step.params, [name]: value })
  const rows: ReactElement[] = []
  for (const p of op.params) {
    if (!p.personalisable || !step.personalisable_params.some(x => x === p.name || x.startsWith(`${p.name}.`))) continue
    // a field the designer marked, but that is not active in this configuration (`visible_if`), is not shown: the same rule as the editor's form
    if (p.visible_if && !evalExpr(p.visible_if, step.params as Record<string, never>)) continue
    if (p.type === 'placement') { rows.push(<PlacementFields key={p.name} step={step} param={p} base={base[p.name]} t={t} onChange={v => set(p.name, v)} />); continue }
    rows.push(<Field key={p.name} step={step} param={p} fonts={fonts} t={t} sizeLimit={sizeLimitOf(op, step, base, p)} onChange={v => set(p.name, v)} onAsset={() => onAsset(p.name)} customer shopValue={base[p.name]} />)
  }
  return <div className="am-fieldlist"><h2>{t(`step.op.${step.op === 'emboss' ? 'text' : step.op === 'emboss_svg' ? 'svg' : step.op}`)} · {wordingOf(step)}</h2>{rows}</div>
}

/** The designer's size range lives in the placement limits and applies to the parameter named by `size_param`. */
function sizeLimitOf(op: Operation, step: Step, base: Record<string, unknown>, p: ParamDef): [number, number] | undefined {
  for (const q of op.params) {
    const pl = base[q.name]
    if (q.type === 'placement' && isPlacement(pl) && pl.limits?.size && (pl.limits.size_param ?? 'size') === p.name) return pl.limits.size
  }
  void step
  return undefined
}

export function Field({ step, param: p, fonts, t, sizeLimit, onChange, onAsset, onPlace, labelText, optionText, customer, shopValue }: { onPlace?: (path: string) => void; customer?: boolean; shopValue?: unknown; labelText?: string; optionText?: (value: string) => string; step: Step; param: ParamDef; fonts: FontChoice[]; t: PersonaliseOverlayProps['t']; sizeLimit: [number, number] | undefined; onChange: (v: unknown) => void; onAsset: () => void }): ReactElement | null {
  const id = `${step.id}-${p.name}`
  const pictures = usePictures()
  const storeView = useStoreView()
  const value = step.params[p.name] ?? p.default
  const label = labelText ?? labelOf(t, p.name)
  // the manifest may name an icon for the field (a hint): it goes in front of the label
  const lab = <>{p.icon ? <NamedIcon name={p.icon} size={14} /> : null}{label}</>
  switch (p.type) {
    case 'string': {
      const lim = step.personalisable_limits?.[p.name]
      return (
        <div className="am-field">
          <label htmlFor={id}>{lab}</label>
          {p.multiline
            ? <textarea id={id} value={String(value ?? '')} onChange={e => onChange(clampParam(p, fitTextToLimits(e.target.value, lim)))} />
            : <input id={id} type="text" value={String(value ?? '')} onChange={e => onChange(clampParam(p, fitTextToLimits(e.target.value, lim)))} />}
          {lim?.max_lines !== undefined || lim?.max_line_length !== undefined ? <p className="am-help">{t('text.limit', { lines: lim?.max_lines ?? '∞', chars: lim?.max_line_length ?? '∞' })}</p> : null}
        </div>
      )
    }
    case 'payload': {
      // a stored drawing or model, kept in the project. With the project's store (the editor's `store`) the designer gets the picker and the customer "Change drawing";
      // without it the host picks or imports it (an SVG becomes a drawing) and the setting shows its name
      if (storeView && customer) return <ChangeDrawing t={t} label={label} value={String(value ?? '')} shopValue={String(shopValue ?? '')} onChange={v => onChange(v)} />
      if (storeView) return <StoredPicker t={t} label={label} value={String(value ?? '')} accept={(p as { accept?: string[] }).accept} stepId={step.id} param={p.name} onChange={v => onChange(v)} />
      return <div className="am-field"><span className="am-label">{label}</span><div className="am-row"><button type="button" onClick={onAsset}>{String(value ?? '') || t('panel.choose')}</button></div></div>
    }
    case 'asset': {
      // the font grid is for fonts only; every other file setting (a picture, a gallery hint included) gets the host's own picker, which filters by `accept`
      if (p.widget === 'gallery' && pictures) {
        return <><span id={`${id}-l`} className="am-label">{label}</span><PictureGrid param={p} value={value} t={t} labelId={`${id}-l`} onPick={v => onChange(v)} onUpload={onAsset} /></>
      }
      if (p.widget !== 'font') {
        return <div className="am-field"><span className="am-label">{label}</span><div className="am-row"><button type="button" onClick={onAsset}>{String(value ?? '') || t('panel.choose')}</button></div></div>
      }
      return (
        <div className="am-field" role="group" aria-labelledby={`${id}-l`}>
          <span id={`${id}-l`} className="am-label">{label}</span>
          <div className="am-fonts">
            {fonts.map(f => (
              <button key={f.id} type="button" aria-pressed={value === f.id} onClick={() => onChange(f.id)} style={{ fontFamily: f.family }}>
                <span className="am-sample">{p.preview === 'text' ? wordingOf(step) || 'Aa' : 'Aa'}</span><span className="am-fontname">{f.family}</span>
              </button>
            ))}
          </div>
        </div>
      )
    }
    case 'float': case 'int': case 'angle': {
      const lo = sizeLimit?.[0] ?? p.min, hi = sizeLimit?.[1] ?? p.max
      const stp = ('step' in p && p.step) || (p.type === 'float' ? 0.1 : 1)
      const clamp = (v: number): number => Math.min(hi ?? Infinity, Math.max(lo ?? -Infinity, v))
      const unit = p.unit === 'deg' || p.type === 'angle' ? '\u00b0' : p.unit
      // the manifest's `widget` decides: a slider with its number box, plus and minus buttons, or just the number box (a customer's size range is always a slider)
      const kind = (p.widget === 'slider' || sizeLimit) && lo !== undefined && hi !== undefined ? 'slider' : p.widget === 'stepper' ? 'stepper' : 'number'
      const bump = (d: number): void => onChange(clamp(Math.round((Number(value) + d * stp) * 1e6) / 1e6))
      return (
        <div className="am-field">
          <label htmlFor={id}>{labelText !== undefined ? <>{p.icon ? <NamedIcon name={p.icon} size={14} /> : null}{labelText}</> : p.name === 'size' ? t('size.height') : lab}</label>
          <div className="am-row">
            {kind === 'slider' ? <input type="range" aria-label={label} min={lo} max={hi} step={stp} value={Number(value)} onChange={e => onChange(clamp(Number(e.target.value)))} /> : null}
            {kind === 'stepper' ? <button type="button" className="am-step-btn" aria-label={`${tx(t, 'panel.decrease', 'Decrease')} ${label}`} onClick={() => bump(-1)}>{'\u2212'}</button> : null}
            <input id={id} type="number" min={lo} max={hi} step={stp} value={Number(value)} onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(clamp(n)) }} />
            {kind === 'stepper' ? <button type="button" className="am-step-btn" aria-label={`${tx(t, 'panel.increase', 'Increase')} ${label}`} onClick={() => bump(1)}>+</button> : null}
            {unit ? <span className="am-unit">{unit}</span> : null}
          </div>
          {sizeLimit ? <p className="am-help">{t('size.range', { min: sizeLimit[0], max: sizeLimit[1] })}</p> : null}
        </div>
      )
    }
    case 'vector': {
      const cur = (Array.isArray(value) ? value : p.default) as number[]
      const names = p.labels ?? ['x', 'y', 'z']
      const unit = p.unit === 'deg' ? '\u00b0' : p.unit
      const setAt = (i: number, n: number): void => { if (!Number.isFinite(n)) return; const next = [...cur]; next[i] = Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, n)); onChange(next) }
      return (
        <div className="am-field" role="group" aria-labelledby={`${id}-l`}>
          <span id={`${id}-l`} className="am-label">{lab}</span>
          <div className="am-row">
            {cur.map((n, i) => {
              const axis = names[i] ?? ['x', 'y', 'z'][i] ?? String(i + 1)
              return (
                <label key={axis} className="am-axis" data-axis={axis.toLowerCase()}>
                  <span className="am-axis-name" aria-hidden="true">{axis.toUpperCase()}</span>
                  <input type="number" aria-label={`${label} ${axis}`} min={p.min} max={p.max} value={n} onChange={e => setAt(i, Number(e.target.value))} />
                  {unit ? <span className="am-unit" aria-hidden="true">{unit}</span> : null}
                </label>
              )
            })}
          </div>
        </div>
      )
    }
    case 'enum': {
      const opts = p.options.map(o => (typeof o === 'string' ? { value: o } : o) as { value: string; label?: string; icon?: string; shape?: string })
      const text = (o: { value: string; label?: string }): string => (optionText ? optionText(o.value) : (o.label ?? o.value))
      // many choices are a list; a few are buttons; `cards` (a hint) makes them cards. Choices with icons the host knows are cards with the icon shown (a list would hide them), when there are more than four
      const withIcons = opts.length > 4 && opts.some(o => o.shape || iconKey(o.icon))
      const kind = p.widget ?? (withIcons ? 'cards' : opts.length > 4 ? 'select' : 'segmented')
      if (kind === 'select') {
        return (
          <div className="am-field">
            <label htmlFor={id}>{lab}</label>
            <select id={id} value={String(value ?? '')} onChange={e => onChange(e.target.value)}>{opts.map(o => <option key={o.value} value={o.value}>{text(o)}</option>)}</select>
          </div>
        )
      }
      return (
        <div className="am-field" role="group" aria-labelledby={`${id}-l`}>
          <span id={`${id}-l`} className="am-label">{lab}</span>
          <div className={kind === 'cards' ? 'am-cards' : 'am-seg'}>
            {opts.map(o => <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>{o.shape ? <ShapeIcon d={o.shape} size={kind === 'cards' ? 48 : 24} fill={p.shape_style === 'fill'} /> : o.icon ? <NamedIcon name={o.icon} size={kind === 'cards' ? 28 : 16} /> : null}<span>{text(o)}</span>{kind === 'cards' && value === o.value ? <span className="am-card-check" aria-hidden="true"><Icon name="check" size={14} /></span> : null}</button>)}
          </div>
        </div>
      )
    }
    case 'placement': {
      // only reached inside a list row (a top-level placement has its own form): click on the model to set the point, click again to move it
      const placed = isPlacement(value)
      return (
        <div className="am-field am-place" role="group" aria-labelledby={`${id}-l`}>
          <span id={`${id}-l`} className="am-label">{label}</span>
          <div className="am-row">
            <button type="button" disabled={!onPlace} onClick={() => onPlace?.(p.name)}><NamedIcon name="user" size={16} />{placed ? tx(t, 'panel.place_again', 'Move on the model') : tx(t, 'panel.place', 'Place on the model')}</button>
            <span className="am-help">{placed ? tx(t, 'panel.placed', 'Placed') : tx(t, 'panel.not_placed', 'Not placed')}</span>
            {placed ? <button type="button" onClick={() => onChange(null)}>{tx(t, 'panel.clear', 'Clear')}</button> : null}
          </div>
        </div>
      )
    }
    case 'bool': return <div className="am-field"><label><input type="checkbox" checked={Boolean(value)} onChange={e => onChange(e.target.checked)} /> {label}</label></div>
    case 'color': {
      const cur = String(value ?? p.default)
      return (
        <div className="am-field" role="group" aria-labelledby={`${id}-l`}>
          <span id={`${id}-l`} className="am-label">{label}</span>
          <div className="am-row">
            {p.only_palette ? null : <input type="color" aria-label={label} value={cur.slice(0, 7)} onChange={e => onChange(clampParam(p, e.target.value + (p.alpha && cur.length === 9 ? cur.slice(7) : '')))} />}
            {(p.palette ?? []).map(c => <button key={c} type="button" className="am-swatch" aria-label={c} aria-pressed={cur.toLowerCase() === c.toLowerCase()} style={{ background: c.slice(0, 7) }} onClick={() => onChange(clampParam(p, c))} />)}
          </div>
        </div>
      )
    }
    case 'range': {
      const cur = (Array.isArray(value) ? value : p.default) as [number, number]
      const set = (i: 0 | 1, n: number): void => { if (Number.isFinite(n)) { const next = [...cur] as [number, number]; next[i] = n; onChange(clampParam(p, next)) } }
      return (
        <div className="am-field" role="group" aria-labelledby={`${id}-l`}>
          <span id={`${id}-l`} className="am-label">{label}</span>
          <div className="am-row">
            <input type="number" aria-label={`${label} ${tx(t, 'panel.from', 'from')}`} min={p.min} max={p.max} value={cur[0]} onChange={e => set(0, Number(e.target.value))} />
            <span aria-hidden="true">{tx(t, 'panel.to', 'to')}</span>
            <input type="number" aria-label={`${label} ${tx(t, 'panel.to', 'to')}`} min={p.min} max={p.max} value={cur[1]} onChange={e => set(1, Number(e.target.value))} />
          </div>
        </div>
      )
    }
    case 'object': {
      const cur = (typeof value === 'object' && value !== null ? value : p.default) as Record<string, unknown>
      return (
        <fieldset className="am-group-box">
          <legend>{label}</legend>
          {p.fields.map(f => <Field key={f.name} step={{ ...step, params: cur }} param={f} fonts={fonts} t={t} sizeLimit={undefined} onChange={v => onChange({ ...cur, [f.name]: v })} onAsset={onAsset} />)}
        </fieldset>
      )
    }
    case 'list': {
      const rows = (Array.isArray(value) ? value : p.default) as Array<Record<string, unknown>>
      return (
        <div className="am-field" role="group" aria-labelledby={`${id}-l`}>
          <span id={`${id}-l`} className="am-label">{label}</span>
          {rows.map((row, i) => (
            <fieldset key={i} className="am-group-box">
              <legend>{`${p.item_label ?? label} ${i + 1}`}</legend>
              {p.item.map(f => <Field key={f.name} step={{ ...step, params: row }} param={f} fonts={fonts} t={t} sizeLimit={undefined} onChange={v => onChange(rows.map((r, k) => (k === i ? { ...r, [f.name]: v } : r)))} onAsset={onAsset} {...(onPlace ? { onPlace: (name: string) => onPlace(`${p.name}.${i}.${name}`) } : {})} />)}
              <button type="button" disabled={p.min_items !== undefined && rows.length <= p.min_items} onClick={() => onChange(rows.filter((_, k) => k !== i))}>{tx(t, 'panel.remove', 'Remove')}</button>
            </fieldset>
          ))}
          <button type="button" disabled={p.max_items !== undefined && rows.length >= p.max_items} onClick={() => onChange([...rows, Object.fromEntries(p.item.map(f => [f.name, f.default]))])}>{tx(t, 'panel.add', 'Add')}</button>
        </div>
      )
    }
    default: return null
  }
}

/** A text with a plain-English fallback, for the few generic words design has not written yet. */
const tx = (t: PersonaliseOverlayProps['t'], key: string, fallback: string): string => { const v = t(key); return v === key ? fallback : v }

function labelOf(t: PersonaliseOverlayProps['t'], name: string): string {
  const key = ({ text: 'text.wording', font: 'text.font', size: 'size.height', height: 'size.depth', mode: 'text.letters' } as Record<string, string>)[name]
  return key ? t(key) : name.replace(/_/g, ' ')
}

// ---------------------------------------------------------------------------------------------------- direction and position

function PlacementFields({ step, param, base, t, onChange }: { step: Step; param: ParamDef; base: unknown; t: PersonaliseOverlayProps['t']; onChange: (v: PlacementValue) => void }): ReactElement | null {
  const cur = step.params[param.name]
  if (!isPlacement(cur)) return null
  const designer = isPlacement(base) ? base : cur
  const mayTurn = canPersonalise(step, param.name, 'direction'), mayMove = canPersonalise(step, param.name, 'position')
  const lim = designer.limits
  const apply = (next: PlacementValue): void => onChange(clampPlacementToLimits(designer, next))
  const dir = cur.direction ?? 0
  const turnTo = (d: number): void => { let v = d; if (v > 180) v -= 360; if (v < -180) v += 360; apply({ ...cur, direction: v }) }
  const room = (dx: number, dy: number): boolean => {
    if (lim?.max_distance === undefined) return true
    const o = cur.offset ?? [0, 0], b = designer.offset ?? [0, 0]
    return Math.hypot(o[0] + dx - b[0], o[1] + dy - b[1]) <= lim.max_distance + 1e-9
  }
  const nudge = (dx: number, dy: number): void => { const o = cur.offset ?? [0, 0]; apply({ ...cur, offset: [o[0] + dx, o[1] + dy] }) }
  const outside = (d: number): boolean => !!lim?.direction && (d < lim.direction[0] - 1e-9 || d > lim.direction[1] + 1e-9)
  return (
    <div className="am-field am-place">
      {mayTurn ? (
        <div role="group" aria-label={t('pos.direction')}>
          <span className="am-label">{t('pos.direction')}</span>
          <div className="am-seg">
            {[-90, 0, 90].map(d => <button key={d} type="button" disabled={outside(d)} aria-pressed={dir === d} onClick={() => turnTo(d)}>{d > 0 ? `+${d}°` : `${d}°`}</button>)}
            <input type="number" aria-label={t('pos.angle')} value={dir} min={lim?.direction?.[0] ?? -180} max={lim?.direction?.[1] ?? 180} onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n)) turnTo(n) }} />
          </div>
          {lim?.direction ? <p className="am-help">{t('pos.angleRange', { min: lim.direction[0], max: lim.direction[1] })}</p> : null}
        </div>
      ) : null}
      {mayMove ? (
        <div role="group" aria-label={t('pos.move')}>
          <span className="am-label">{t('pos.move')}</span>
          <div className="am-nudge">
            <button type="button" aria-label={t('pos.left')} disabled={!room(-1, 0)} onClick={() => nudge(-1, 0)}>←</button>
            <button type="button" aria-label={t('pos.up')} disabled={!room(0, 1)} onClick={() => nudge(0, 1)}>↑</button>
            <button type="button" aria-label={t('pos.down')} disabled={!room(0, -1)} onClick={() => nudge(0, -1)}>↓</button>
            <button type="button" aria-label={t('pos.right')} disabled={!room(1, 0)} onClick={() => nudge(1, 0)}>→</button>
            <button type="button" onClick={() => apply(designer)}>{t('pos.reset')}</button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------- problems

function Problem({ stepId, code, params, t, step, onFix, warning }: { stepId: string; warning?: boolean; code: string; params: Record<string, unknown> | undefined; t: PersonaliseOverlayProps['t']; step: Step | undefined; onFix: (set: Record<string, string | number>) => void }): ReactElement {
  void stepId; void step
  const v0 = describeProblem(code, params ?? {}, warning ? { channel: 'warning' } : {})
  // a customer gets a calm sentence, not the name of a plugin or what it threw
  const v = code === 'plugin.crashed' || code === 'plugin.disabled' ? { ...v0, key: 'mesh.plugin.customer', values: {} } : v0
  const group = /^mesh\.([a-z]+)\./.exec(v.key)?.[1]
  const key = t(v.key) !== v.key ? v.key : group && t(`mesh.${group}._any`) !== `mesh.${group}._any` ? `mesh.${group}._any` : 'mesh.unknown'
  return (
    <div className={`am-problem am-${v.kind}`} role={v.kind === 'error' ? 'alert' : 'status'}>
      <p>{problemText(t, key, { ...v.values, code })}</p>
      {v.blocks && !['run.cancelled', 'run.timeout'].includes(code) ? <p className="am-quiet">{t('work.lastGood')}</p> : null}
      <div className="am-row">
        {v.actions.filter(a => a.set).map(a => <button key={a.key} type="button" onClick={() => onFix(a.set as Record<string, string | number>)}>{t(a.key, a.values)}</button>)}
      </div>
    </div>
  )
}
