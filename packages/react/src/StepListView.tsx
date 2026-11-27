// The pipeline: "Your file", the numbered steps, "Result". Each step shows its status, its problems and soft tips about the order.
// A row is the step's icon, its name and a one-line summary, with a dot for its state; the notes (problems, tips) show in the settings pane.
// Reordering works by dragging a row and with Move up / Move down in the step menu (EditorPage), so a keyboard and a phone can do it too.
import { useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { STORE_PLUGIN_ID } from '@ateliermesh/core'
import type { Operation, PartIssue, Registry, Step, StepList, WorkflowResult } from '@ateliermesh/core'
import { describeProblem } from '@ateliermesh/ui'
import type { OrderHint } from '@ateliermesh/plugins'
import type { T } from './common'
import { problemText, tx } from './common'
import { Icon, iconKey } from './icons'
import { useStoreView } from './Store'

export const stepName = (t: T, registry: Registry, s: Step): string => {
  if (s.name && s.name.trim()) return s.name.trim()
  const key = `step.op.${s.op === 'emboss' ? 'text' : s.op === 'emboss_svg' ? 'svg' : s.op}`
  const v = t(key)
  return v !== key ? v : (registry.operation(s.plugin.id, s.op)?.op.title ?? s.op)
}

export interface Tip { key: string; text: string; fix?: { label: string; id: string; to: number } }
interface NotesContext { t: T; registry: Registry; list: StepList; hints: OrderHint[]; partIssues: PartIssue[] }

/** The soft tips about the order of steps and the part warnings of one step, as plain data. */
export function stepTips(c: NotesContext, s: Step): Tip[] {
  const { t, registry, list, hints, partIssues } = c
  const nameOf = (id: string): string => { const x = list.steps.find(y => y.id === id); return x ? stepName(t, registry, x) : id }
  const tips = (s: Step): Tip[] => {
    const out: Tip[] = []
    const tip = (key: string, text: string, fix?: { label: string; id: string; to: number }): void => {
      out.push({ key, text, ...(fix ? { fix } : {}) })
    }
    for (const h of hints) {
      if (h.step === s.id) {
        if (h.code === 'analyze_last') tip(`h-${h.code}`, t(s.op === 'auto_orient' ? 'order.orientLast' : 'order.analyseLast', { step: nameOf(s.id) }), { label: t('order.moveToEnd'), ...h.fix })
        else if (h.code === 'decimate_after_text') tip(`h-${h.code}`, t('order.decimateAfterText'), { label: t('order.moveAboveText'), ...h.fix })
        else if (h.code === 'rotate_after_text') tip(`h-${h.code}`, t('order.rotateAfterText'), { label: t('order.moveAboveText'), ...h.fix })
        else if (h.code === 'deform_after_text') tip(`h-${h.code}`, tx(t, 'order.deformAfterText', 'This step bends the surface the text sits on, so the letters change shape with it. It works best above the text steps.'), { label: t('order.moveAboveText'), ...h.fix })
        else if (h.code === 'texture_before_text') tip(`h-${h.code}`, tx(t, 'order.textureBeforeText', 'A texture covers the surface the text sits on, so the letters would be roughened with it. It works best above the text steps.'), { label: t('order.moveAboveText'), ...h.fix })
        else if (h.code === 'smooth_after_text') tip(`h-${h.code}`, tx(t, 'order.smoothAfterText', 'Smoothing after the text or a pattern rounds their edges. It works best above them.'), { label: t('order.moveAboveText'), ...h.fix })
        else if (h.code === 'smooth_before_surface') tip(`h-${h.code}`, tx(t, 'order.smoothBeforeSurface', 'Smoothing evens out what the steps below it make (a shell, a texture, a twist). It works best below them.'), { label: tx(t, 'order.moveBelowShaping', 'Move below them'), ...h.fix })
        else if (h.code === 'holes_last') tip(`h-${h.code}`, tx(t, 'order.holesLast', 'The hole is cut through the surface the steps above it made. Text, a texture, a pattern, holes or a twist added after this step would run into the hole or distort it.'), { label: tx(t, 'order.moveBelowThese', 'Move below them'), ...h.fix })
        else if (h.code === 'holes_before_smooth') tip(`h-${h.code}`, tx(t, 'order.holesBeforeSmooth', 'A Smooth surface step above this one would not round the rim of the hole. Put this step above the smoothing.'), { label: tx(t, 'order.moveAboveSmooth', 'Move above the smoothing'), ...h.fix })
        else if (h.code === 'cheese_last') tip(`h-${h.code}`, tx(t, 'order.cheeseLast', 'The holes are cut into the surface the steps above it made. Text, a texture, a pattern or a twist added after this step would be cut by the holes or bend them. Move it below those steps.'), { label: tx(t, 'order.moveBelowThese', 'Move below them'), ...h.fix })
        else if (h.code === 'cheese_before_smooth') tip(`h-${h.code}`, tx(t, 'order.cheeseBeforeSmooth', 'A Smooth surface step above this one cannot round the rims of the holes. Put this step above it.'), { label: tx(t, 'order.moveAboveSmooth', 'Move above the smoothing'), ...h.fix })
        else if (h.code === 'hollow_last') tip(`h-${h.code}`, tx(t, 'order.hollowLast', 'Hollowing works on the outside the steps above it made. Text, a texture or a pattern added after it would touch the wall. It works best below them.'), { label: tx(t, 'order.moveBelowThese', 'Move below them'), ...h.fix })
        else if (h.code === 'hollow_before_shell') tip(`h-${h.code}`, tx(t, 'order.hollowBeforeShell', 'A Voronoi shell above this step is made from the whole solid, not from the hollow part. Put this step above it.'), { label: tx(t, 'order.moveAboveShell', 'Move above the shell'), ...h.fix })
        else if (h.code === 'reduce_after_texture') tip(`h-${h.code}`, tx(t, 'order.reduceAfterTexture', 'Reducing triangles after a texture smooths it away. It works best above the texture step.'), { label: tx(t, 'order.moveAboveTexture', 'Move above the texture'), ...h.fix })
        else if (h.code === 'reduce_before_deform') tip(`h-${h.code}`, tx(t, 'order.reduceBeforeDeform', 'Reducing triangles before a twist or taper gives the deform step a rougher surface to follow. It works best below it.'), { label: tx(t, 'order.moveBelowDeform', 'Move below the deform step'), ...h.fix })
        else if (h.code === 'parts_first') tip(`h-${h.code}`, tx(t, 'order.partsFirst', 'Deleting or keeping a part works best near the start, so the other steps only work on what stays.'), { label: tx(t, 'order.moveToStart', 'Move to the start'), ...h.fix })
        else if (h.code === 'repair_first') tip(`h-${h.code}`, tx(t, 'order.repairFirst', 'Repairing works best as the first step, so every other step starts from a sound model.'), { label: tx(t, 'order.moveToStart', 'Move to the start'), ...h.fix })
        else if (h.code === 'size_after_text') {
          const first = h.texts[0] as string, ts = list.steps.find(x => x.id === first)
          const orig = Number(ts?.params['size'] ?? 0), f = h.scale?.[first]?.factor ?? 1
          tip(`h-${h.code}`, t('order.scalesAbove', { count: h.texts.length, text: String(ts?.params['text'] ?? ''), size: Math.round(orig * f * 10) / 10, orig }), { label: t('order.keepExact'), ...h.fix })
        }
      }
      if (h.code === 'size_after_text' && h.texts.includes(s.id)) {
        const n = list.steps.findIndex(x => x.id === h.step) + 1
        const o = Number(s.params['size'] ?? 0), sc = h.scale?.[s.id] ?? { factor: 1, personalisable: false }
        const printed = Math.round(o * sc.factor * 10) / 10
        tip(`s-${h.step}`, t('order.scaledBelow', { n, size: printed }), { label: t('order.keepExact'), ...h.fix })
        if (sc.personalisable) tip(`c-${h.step}`, t('order.customerTyped', { orig: o, size: printed }))
      }
    }
    for (const q of partIssues) {
      if (q.stepId !== s.id) continue
      tip(`p-${q.param}-${q.code}`, tx(t, q.code === 'part.dropped' ? 'order.partDropped' : 'order.partMissing', q.code === 'part.dropped' ? 'The part “{{part}}” was made earlier but a step between removes it.' : 'No file or earlier step makes the part “{{part}}”.', { part: q.value }))
    }
    return out
  }

  return tips(s)
}

/** Fill `{{name}}` in a summary template from the step's values; null when a value is missing or not a number or text. */
function fillSummary(template: string, params: Record<string, unknown>): string | null {
  let ok = true
  const out = template.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_, n: string) => {
    const v = params[n]
    if (typeof v === 'number') return String(Math.round(v * 100) / 100)
    if (typeof v === 'string' && v !== '') return v.split('\n')[0] as string
    ok = false; return ''
  })
  return ok ? out.trim() : null
}

/** One line under a step's name: what it does, in the words of the design (`step.summary.*`). */
export function stepSummary(t: T, s: Step, op?: Operation): string {
  const p = s.params
  // the manifest's own template first (`summary: '{{angle}}°'`); the switch below is for operations that name none
  if (op?.summary) { const out = fillSummary(op.summary, p); if (out !== null) return out }
  switch (s.op) {
    case 'emboss': { const x = typeof p['text'] === 'string' ? String(p['text']).split('\n')[0] : ''; return x ? `“${x}”` : '' }
    case 'resize':
      if (p['mode'] === 'per_axis') return `${p['percent_x'] ?? 100} × ${p['percent_y'] ?? 100} × ${p['percent_z'] ?? 100} %`
      if (p['mode'] === 'target_size' && typeof p['target_mm'] === 'number') return `${String(p['target_axis'] ?? 'x').toUpperCase()} ${p['target_mm']} mm${p['keep_proportions'] === false ? ' ↔' : ''}`
      return typeof p['percent'] === 'number' && (p['mode'] === undefined || p['mode'] === 'percent') ? `${p['percent']} %` : typeof p['width'] === 'number' ? t('step.summary.resize', { w: p['width'] }) : ''
    case 'decimate': return p['mode'] === 'target' ? (typeof p['target_triangles'] === 'number' ? `${p['target_triangles']}` : '') : (typeof p['tolerance'] === 'number' ? `${p['tolerance']} mm` : '0.05 mm')
    case 'overhang': return typeof p['angle'] === 'number' ? `${p['angle']}°` : ''
    case 'auto_orient': return t('step.summary.orient')
    case 'twist': return typeof p['angle'] === 'number' ? `${p['angle']}\u00b0` : ''
    case 'smooth': return typeof p['iterations'] === 'number' ? `${p['iterations']}\u00d7` : ''
    case 'taper': return typeof p['scale_end'] === 'number' ? `${Math.round((p['scale_end'] as number) * 100)} %` : ''
    case 'low_poly': return p['triangles_mode'] !== 'auto' && typeof p['triangles'] === 'number' ? `${p['triangles']}` : ''
    default: return ''
  }
}

/**
 * The line under a step's name. A step that names a stored item shows the name in monospace (`logo_mf`), in red with "Missing" when nothing provides it; a Store step reads
 * "as tag_front"; everything else is the text of `stepSummary`.
 */
function StepSummaryLine({ t, s, op }: { t: T; s: Step; op: Operation | undefined }): ReactElement | null {
  const view = useStoreView()
  const mono = (name: string): ReactElement => <span className="am-mono">{name}</span>
  if (s.plugin.id === STORE_PLUGIN_ID && s.op === 'store' && typeof s.params['name'] === 'string' && s.params['name'] !== '') {
    const MARK = '\u0001', text = tx(t, 'store.storeSummary', 'as {{name}}', { name: MARK }).split(MARK)
    return <span className="am-t2">{text[0]}{mono(s.params['name'])}{text[1] ?? ''}</span>
  }
  const pp = op?.params.find(p => p.type === 'payload')
  const v = pp ? s.params[pp.name] : undefined
  if (pp && typeof v === 'string' && v !== '') {
    const missing = !!view && !view.rows.some(r => r.name === v && !r.missing)
    return missing
      ? <span className="am-t2 am-bad">{mono(v)} · {tx(t, 'store.missing', 'Missing')}</span>
      : <span className="am-t2">{mono(v)}</span>
  }
  const text = stepSummary(t, s, op)
  return text ? <span className="am-t2">{text}</span> : null
}

/** A small outline icon per step: the manifest's `icon` when the host's set has it, else one for the operation id, else a neutral box. */
export function StepIcon({ op, icon }: { op: string; icon?: string | undefined }): ReactElement {
  return <span className="am-stepicon" aria-hidden="true"><Icon name={iconKey(icon) ?? iconKey(op) ?? 'box'} size={16} /></span>
}

/** What the settings pane shows about the selected step: its problems and warnings with their way out, and the order tips. */
export function StepNotes(p: NotesContext & { shownWarning?: number | null; onShowWarning?: (index: number | null) => void; result: WorkflowResult | null; step: Step; onMove: (id: string, to: number) => void; onFix?: (stepId: string, set: Record<string, string | number>) => void; onManage?: () => void; onStore?: (action: 'choose' | 'import' | 'open_stored', stepId: string) => void; replacedBy?: (pluginId: string) => { name: string } | null }): ReactElement | null {
  const { t, list, result, step: s } = p
  const r = result?.results[list.steps.findIndex(x => x.id === s.id)]
  const tips = stepTips(p, s)
  // the report card of the print check says the same as its warnings: leave them out here
  const warnings = (r?.warnings ?? []).filter(w => !w.code.startsWith('printcheck.'))
  if (!r?.error && warnings.length === 0 && tips.length === 0) return null
  const fix = p.onFix ? (set: Record<string, string | number>): void => p.onFix?.(s.id, set) : undefined
  return (
    <div className="am-notes">
      {r?.error ? <ProblemLine t={t} code={r.error.code} params={r.error.params as Record<string, unknown> | undefined} onFix={fix} onManage={p.onManage} onStore={p.onStore ? a => p.onStore?.(a, s.id) : undefined} replacedBy={p.replacedBy} /> : null}
      {r?.error ? <p className="am-help">{t('order.blockedNote')}</p> : null}
      {warnings.map((w, k) => <ProblemLine key={`${w.code}${k}`} channel="warning" t={t} code={w.code} params={w.params as Record<string, unknown> | undefined} onFix={fix} {...(w.where && p.onShowWarning ? { showing: p.shownWarning === k, onShow: () => p.onShowWarning?.(p.shownWarning === k ? null : k) } : {})} />)}
      {tips.map(x => (
        <div className="am-tip" key={x.key} role="note">
          <span className="am-tipbadge" title={t('order.hintBadge')} aria-label={t('order.hintBadge')}>ⓘ</span> {x.text}
          {x.fix ? <div className="am-tipacts"><button type="button" onClick={() => p.onMove(x.fix!.id, x.fix!.to)}>{x.fix.label}</button></div> : null}
        </div>
      ))}
    </div>
  )
}

export interface StepListViewProps {
  t: T
  registry: Registry
  list: StepList
  result: WorkflowResult | null
  selected: string | null
  onSelect: (id: string) => void
  /** Move a step to a new place (drag, or the step menu). */
  onMove: (id: string, to: number) => void
  hints: OrderHint[]
  partIssues: PartIssue[]
  /** The pipeline's first and last lines. */
  file?: { name: string; width?: number } | null
  /** Show the Personalisable badge on steps that hand something over. */
  showBadges: boolean
  /** The step the view stops at ("Up to this step"), or null for the whole list. */
  upTo: string | null
  onUpTo: (id: string | null) => void
  /** The step the engine is working on right now, from its progress events: its dot pulses. */
  runningId?: string | null
  /** The problem blocks reuse the host's fix buttons. */
  onFix?: (stepId: string, set: Record<string, string | number>) => void
  children?: ReactNode
}

export function StepListView(p: StepListViewProps): ReactElement {
  const { t, registry, list, result, selected, hints, partIssues } = p
  const [dragId, setDragId] = useState<string | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const move = p.onMove
  const notes = { t, registry, list, hints, partIssues }
  const upToIndex = p.upTo ? list.steps.findIndex(s => s.id === p.upTo) : -1

  return (
    <nav className="am-pipeline" aria-label={t('editor.steps')}>
      <p className="am-help">{t('order.hint')}</p>
      <ol className="am-steplist am-flow">
        {p.file ? <li className="am-end"><span className="am-sn" aria-hidden="true">⇡</span><div><strong>{t('order.file')}</strong><span className="am-sub">{p.file.width !== undefined ? t('order.fileMeta', { name: p.file.name, w: Math.round(p.file.width * 10) / 10 }) : p.file.name}</span></div></li> : null}
        {list.steps.map((s, i) => {
          const r = result?.results[i]
          const earlierError = result?.results.slice(0, i).some(x => x.status === 'error') ?? false
          const raw = !s.enabled ? 'off' : p.runningId === s.id ? 'working' : p.upTo && i > upToIndex ? 'stale' : earlierError && r?.status !== 'ok' ? 'blocked' : r?.status === 'running' ? 'working' : r?.status === 'ok' ? 'ok' : r?.status === 'error' ? 'error' : r?.status === 'cancelled' ? 'cancelled' : 'stale'
          const label = raw === 'ok' && (r?.warnings?.length ?? 0) > 0 ? 'warning' : raw
          const isSel = s.id === selected
          const cls = ['am-step', isSel ? 'am-sel' : '', s.enabled ? '' : 'am-off', dragId === s.id ? 'am-dragging' : '', over === i && dragId && dragId !== s.id ? 'am-dropat' : ''].filter(Boolean).join(' ')
          return (
            <li key={s.id} className={cls} draggable onDragStart={e => { setDragId(s.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', s.id) }} onDragEnd={() => { setDragId(null); setOver(null) }}
              onDragOver={e => { if (dragId) { e.preventDefault(); setOver(i) } }} onDrop={e => { e.preventDefault(); if (dragId) move(dragId, i); setDragId(null); setOver(null) }}>
              <div className="am-steprow">
                <span className="am-draghandle" aria-hidden="true" title={t('order.drag')}>⋮⋮</span>
                <span className="am-sn" aria-hidden="true">{i + 1}</span>
                <button type="button" className="am-stepname" aria-current={isSel} onClick={() => p.onSelect(s.id)}>
                  <span className="am-t1"><StepIcon op={s.op} icon={registry.operation(s.plugin.id, s.op)?.op.icon} />{stepName(t, registry, s)}{p.showBadges && s.personalisable_params.length > 0 ? <span className="am-badge">{t('host.badge')}</span> : null}</span>
                  <StepSummaryLine t={t} s={s} op={registry.operation(s.plugin.id, s.op)?.op} />
                </button>
                {stepTips(notes, s).length > 0 || (r?.warnings?.length ?? 0) > 0 ? <span className="am-hasnote" title={t('order.hintBadge')} aria-label={t('order.hintBadge')}>ⓘ</span> : null}
                <span className={`am-dot am-st-${label}`} title={t(`step.status.${label}`)}><span className="am-sr">{t(`step.status.${label}`)}</span></span>
              </div>
            </li>
          )
        })}
        <li className="am-end"><span className="am-sn" aria-hidden="true">✓</span><div><strong>{t('order.result')}</strong>{p.upTo ? <span className="am-sub">{t('view.upToNote', { n: upToIndex + 1, total: list.steps.length })}</span> : null}</div></li>
      </ol>
      {p.children}
    </nav>
  )
}

export function ProblemLine({ t, code, params, onFix, onManage, onStore, replacedBy, channel, onShow, showing }: { onShow?: () => void; showing?: boolean; t: T; channel?: 'warning' | 'error'; code: string; params: Record<string, unknown> | undefined; onFix: ((set: Record<string, string | number>) => void) | undefined; onManage?: (() => void) | undefined; /** The store's way out: choose a drawing, import an SVG, open the Stored tab. */ onStore?: ((action: 'choose' | 'import' | 'open_stored') => void) | undefined; /** The plugin of the catalog that replaces a missing one, by name, when there is one. */ replacedBy?: ((pluginId: string) => { name: string } | null) | undefined }): ReactElement {
  const v = describeProblem(code, params ?? {}, channel ? { channel } : {})
  const group = /^mesh\.([a-z]+)\./.exec(v.key)?.[1]
  const key = t(v.key) !== v.key ? v.key : group && t(`mesh.${group}._any`) !== `mesh.${group}._any` ? `mesh.${group}._any` : 'mesh.unknown'
  return (
    <div className={`am-problem am-${v.kind}`} role={v.kind === 'error' ? 'alert' : 'status'}>
      <p>{problemText(t, key, { ...v.values, code })}</p>
      {onShow ? <div className="am-row"><button type="button" aria-pressed={!!showing} onClick={onShow}>{showing ? tx(t, 'warning.hide', 'Hide on the model') : tx(t, 'warning.show', 'Show on the model')}</button></div> : null}
      {v.blocks && !['run.cancelled', 'run.timeout'].includes(code) ? <p className="am-quiet">{t('work.lastGood')}</p> : null}
      {code === 'step.unknown_plugin' && typeof params?.['plugin'] === 'string' && replacedBy?.(params['plugin'])
        ? <p className="am-help" data-testid="replaced-by">{tx(t, 'plugins.replacedBy', '“{{name}}” in the catalog replaces it.', { name: replacedBy(params['plugin'])?.name ?? '' })}</p> : null}
      {onManage && v.actions.some(a => a.command === 'manage_plugins') && code === 'step.unknown_plugin' ? <div className="am-row"><button type="button" onClick={onManage}>{t('fix.openPluginManager') !== 'fix.openPluginManager' ? t('fix.openPluginManager') : 'Open plugin manager'}</button></div> : null}
      {onStore && v.actions.some(a => a.command === 'choose_drawing' || a.command === 'import_svg' || a.command === 'open_stored') ? (
        <div className="am-row">{v.actions.filter(a => a.command === 'choose_drawing' || a.command === 'import_svg' || a.command === 'open_stored').map(a => <button key={a.key} type="button" onClick={() => onStore(a.command === 'choose_drawing' ? 'choose' : a.command === 'import_svg' ? 'import' : 'open_stored')}>{t(a.key, a.values)}</button>)}</div>
      ) : null}
      {onFix ? <div className="am-row">{v.actions.filter(a => a.set).map(a => <button key={a.key} type="button" onClick={() => onFix(a.set as Record<string, string | number>)}>{t(a.key, a.values)}</button>)}</div> : null}
    </div>
  )
}
