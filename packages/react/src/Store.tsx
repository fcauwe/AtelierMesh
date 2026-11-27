// The screens of the project store (design round 6): the Stored tab, the Import SVG dialog, the picker a stored-item setting uses, and the customer's "Change drawing".
// The store itself (the items, their budget, importing, replacing, deleting) belongs to the project session; a host gives the editor a `StoreHost` made from it
// (`useStoreHost`). Texts are under `store.*`; every text falls back to English so a host with its own locale files still reads something.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { DEFAULT_STORE_LIMITS, STORE_NAME_RE, listStore } from '@ateliermesh/core'
import type { Payload, ProjectStore, Registry, StepList, StepResult, StoreLimits, StoreRow, StructuredError } from '@ateliermesh/core'
import { importSvg } from '@ateliermesh/plugins'
import type { SvgImport } from '@ateliermesh/plugins'
import { Dialog, fileAccept, tx, useMediaQuery } from './common'
import type { T } from './common'
import { Icon } from './icons'
import { storedName } from './useProjectSession'
import type { ProjectSession } from './useProjectSession'

/** What a customer's own drawing may hold, by default: paths (outlines after the import) and points. A host sets its own with `StoreHost.customerLimits`. */
export const DEFAULT_CUSTOMER_DRAWING_LIMITS = { paths: 2000, points: 50000 } as const

export interface StoreHost {
  /** The project's imported items. */
  store: ProjectStore
  /** The budget: at most this many items and bytes together (`DEFAULT_STORE_LIMITS` by default). */
  limits: StoreLimits
  /** What a customer's own drawing may hold (see `DEFAULT_CUSTOMER_DRAWING_LIMITS`). */
  customerLimits: { paths: number; points: number }
  importSvg: ProjectSession['importStoredSvg']
  replaceSvg: ProjectSession['replaceStoredSvg']
  remove: ProjectSession['removeStoredItem']
}

/** The store of the project, for the editor and the customer's screen. Null before a project is open. */
export function useStoreHost(session: ProjectSession, o: { limits?: StoreLimits; customerLimits?: { paths: number; points: number } } = {}): StoreHost | null {
  const store = session.doc?.store
  const { importStoredSvg, replaceStoredSvg, removeStoredItem } = session
  const limits = o.limits ?? DEFAULT_STORE_LIMITS, customerLimits = o.customerLimits ?? DEFAULT_CUSTOMER_DRAWING_LIMITS
  return useMemo(() => (store ? { store, limits, customerLimits, importSvg: importStoredSvg, replaceSvg: replaceStoredSvg, remove: removeStoredItem } : null),
    [store, limits.maxStoreEntries, limits.maxStoreBytes, customerLimits.paths, customerLimits.points, importStoredSvg, replaceStoredSvg, removeStoredItem])
}

interface StoreView { host: StoreHost; rows: StoreRow[]; list: StepList }
const StoreContext = createContext<StoreView | null>(null)
export const StoreProvider = StoreContext.Provider
/** What a stored-item setting needs: the rows (with who uses them) and the host. Null when the page has no store. */
export const useStoreView = (): StoreView | null => useContext(StoreContext)
export const makeStoreView = (host: StoreHost, list: StepList, registry: Registry, results?: ReadonlyArray<StepResult | undefined>, original?: Payload | null): StoreView => ({ host, list, rows: listStore(host.store, list, { registry, ...(results ? { results } : {}), ...(original ? { original } : {}) }) })

// ------------------------------------------------------------------------------------------------------ small pieces
const MIB = 1024 * 1024
const mb = (bytes: number): string => `${(Math.round((bytes / MIB) * 10) / 10).toLocaleString('en-US')} MB`
/** A size the way the rows show it: `38 kB`, `1.2 MB`. */
export const formatBytes = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : bytes < MIB ? `${Math.max(1, Math.round(bytes / 1024))} kB` : mb(bytes))
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
const nameOf = (rows: StoreRow[], list: StepList) => (id: string): number => list.steps.findIndex(s => s.id === id) + 1

/** A drawing as a small picture: the outlines, filled (the fill rule is the drawing's own) or as lines. */
export function DrawingThumb({ drawing, size = 40, line = false }: { drawing: { paths: Array<{ points: Array<[number, number]>; closed?: boolean }>; fillRule?: string }; size?: number; line?: boolean }): ReactElement {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of drawing.paths) for (const [x, y] of p.points) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  const w = Math.max(1e-6, x1 - x0), h = Math.max(1e-6, y1 - y0), pad = Math.max(w, h) * 0.06
  const d = drawing.paths.map(p => `M${p.points.map(([x, y]) => `${(x - x0).toFixed(3)} ${(y1 - y).toFixed(3)}`).join('L')}${p.closed === false ? '' : 'Z'}`).join('')
  return (
    <svg className="am-thumb" width={size} height={size} viewBox={`${-pad} ${-pad} ${w + 2 * pad} ${h + 2 * pad}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
      <path d={d} fillRule={drawing.fillRule === 'evenodd' ? 'evenodd' : 'nonzero'} fill={line ? 'none' : 'currentColor'} stroke={line ? 'currentColor' : 'none'} strokeWidth={Math.max(w, h) * 0.03} strokeLinejoin="round" />
    </svg>
  )
}
const isDrawing = (p: Payload | undefined): p is Payload & { paths: Array<{ points: Array<[number, number]>; closed?: boolean }> } => !!p && Array.isArray((p as { paths?: unknown }).paths)
function Thumb({ row, size = 52 }: { row: StoreRow; size?: number }): ReactElement {
  if (isDrawing(row.payload)) return <DrawingThumb drawing={row.payload} size={size} line={row.source?.mode === 'line'} />
  return <span className="am-thumb am-thumb-icon" style={{ width: size, height: size }} aria-hidden="true"><Icon name={row.kind === 'drawing' ? 'penTool' : 'box'} size={Math.round(size * 0.45)} /></span>
}
const kindLabel = (t: T, kind: string): string => (kind === 'drawing' ? tx(t, 'store.kind.drawing', 'Drawing') : kind === 'mesh' ? tx(t, 'store.kind.model', 'Model') : kind || '')
function sizeText(t: T, row: StoreRow): string {
  const s = row.size
  if (!s) return ''
  if (s.paths !== undefined) return t(s.paths === 1 ? 'store.size.drawing_one' : 'store.size.drawing_other', { count: s.paths, paths: s.paths, points: (s.points ?? 0).toLocaleString('en-US').replace(/,/g, ' ') })
  if (s.triangles !== undefined) return t('store.size.model', { triangles: s.triangles.toLocaleString('en-US').replace(/,/g, ' ') })
  return formatBytes(s.bytes)
}
/** The size line of a row: what it holds, then how big it is in the file. */
const sizeLine = (t: T, row: StoreRow): string => (row.size ? `${sizeText(t, row)} · ${formatBytes(row.size.bytes)}` : '')

/** The text that explains a failed import, with the way out the dialog offers. */
function importProblem(t: T, e: StructuredError, mode: 'fill' | 'line'): { text: string; fix?: string; other?: { mode: 'fill' | 'line'; label: string } } {
  const p = (e.params ?? {}) as Record<string, unknown>
  switch (e.code) {
    case 'emboss.svg_too_large': return { text: tx(t, 'store.err.tooBig', 'This file is {{size}}. The largest SVG we take is 2 MB.', { size: mb(Number(p['bytes'] ?? 0)) }), fix: tx(t, 'store.err.tooBigFix', 'Embedded pictures usually make it big. Save it without them, then try again.') }
    case 'emboss.svg_unsafe': return { text: tx(t, 'store.err.unsafe', 'This SVG contains scripts or links to other files, which we don’t accept.'), fix: tx(t, 'store.err.unsafeFix', 'Save it again as a plain SVG (in Inkscape: Save as › Plain SVG).') }
    case 'emboss.svg_too_complex': return { text: tx(t, 'store.err.tooComplex', 'This drawing has {{count}} shapes; the most we take is {{max}}.', { count: Number(p['elements'] ?? 0), max: 5000 }), fix: tx(t, 'store.err.tooComplexFix', 'Combine or simplify shapes in your drawing program, then try again.') }
    case 'emboss.svg_empty_mode': {
      const was = p['mode'] === 'line' ? 'line' : mode
      return was === 'fill'
        ? { text: tx(t, 'store.err.onlyStrokes', 'This SVG has only strokes: choose Line.'), other: { mode: 'line', label: tx(t, 'store.useLine', 'Use Line') } }
        : { text: tx(t, 'store.err.onlyFills', 'This SVG has only filled areas: choose Fill.'), other: { mode: 'fill', label: tx(t, 'store.useFill', 'Use Fill') } }
    }
    case 'budget.store_bytes': case 'budget.store_entries': return { text: tx(t, 'store.problem.budget', 'This project holds too much: {{size}} of the {{max}} allowed. Delete stored items you no longer use.', { size: mb(Number(p['bytes'] ?? 0)), max: mb(Number(p['max'] ?? 0)) }) }
    case 'store.name_taken': return { text: tx(t, 'store.err.nameTaken', '“{{name}}” is already in this project.', { name: String(p['name'] ?? '') }) }
    case 'store.bad_name': return { text: tx(t, 'store.err.nameInvalid', 'Use only lowercase letters, digits and _, up to 40 characters.') }
    case 'emboss.empty_shape': case 'import.invalid_drawing': return { text: tx(t, 'store.err.empty', 'There is no drawing in this file that we can use.') }
    default: return { text: tx(t, 'store.err.generic', 'This file can’t be imported.') }
  }
}

// ------------------------------------------------------------------------------------------------------ the Import SVG dialog
export interface ImportDialogProps {
  t: T
  host: StoreHost
  /** The text of the SVG file the person chose, and its name (the stored name starts from it). */
  svg: string
  fileName: string
  /** A fixed name: replacing an item, or importing for a name steps already use. Absent: the person names it. */
  name?: string
  /** Replace: the item keeps its name and every step using it follows. */
  replace?: boolean
  /** The mode to start with (a replaced drawing keeps its Fill or Line). */
  mode?: 'fill' | 'line'
  onClose: () => void
  /** Called with the stored name once the drawing is kept. */
  onDone: (name: string) => void
  /** A file that is refused before it is read (too big, unsafe, too complex) offers "Choose another file": this opens the file chooser again. */
  onChooseOther?: () => void
}

export function ImportSvgDialog(p: ImportDialogProps): ReactElement {
  const { t, host } = p
  const [mode, setMode] = useState<'fill' | 'line'>(p.mode ?? 'fill')
  const [name, setName] = useState(() => p.name ?? storedName(p.fileName, host.store))
  const [failed, setFailed] = useState<StructuredError | null>(null)
  const [replaceOld, setReplaceOld] = useState(false)
  const result = useMemo<{ ok: true; imp: SvgImport } | { ok: false; error: StructuredError }>(() => {
    try { return { ok: true, imp: importSvg(p.svg, { mode }) } } catch (e) { const x = e as { code?: string; params?: Record<string, unknown> }; return { ok: false, error: { code: typeof x.code === 'string' ? x.code : 'import.invalid_drawing', ...(x.params ? { params: x.params } : {}) } } }
  }, [p.svg, mode])
  const fixed = p.name !== undefined
  const taken = !fixed && !p.replace && !!host.store[name] && !replaceOld
  const nameBad = !fixed && !STORE_NAME_RE.test(name)
  const problem = !result.ok ? importProblem(t, result.error, mode) : failed ? importProblem(t, failed, mode) : null
  const keep = (): void => {
    if (!result.ok) return
    const r = p.replace && p.name ? host.replaceSvg(p.name, p.svg, mode) : host.importSvg(p.fileName, p.svg, mode, { name, replace: replaceOld || fixed })
    if (r.ok) { p.onDone(p.name ?? (r as { name?: string }).name ?? name); p.onClose() } else setFailed(r.error)
  }
  const ignored = result.ok ? (result.imp.warnings.find(w => w.code === 'svg.ignored_elements')?.params['elements'] as string[] | undefined) : undefined
  const free = storedName(name, host.store)
  // a file that is too big, unsafe or too complex is refused before it is read: no preview and no choices, only a way to choose another file
  const refused = !result.ok && ['emboss.svg_too_large', 'emboss.svg_unsafe', 'emboss.svg_too_complex'].includes(result.error.code)
  const fileBytes = useMemo(() => new TextEncoder().encode(p.svg).length, [p.svg])
  return (
    <Dialog title={p.replace ? tx(t, 'store.replaceTitle', 'Replace “{{name}}”', { name: p.name ?? name }) : tx(t, 'store.importTitle', 'Import SVG')} onClose={p.onClose} t={t}>
      <div className="am-importdlg">
        <p className="am-importfile"><Icon name="penTool" size={14} /> <span>{p.fileName}</span> <span className="am-help">· {formatBytes(fileBytes)}</span></p>
        {refused ? null : (
          <div className="am-importprev" aria-label={p.fileName}>
            {result.ok ? <DrawingThumb drawing={result.imp.entry.payload} size={170} line={mode === 'line'} /> : <Icon name="alert" size={32} />}
            {result.ok ? (
              <span className="am-importsize">
                {t(result.imp.stats.paths === 1 ? 'store.size.drawing_one' : 'store.size.drawing_other', { count: result.imp.stats.paths, paths: result.imp.stats.paths, points: result.imp.stats.points.toLocaleString('en-US').replace(/,/g, '\u202f') })}
                {' · '}{tx(t, 'store.sizeMm', '{{w}} × {{h}} mm', { w: Math.round(result.imp.stats.sizeMm[0] * 10) / 10, h: Math.round(result.imp.stats.sizeMm[1] * 10) / 10 })}
              </span>
            ) : null}
          </div>
        )}
        {refused ? null : (
          <>
            <div className="am-field" role="group" aria-labelledby="am-import-use">
              <span id="am-import-use" className="am-label">{tx(t, 'store.use', 'Use')}</span>
              <div className="am-segwide">
                {(['fill', 'line'] as const).map(m => <button key={m} type="button" aria-pressed={mode === m} onClick={() => { setMode(m); setFailed(null) }}>{t(`store.mode.${m}`)}</button>)}
              </div>
              <p className="am-help">{t(mode === 'fill' ? 'store.mode.fillHint' : 'store.mode.lineHint')}</p>
            </div>
            <div className="am-field">
              <label htmlFor="am-import-name">{tx(t, 'store.keepAs', 'Keep it as')}</label>
              <input id="am-import-name" className="am-mono" value={name} maxLength={40} readOnly={fixed} aria-readonly={fixed} aria-invalid={nameBad || taken} onChange={e => { setName(e.target.value); setFailed(null); setReplaceOld(false) }} />
              {fixed ? null : <p className={nameBad ? 'am-error-text' : 'am-help'}>{nameBad ? t('store.err.nameInvalid') : t('store.nameHint')}</p>}
            </div>
          </>
        )}
        {ignored && ignored.length > 0 ? <p className="am-help" role="note">{tx(t, 'store.ignored', '{{count}} elements were left out: {{elements}}', { count: ignored.length, elements: [...new Set(ignored)].join(', ') })}</p> : null}
        {problem ? (
          <div className="am-problem" role="alert">
            <p>{problem.text}</p>
            {problem.fix ? <p className="am-help">{problem.fix}</p> : null}
            {problem.other ? <button type="button" onClick={() => { setMode(problem.other?.mode ?? 'fill'); setFailed(null) }}>{problem.other.label}</button> : null}
          </div>
        ) : null}
        {taken ? (
          <div className="am-problem" role="alert">
            <p>{t('store.err.nameTaken', { name })}</p>
            <div className="am-actions">
              <button type="button" onClick={() => setName(free)}>{t('store.useName', { name: free })}</button>
              <button type="button" onClick={() => setReplaceOld(true)}>{t('store.replaceIt')}</button>
            </div>
          </div>
        ) : null}
        {p.replace && !refused ? <p className="am-help">{tx(t, 'store.replaceNote', 'The steps that use it follow the new drawing.')}</p> : null}
      </div>
      <div className="am-actions">
        <button type="button" onClick={p.onClose}>{t('store.cancel')}</button>
        {refused && p.onChooseOther
          ? <button type="button" className="am-primary" data-autofocus onClick={() => { p.onClose(); p.onChooseOther?.() }}>{t('store.chooseOther')}</button>
          : <button type="button" className="am-primary" data-autofocus disabled={!result.ok || nameBad || taken} onClick={keep}>{t('store.keep')}</button>}
      </div>
    </Dialog>
  )
}

/** A hidden file field the person is sent to, then the SVG text: `choose()` opens the chooser. */
function useSvgChooser(onFile: (file: { name: string; text: string }) => void): { choose: () => void; field: ReactElement } {
  const input = useRef<HTMLInputElement>(null)
  return {
    choose: () => input.current?.click(),
    field: <input ref={input} type="file" className="am-sr" tabIndex={-1} aria-hidden="true" accept={fileAccept('.svg,image/svg+xml')} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void f.text().then(text => onFile({ name: f.name, text })) }} />,
  }
}

// ------------------------------------------------------------------------------------------------------ the Stored tab
export interface StoredPanelProps {
  t: T
  host: StoreHost
  rows: StoreRow[]
  list: StepList
  /** Selects a step (the "Used by step 3" links). */
  onGoToStep?: (stepId: string) => void
}

export function StoredPanel({ t, host, rows, list, onGoToStep }: StoredPanelProps): ReactElement {
  const [dialog, setDialog] = useState<{ svg: string; fileName: string; name?: string; replace?: boolean; mode?: 'fill' | 'line' } | null>(null)
  const [deleting, setDeleting] = useState<StoreRow | null>(null)
  const [opened, setOpened] = useState<string | null>(null)   // a row opens in place to show what can be done with it
  const target = useRef<{ name?: string; replace?: boolean; mode?: 'fill' | 'line' }>({})
  const chooser = useSvgChooser(f => setDialog({ svg: f.text, fileName: f.name, ...target.current }))
  const pick = (o: { name?: string; replace?: boolean; mode?: 'fill' | 'line' } = {}): void => { target.current = o; chooser.choose() }
  const stepN = nameOf(rows, list)
  const missing = rows.filter(r => r.missing), present = rows.filter(r => !r.missing)
  const entries = Object.keys(host.store).length
  const bytes = rows.reduce((n, r) => n + (r.origin === 'project' && r.size ? r.size.bytes : 0), 0)
  const stepsText = (r: StoreRow): ReactNode => r.usedBy.map((u, i) => (
    <span key={`${u.step}-${u.param}`}>{i > 0 ? ', ' : ''}<button type="button" className="am-link" aria-label={t('store.goToStep', { n: stepN(u.step) })} onClick={() => onGoToStep?.(u.step)}>{t('store.stepN', { n: stepN(u.step) })}</button></span>
  ))
  const full = (host.limits.maxStoreEntries !== undefined && entries >= host.limits.maxStoreEntries)
  const used = Math.max(host.limits.maxStoreEntries ? entries / host.limits.maxStoreEntries : 0, host.limits.maxStoreBytes ? bytes / host.limits.maxStoreBytes : 0)   // how full the budget is, 0 to 1
  return (
    <section className="am-stored" aria-label={t('store.title')}>
      {chooser.field}
      <button type="button" className="am-panelact" disabled={full} title={full ? tx(t, 'store.problem.budget', 'This project holds too much: {{size}} of the {{max}} allowed. Delete stored items you no longer use.', { size: mb(bytes), max: mb(host.limits.maxStoreBytes ?? 0) }) : undefined} onClick={() => pick()}><Icon name="upload" size={16} />{t('store.import')}</button>
      <p className="am-help am-panelabout">{tx(t, 'store.about', 'Drawings and models this project keeps. Steps use them by name.')}</p>
      {rows.every(r => r.origin === 'original') ? <p className="am-help am-stored-empty">{t('store.empty')}</p> : null}
      {rows.length === 0 ? null : (
        <ul className="am-storedlist">
          {missing.map(r => (
            <li key={r.name} className="am-storedrow am-missing" data-store-name={r.name}>
              <span className="am-thumb am-thumb-icon am-thumb-missing" aria-hidden="true"><Icon name="alert" size={22} /></span>
              <div className="am-storedinfo">
                <span className="am-mono am-storedname">{r.name}</span>
                <span className="am-bad">{t('store.missing')}</span>
                <span className="am-help">{t('store.neededBy', { steps: '' })}{stepsText(r)}</span>
              </div>
              <div className="am-storedacts"><button type="button" className="am-primary" onClick={() => pick({ name: r.name })}><Icon name="upload" size={16} />{t('store.import')}</button></div>
            </li>
          ))}
          {present.map(r => {
            const key = `${r.origin}-${r.name}-${r.step ?? ''}`
            const isOpen = opened === key
            return (
              <li key={key} className={`am-storedrow am-storedrow-card${isOpen ? ' am-open' : ''}`} data-store-name={r.name}>
                <button type="button" className="am-storedhead" aria-expanded={isOpen} aria-label={`${r.name}, ${kindLabel(t, r.kind)}`} onClick={() => setOpened(isOpen ? null : key)}>
                  <Thumb row={r} />
                  <span className="am-storedinfo">
                    <span className="am-storedtitle"><Icon name={r.kind === 'drawing' ? 'penTool' : 'box'} size={14} /><span className="am-mono am-storedname">{r.name}</span></span>
                    <span className="am-help">{sizeLine(t, r)}</span>
                    <span className="am-help">{r.origin === 'step' ? t('store.origin.step', { n: stepN(r.step ?? '') }) : r.origin === 'original' ? tx(t, 'store.origin.original', 'The model this project started from') : t('store.origin.imported')} · {r.usedBy.length > 0 ? t('store.usedBy', { steps: r.usedBy.map(u => t('store.stepN', { n: stepN(u.step) })).join(', ') }) : t('store.notUsed')}</span>
                  </span>
                  <Icon name={isOpen ? 'chevronUp' : 'chevronDown'} size={16} />
                </button>
                {isOpen ? (
                  <div className="am-storedbody">
                    {r.origin === 'project' ? (
                      <div className="am-storedacts">
                        {r.kind === 'drawing' ? <button type="button" aria-label={`${t('store.replace')} ${r.name}`} onClick={() => pick({ name: r.name, replace: true, ...(r.source?.mode ? { mode: r.source.mode } : {}) })}><Icon name="upload" size={16} />{t('store.replace')}</button> : null}
                        <button type="button" className="am-danger" aria-label={`${t('store.delete')} ${r.name}`} onClick={() => setDeleting(r)}><Icon name="trash" size={16} />{t('store.delete')}</button>
                      </div>
                    ) : r.origin === 'original' ? (
                      <div className="am-lockedrow"><p className="am-help"><Icon name="lock" size={14} /> {tx(t, 'store.originalNote', 'The original model. It cannot be changed or deleted. A Load step with this name brings it back at that point in the steps.')}</p></div>
                    ) : (
                      <div className="am-lockedrow">
                        <p className="am-help"><Icon name="lock" size={14} /> {t('store.producedNote')}</p>
                        {r.step ? <button type="button" className="am-link" onClick={() => onGoToStep?.(r.step as string)}>{t('store.goToStep', { n: stepN(r.step) })} →</button> : null}
                      </div>
                    )}
                    {r.usedBy.length > 0 ? <p className="am-help">{t('store.usedBy', { steps: '' })}{stepsText(r)}</p> : null}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      <div className="am-storebudget" data-testid="store-budget">
        <p className="am-help">{t('store.budget', { count: entries, max: host.limits.maxStoreEntries ?? '∞', size: formatBytes(bytes), maxSize: formatBytes(host.limits.maxStoreBytes ?? 0) })}</p>
        <span className={`am-budgetbar${used >= 0.9 ? ' am-near' : ''}`} role="presentation"><span style={{ width: `${Math.round(Math.min(1, used) * 100)}%` }} /></span>
      </div>
      {dialog ? <ImportSvgDialog t={t} host={host} {...dialog} onClose={() => setDialog(null)} onDone={() => undefined} onChooseOther={() => { target.current = { ...(dialog.name ? { name: dialog.name } : {}), ...(dialog.replace ? { replace: true } : {}) }; chooser.choose() }} /> : null}
      {deleting ? (
        <Dialog title={t('store.deleteTitle', { name: deleting.name })} onClose={() => setDeleting(null)} t={t}>
          <p>{deleting.usedBy.length > 0
            ? cap(t(deleting.usedBy.length === 1 ? 'store.deleteUsed_one' : 'store.deleteUsed_other', { count: deleting.usedBy.length, steps: deleting.usedBy.map(u => t('store.stepN', { n: stepN(u.step) })).join(', ') }))
            : t('store.deleteUnused')}</p>
          <div className="am-actions">
            <button type="button" data-autofocus onClick={() => setDeleting(null)}>{t('store.cancel')}</button>
            <button type="button" className="am-primary" onClick={() => { host.remove(deleting.name); setDeleting(null) }}>{deleting.usedBy.length > 0 ? t('store.deleteAnyway') : t('store.delete')}</button>
          </div>
        </Dialog>
      ) : null}
    </section>
  )
}

/** The count and the red dot of the Stored tab: how many items, and whether a step needs one that is missing. */
/** The tab's count is every item the list shows, what a Store step makes included (as drawn); the red dot is a step that needs an item nothing provides. */
export const storedTabState = (rows: StoreRow[]): { count: number; missing: number } => ({ count: rows.filter(r => !r.missing && r.origin !== 'original').length, missing: rows.filter(r => r.missing).length })

// ------------------------------------------------------------------------------------------------------ the picker of a stored-item setting
/** Which stored kinds a `payload` setting takes: `accept` lists them (`['drawing']`, `['mesh']`, `['*']` for any). */
const accepts = (accept: readonly string[] | undefined, kind: string): boolean => !accept || accept.length === 0 || accept.includes('*') || accept.includes(kind)

export function StoredPicker({ t, label, value, accept, onChange, stepId, param }: { t: T; label: string; value: string; accept?: readonly string[]; onChange: (name: string) => void; stepId?: string; param?: string }): ReactElement {
  const view = useStoreView()
  const phone = useMediaQuery('(max-width: 768px)')
  const [open, setOpen] = useState(false)
  const [dialog, setDialog] = useState<{ svg: string; fileName: string } | null>(null)
  const chooser = useSvgChooser(f => { setOpen(false); setDialog({ svg: f.text, fileName: f.name }) })
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const choicesCount = view ? view.rows.filter(r => !r.missing && r.kind !== '' && accepts(accept, r.kind)).length : 0
  // the banner of a step problem sends here: "Choose a drawing" opens the list, "Import…" the file chooser
  useEffect(() => {
    const on = (e: Event): void => {
      const d = (e as CustomEvent<{ stepId: string; param?: string; action: 'choose' | 'import' }>).detail
      if (!d || d.stepId !== stepId || (d.param && param && d.param !== param)) return
      if (d.action === 'import') chooser.choose(); else if (choicesCount === 0) chooser.choose(); else setOpen(true)
    }
    window.addEventListener('am-store-action', on); return () => window.removeEventListener('am-store-action', on)
  })
  // the list under the button closes with Escape and a click outside
  useEffect(() => {
    if (!open || phone) return
    const out = (e: MouseEvent): void => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); button.current?.focus() } }
    document.addEventListener('mousedown', out); document.addEventListener('keydown', esc, true)
    return () => { document.removeEventListener('mousedown', out); document.removeEventListener('keydown', esc, true) }
  }, [open, phone])
  if (!view) return <div className="am-field"><span className="am-label">{label}</span><div className="am-row"><span className="am-mono">{value || tx(t, 'panel.choose', 'Choose…')}</span></div></div>
  const { host, rows, list } = view
  const wantsDrawing = !accept || accept.includes('drawing') || accept.includes('*')
  const anyKind = !accept || accept.includes('*')
  // a result a `store` step makes is offered even before a run has reached it (its kind is not known yet): only a setting that takes anything can use it
  const choices = rows.filter(r => !r.missing && (r.kind !== '' ? accepts(accept, r.kind) : r.origin === 'step' && anyKind))
  const isMissing = !!value && !rows.some(r => r.name === value && !r.missing)
  const current = rows.find(r => r.name === value && !r.missing)
  const stepN = nameOf(rows, list)
  const pickRow = (r: StoreRow): void => { onChange(r.name); setOpen(false); button.current?.focus() }
  const listUi = (
    <>
      {choices.length === 0 ? <p className="am-help am-pickernone">{t('store.pick.none')}</p> : (
        <ul className="am-pickerlist" role="listbox" aria-label={t('store.pick.label')}>
          {choices.map(r => (
            <li key={`${r.origin}-${r.name}`} role="option" aria-selected={r.name === value}>
              <button type="button" data-autofocus={r.name === value ? true : undefined} onClick={() => pickRow(r)}>
                <Thumb row={r} size={40} />
                <span className="am-pickertext"><span className="am-mono am-storedname">{r.name}</span><span className="am-help">{sizeLine(t, r)}{r.origin === 'step' ? `${r.size ? ' · ' : ''}${t('store.origin.step', { n: stepN(r.step ?? '') })}` : ''}</span></span>
                {r.name === value ? <Icon name="check" size={16} /> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      {wantsDrawing ? <div className="am-pickerfoot"><button type="button" className="am-link am-pickerimport" onClick={chooser.choose}><Icon name="upload" size={16} />{t('store.import')}</button></div> : null}
    </>
  )
  return (
    <div className="am-field" ref={box}>
      <span className="am-label">{label}</span>
      {chooser.field}
      <div className="am-pickerwrap">
        <button ref={button} type="button" className={`am-picker${!value ? ' am-picker-empty' : ''}${isMissing ? ' am-picker-missing' : ''}`} aria-haspopup={phone ? 'dialog' : 'listbox'} aria-expanded={open} onClick={() => (choices.length === 0 && wantsDrawing && !value ? chooser.choose() : setOpen(o => !o))}>
          {current ? <Thumb row={current} size={40} /> : isMissing ? <span className="am-thumb am-thumb-icon am-thumb-missing" style={{ width: 40, height: 40 }} aria-hidden="true"><Icon name="alert" size={18} /></span> : null}
          {value ? (
            <span className="am-pickertext"><span className="am-mono am-storedname">{value}{isMissing ? <span className="am-bad"> · {t('store.missing')}</span> : null}</span>{current ? <span className="am-help">{sizeLine(t, current)}</span> : null}</span>
          ) : <span>{anyKind ? tx(t, 'store.pick.emptyAny', 'Choose a stored item first') : tx(t, 'store.pick.empty', 'Choose a drawing first')}</span>}
          <Icon name="chevronDown" size={16} />
        </button>
        {open && !phone ? <div className="am-pickerpop">{listUi}</div> : null}
      </div>
      {open && phone ? <Dialog title={t('store.pick.label')} onClose={() => setOpen(false)} t={t}>{listUi}<div className="am-actions"><button type="button" onClick={() => setOpen(false)}>{t('store.cancel')}</button></div></Dialog> : null}
      {dialog ? <ImportSvgDialog t={t} host={host} {...dialog} onClose={() => setDialog(null)} onDone={name => onChange(name)} onChooseOther={chooser.choose} /> : null}
    </div>
  )
}

// ------------------------------------------------------------------------------------------------------ the customer's "Change drawing"
/**
 * The customer's field for a drawing the shop chose: the shop's drawing, and a way to bring their own SVG. Their file is checked against the shop's limits
 * (`host.customerLimits`) and kept in the project under a new name; the setting then names it. "Use the shop's drawing again" puts the shop's name back.
 */
export function ChangeDrawing({ t, label, value, shopValue, onChange }: { t: T; label: string; value: string; shopValue: string; onChange: (name: string) => void }): ReactElement {
  const view = useStoreView()
  const [error, setError] = useState<string | null>(null)
  const [mine, setMine] = useState<{ name: string; file: string; shapes: number } | null>(null)   // the customer's own drawing, while it is the one in use
  const chooser = useSvgChooser(f => {
    if (!view) return
    setError(null)
    if (!/\.svg$/i.test(f.name)) { setError(t('store.cust.err.wrongFile', { file: f.name })); return }
    let imp: SvgImport
    try { imp = importSvg(f.text) } catch (e) { setError(importProblem(t, { code: (e as { code?: string }).code ?? 'import.invalid_drawing', params: (e as { params?: Record<string, unknown> }).params ?? {} }, 'fill').text); return }
    if (imp.stats.paths > view.host.customerLimits.paths || imp.stats.points > view.host.customerLimits.points) {
      setError(t('store.cust.err.complex', { count: imp.stats.paths, max: view.host.customerLimits.paths })); return
    }
    const r = view.host.importSvg(f.name, f.text, 'fill')
    if (!r.ok) { setError(importProblem(t, r.error, 'fill').text); return }
    if (mine) view.host.remove(mine.name)   // the one before is no longer wanted
    setMine({ name: r.name, file: f.name, shapes: imp.stats.paths }); onChange(r.name)
  })
  if (!view) return <div className="am-field"><span className="am-label">{label}</span></div>
  const using = !!mine && value === mine.name
  const lim = view.host.customerLimits
  const row = view.rows.find(r => r.name === value && !r.missing)
  return (
    <div className="am-field am-changedrawing">
      <span className="am-label">{label}</span>
      {chooser.field}
      <div className="am-custcard">
        {row ? <Thumb row={row} size={52} /> : null}
        <div className="am-pickertext">
          <strong>{using ? t('store.cust.yours') : t('store.cust.shop')}</strong>
          {using && mine ? <span className="am-help">{mine.file} · {tx(t, mine.shapes === 1 ? 'store.cust.shapes_one' : 'store.cust.shapes_other', '{{count}} shapes', { count: mine.shapes })}</span> : null}
        </div>
      </div>
      <button type="button" className="am-primary am-block" onClick={chooser.choose}><Icon name="upload" size={16} />{t('store.cust.change')}</button>
      <p className="am-help">{t('store.cust.limits', { shapes: lim.paths, points: lim.points.toLocaleString('en-US').replace(/,/g, '\u202f') })}</p>
      {using ? <button type="button" className="am-link" onClick={() => { if (mine) view.host.remove(mine.name); setMine(null); setError(null); onChange(shopValue) }}>{t('store.cust.back')}</button> : null}
      {error ? <div className="am-problem am-error" role="alert"><p>{error}</p></div> : null}
    </div>
  )
}
