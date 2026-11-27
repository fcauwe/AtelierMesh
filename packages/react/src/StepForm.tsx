// The settings of a step in the design's form: grouped like the manifest says (the first group open, the others collapsed), the real controls
// (font cards, a size slider, Raised / Engraved, direction and move), and the "personalisable" tick on the label row of each field it applies to.
// It is the one renderer for every operation: the manifest says what each field is (type, limits, unit, `widget`, `importance`, `icon`, `help`), the form
// draws it. Only an operation with a parameter type this form cannot draw (a painted `selection`) falls back to the generated panel: see `formSupported`.
import { useState } from 'react'
import type { ReactElement } from 'react'
import { ORIGINAL_NAME, STORE_PLUGIN_ID, canPersonalise, evalExpr, isPlacement, optionKey, paramKey, sectionKey, setParams, setPersonalisableLimits, setPersonalisableParams } from '@ateliermesh/core'
import type { Operation, ParamDef, PlacementValue, Step, StepList } from '@ateliermesh/core'
import type { T } from './common'
import { tx } from './common'
import { Icon } from './icons'
import { Field } from './PersonaliseOverlay'
import { useStoreView } from './Store'
import type { FontChoice } from './PersonaliseOverlay'

const SUPPORTED = new Set(['string', 'float', 'int', 'angle', 'vector', 'enum', 'bool', 'asset', 'payload', 'placement', 'part', 'color', 'range', 'object', 'list'])
/** Whether every parameter of the operation can be drawn by the form. */
export const formSupported = (op: Operation): boolean => op.params.every(p => SUPPORTED.has(p.type))

const humanize = (n: string): string => { const s = n.replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1) }

export interface StepFormProps {
  t: T
  step: Step
  op: Operation
  list: StepList
  /** Show the personalisable ticks (the "Personalised design" switch is on). */
  ticks: boolean
  fonts?: FontChoice[]
  onParams: (params: Record<string, unknown>) => void
  onList: (list: StepList) => void
  segments?: () => string[]
  groups?: () => string[]
  onAsset?: (param: string, def: ParamDef) => void
  onPlacementRequest?: (param: string) => void
}

export function StepForm(p: StepFormProps): ReactElement {
  const { t, step, op, list, ticks } = p
  const storeView = useStoreView()
  // a `store` step may not take the name of an imported item (the engine stops with `store.name_taken`): said on the field too
  const isStoreName = step.plugin.id === STORE_PLUGIN_ID && step.op === 'store'
  const above = list.steps.findIndex(x => x.id === step.id)   // the steps above this one: what a Store step keeps
  const nameClash = step.plugin.id === STORE_PLUGIN_ID && step.op === 'store' && !!storeView && typeof step.params['name'] === 'string' && (!!storeView.host.store[step.params['name']] || step.params['name'] === ORIGINAL_NAME)
  const values = step.params
  const set = (name: string, v: unknown): void => p.onParams({ ...step.params, [name]: v })
  const label = (q: ParamDef): string => { const fk = `field.${q.name}`; const f = t(fk); return tx(t, paramKey(op.id, q.name, 'label'), f !== fk ? f : (q.label ?? humanize(q.name))) }
  // an option's words: the host's translation, else the design's `text.*`, else the label the manifest gives, else the value itself
  const option = (q: ParamDef) => (v: string): string => {
    const k = optionKey(op.id, q.name, v); const x = t(k)
    if (x !== k) return x
    if (t(`text.${v}`) !== `text.${v}`) return t(`text.${v}`)
    const o = q.type === 'enum' ? q.options.find(y => (typeof y === 'string' ? y : y.value) === v) : undefined
    return o && typeof o !== 'string' && o.label ? o.label : v
  }

  const toggle = (entry: string, on: boolean): void => {
    const cur = new Set(step.personalisable_params)
    if (on) { cur.add(entry); if (entry.includes('.')) cur.delete(entry.split('.')[0] as string) } else cur.delete(entry)
    const pl = op.params.find(q => q.type === 'placement')?.name
    if (pl && cur.has(`${pl}.position`) && cur.has(`${pl}.direction`)) { cur.delete(`${pl}.position`); cur.delete(`${pl}.direction`); cur.add(pl) }
    p.onList(setPersonalisableParams(list, step.id, [...cur]))
  }
  const Tick = ({ entry, text, on }: { entry: string; text: string; on: boolean }): ReactElement => (
    <label className="am-tick"><Icon name="user" size={14} /><span>{t('personalise.tick')}</span>
      <input type="checkbox" aria-label={t('personalise.tickField', { field: text })} checked={on} onChange={e => toggle(entry, e.target.checked)} /></label>
  )

  const pname = op.params.find(q => q.type === 'placement')?.name
  const place = pname ? step.params[pname] : null
  const sizeParam = isPlacement(place) ? (place.limits?.size_param ?? 'size') : 'size'

  const render = (q: ParamDef): ReactElement | null => {
    if (q.visible_if && !evalExpr(q.visible_if, values as Record<string, never>)) return null
    const text = label(q)
    const ticked = ticks && !!q.personalisable
    if (q.type === 'placement') return <PlacementForm key={q.name} {...p} param={q} ticked={ticked} Tick={Tick} />
    if (q.type === 'part') {
      const id = `${step.id}-${q.name}`
      const seg = q.kinds?.includes('group') && !q.kinds.includes('segment') ? [] : (p.segments?.() ?? [])
      const grp = q.kinds?.includes('segment') && !q.kinds.includes('group') ? [] : (p.groups?.() ?? [])
      const cur = String(values[q.name] ?? '')
      const names = [...new Set([...seg, ...grp])]
      return (
        <div className="am-field" key={q.name}>
          <label htmlFor={id}>{text}</label>
          <select id={id} value={cur} onChange={e => set(q.name, e.target.value)}>
            {q.allow_empty !== false ? <option value="">{tx(t, 'panel.whole_mesh', 'Whole mesh')}</option> : null}
            {names.map(n => <option key={n} value={n}>{n}</option>)}
            {cur && !names.includes(cur) && cur !== '' ? <option value={cur}>{cur}</option> : null}
          </select>
        </div>
      )
    }
    const on = step.personalisable_params.includes(q.name)
    const lim = step.personalisable_limits?.[q.name] ?? {}
    const setLim = (patch: { max_lines?: number | undefined; max_line_length?: number | undefined }): void => {
      const m = { ...lim, ...patch }
      p.onList(setPersonalisableLimits(list, step.id, q.name, { ...(m.max_lines ? { max_lines: m.max_lines } : {}), ...(m.max_line_length ? { max_line_length: m.max_line_length } : {}) }))
    }
    return (
      <div className="am-fieldwrap" key={q.name}>
        {ticked ? <Tick entry={q.name} text={text} on={on} /> : null}
        <Field step={step} param={q} fonts={p.fonts ?? []} t={t} sizeLimit={undefined} labelText={text} optionText={option(q)} onChange={v => set(q.name, v)} onAsset={() => p.onAsset?.(q.name, q)} {...(p.onPlacementRequest ? { onPlace: (path: string) => p.onPlacementRequest?.(q.type === 'list' ? path : q.name) } : {})} />
        {q.help ? <p className="am-help">{isStoreName && above > 0 && q.name === 'name' ? tx(t, 'store.storeHint', 'Keeps the result of steps {{from}}–{{to}} under this name. Later steps can load it.', { from: 1, to: above }) : tx(t, paramKey(op.id, q.name, 'help'), q.help)}</p> : null}
        {nameClash && q.name === 'name' ? <p className="am-error-text" role="alert">{tx(t, 'store.problem.nameImported', '“{{name}}” is already the name of an imported item. Choose another name.', { name: String(values['name']) })}</p> : null}
        {ticked && on && q.type === 'string' && q.multiline ? (
          <div className="am-limits">
            <div className="am-row"><label htmlFor={`${step.id}-lim-lines`}>{t('limits.lines')}</label><input id={`${step.id}-lim-lines`} type="number" value={lim.max_lines ?? ''} onChange={e => setLim({ max_lines: e.target.value === '' ? undefined : Math.max(1, Math.floor(Number(e.target.value))) })} /></div>
            <div className="am-row"><label htmlFor={`${step.id}-lim-chars`}>{t('limits.chars')}</label><input id={`${step.id}-lim-chars`} type="number" value={lim.max_line_length ?? ''} onChange={e => setLim({ max_line_length: e.target.value === '' ? undefined : Math.max(1, Math.floor(Number(e.target.value))) })} /></div>
            <p className="am-help">{t('limits.textHint')}</p>
          </div>
        ) : null}
      </div>
    )
  }

  // the groups: as the manifest's `sections` say; fields with `importance: 'main'` come first in a group of their own and `advanced` ones last in "More"
  type Group = { id: string; title: string; open: boolean; members: ParamDef[] }
  const declared = (op.sections ?? []) as Array<{ id: string; title?: string; collapsed?: boolean }>
  const known = new Set(declared.map(g => g.id))
  const byImportance = op.params.some(q => q.importance !== undefined)
  const rest = byImportance ? op.params.filter(q => q.importance !== 'main' && q.importance !== 'advanced') : op.params
  const inSection = (q: ParamDef): boolean => !!q.section && known.has(q.section)
  const groups: Group[] = []
  if (byImportance) groups.push({ id: '_main', title: tx(t, 'form.main', 'Main'), open: true, members: op.params.filter(q => q.importance === 'main') })
  // fields that name no section (or one the operation does not declare) form a group of their own at the top
  groups.push({ id: '_', title: tx(t, 'form.settings', 'Settings'), open: true, members: rest.filter(q => !inSection(q)) })
  declared.forEach(g => groups.push({
    id: g.id, title: tx(t, sectionKey(op.id, g.id), g.title ?? humanize(g.id)), open: g.collapsed === false,
    members: rest.filter(q => q.section === g.id),
  }))
  if (byImportance) groups.push({ id: '_more', title: tx(t, 'form.more', 'More'), open: false, members: op.params.filter(q => q.importance === 'advanced') })
  const drawn = groups.map(g => ({ g, rendered: g.members.map(render).filter(Boolean) })).filter(x => x.rendered.length > 0)
  // only the first group is open unless the manifest opens another one on purpose (`collapsed: false`)
  return (
    <div className="am-stepform">
      {drawn.map(({ g, rendered }, i) => (
        <details key={g.id} className="am-group" open={i === 0 || g.open}>
          <summary>{g.title}</summary>
          {rendered}
        </details>
      ))}
      {ticks && pname && isPlacement(place) && (step.personalisable_params.some(x => x === pname || x.startsWith(`${pname}.`)) || step.personalisable_params.includes(sizeParam)) ? <LimitsBlock {...p} pname={pname} place={place} sizeParam={sizeParam} /> : null}
    </div>
  )
}

function PlacementForm(p: StepFormProps & { param: ParamDef; ticked: boolean; Tick: (x: { entry: string; text: string; on: boolean }) => ReactElement }): ReactElement | null {
  const { t, step, param, Tick, ticked } = p
  const cur = step.params[param.name]
  const apply = (next: PlacementValue): void => p.onParams({ ...step.params, [param.name]: next })
  const placed = isPlacement(cur)
  const off = (placed ? cur.offset : undefined) ?? [0, 0]
  const dir = (placed ? cur.direction : undefined) ?? 0
  const turn = (d: number): void => { if (!placed) return; let v = d; if (v > 180) v -= 360; if (v < -180) v += 360; apply({ ...cur, direction: v }) }
  const nudge = (dx: number, dy: number): void => { if (placed) apply({ ...cur, offset: [off[0] + dx, off[1] + dy] }) }
  const lab = tx(t, `field.${param.name}`, 'Placement')
  return (
    <div className="am-field am-place" key={param.name}>
      <div className="am-row">
        <button type="button" onClick={() => p.onPlacementRequest?.(param.name)}><Icon name="user" size={16} />{tx(t, 'panel.place', 'Place on the model')}</button>
        <span className="am-help">{placed ? tx(t, 'panel.placed', 'Placed') : tx(t, 'panel.not_placed', 'Not placed')}</span>
      </div>
      {placed ? (
        <>
          <div className="am-fieldwrap" role="group" aria-label={t('pos.direction')}>
            {ticked ? <Tick entry={`${param.name}.direction`} text={`${lab} · ${t('field.direction')}`} on={canPersonalise(step, param.name, 'direction')} /> : null}
            <span className="am-label">{t('pos.direction')}</span>
            <div className="am-seg">
              {[-90, 0, 90].map(d => <button key={d} type="button" aria-pressed={dir === d} onClick={() => turn(d)}>{d > 0 ? `+${d}°` : `${d}°`}</button>)}
              <input type="number" aria-label={t('pos.angle')} value={dir} min={-180} max={180} onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n)) turn(Math.max(-180, Math.min(180, n))) }} />
            </div>
          </div>
          <div className="am-fieldwrap" role="group" aria-label={t('pos.move')}>
            {ticked ? <Tick entry={`${param.name}.position`} text={`${lab} · ${t('field.position')}`} on={canPersonalise(step, param.name, 'position')} /> : null}
            <span className="am-label">{t('pos.move')}</span>
            <div className="am-nudge">
              <button type="button" aria-label={t('pos.left')} onClick={() => nudge(-1, 0)}>←</button>
              <button type="button" aria-label={t('pos.up')} onClick={() => nudge(0, 1)}>↑</button>
              <button type="button" aria-label={t('pos.down')} onClick={() => nudge(0, -1)}>↓</button>
              <button type="button" aria-label={t('pos.right')} onClick={() => nudge(1, 0)}>→</button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

function LimitsBlock({ t, step, list, onList, pname, place, sizeParam }: StepFormProps & { pname: string; place: PlacementValue; sizeParam: string }): ReactElement {
  const lim = place.limits ?? {}
  const [open] = useState(true)
  void open
  const setLimit = (patch: Partial<NonNullable<PlacementValue['limits']>>): void => {
    const merged = { ...lim, ...patch } as Record<string, unknown>
    for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k]
    const { limits: _l, ...rest } = place; void _l
    onList(setParams(list, step.id, { ...step.params, [pname]: Object.keys(merged).length > 0 ? { ...rest, limits: merged } : rest }))
  }
  const num = (id: string, text: string, value: number | undefined, setV: (v: number | undefined) => void): ReactElement => (
    <div className="am-row" key={id}>
      <label htmlFor={`${step.id}-${id}`}>{text}</label>
      <input id={`${step.id}-${id}`} type="number" value={value === undefined ? '' : value} onChange={e => setV(e.target.value === '' ? undefined : Number(e.target.value))} />
    </div>
  )
  return (
    <div className="am-limits">
      <strong>{t('limits.title')}</strong>
      {canPersonalise(step, pname, 'position') ? num('lim-dist', t('limits.move'), lim.max_distance, v => setLimit({ max_distance: v })) : null}
      {canPersonalise(step, pname, 'direction') ? <>
        {num('lim-dmin', `${t('limits.direction')} ${t('limits.from')}`, lim.direction?.[0], v => setLimit({ direction: v === undefined && lim.direction?.[1] === undefined ? undefined : [v ?? -180, lim.direction?.[1] ?? 180] }))}
        {num('lim-dmax', `${t('limits.direction')} ${t('limits.to')}`, lim.direction?.[1], v => setLimit({ direction: v === undefined && lim.direction?.[0] === undefined ? undefined : [lim.direction?.[0] ?? -180, v ?? 180] }))}
      </> : null}
      {step.personalisable_params.includes(sizeParam) ? <>
        {num('lim-smin', `${t('limits.size')} ${t('limits.from')}`, lim.size?.[0], v => setLimit({ size: v === undefined && lim.size?.[1] === undefined ? undefined : [v ?? 0, lim.size?.[1] ?? 1000] }))}
        {num('lim-smax', `${t('limits.size')} ${t('limits.to')}`, lim.size?.[1], v => setLimit({ size: v === undefined && lim.size?.[0] === undefined ? undefined : [lim.size?.[0] ?? 0, v ?? 1000] }))}
      </> : null}
      <p className="am-help">{t('limits.hint')}</p>
    </div>
  )
}
