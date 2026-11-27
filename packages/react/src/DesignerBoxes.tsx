// The designer's boxes under the settings of the selected step: direction and position of a placed text, and what is personalisable within which limits.
import type { ReactElement } from 'react'
import { canPersonalise, hasPersonalisable, isPlacement, setParams, setPersonalisableLimits, setPersonalisableParams } from '@ateliermesh/core'
import type { Operation, PlacementValue, Step, StepList } from '@ateliermesh/core'
import type { T } from './common'
import { tx } from './common'

/** Direction and position of a placed text: turn it, nudge it by 1 mm. */
export function PlacementBox({ t, step, op, onParams }: { t: T; step: Step; op: Operation; onParams: (params: Record<string, unknown>) => void }): ReactElement | null {
  const name = op.params.find(p => p.type === 'placement')?.name
  const cur = name ? step.params[name] : null
  if (!name || !isPlacement(cur)) return null
  const apply = (next: PlacementValue): void => onParams({ ...step.params, [name]: next })
  const off = cur.offset ?? [0, 0]
  const turn = (d: number): void => { let v = d; if (v > 180) v -= 360; if (v < -180) v += 360; apply({ ...cur, direction: v }) }
  return (
    <section className="am-designerbox" aria-label={t('pos.direction')}>
      <h3>{t('pos.direction')}</h3>
      <div className="am-row">
        <label htmlFor={`${step.id}-dir`}>{t('pos.angle')}</label>
        <input id={`${step.id}-dir`} type="number" min={-180} max={180} value={cur.direction ?? 0} onChange={e => turn(Math.max(-180, Math.min(180, Number(e.target.value) || 0)))} />
        <button type="button" aria-label="−90°" onClick={() => turn((cur.direction ?? 0) - 90)}>−90</button>
        <button type="button" aria-label="0°" onClick={() => turn(0)}>0</button>
        <button type="button" aria-label="+90°" onClick={() => turn((cur.direction ?? 0) + 90)}>+90</button>
      </div>
      <h3>{t('pos.move')}</h3>
      <div className="am-row">
        <button type="button" aria-label={t('pos.left')} onClick={() => apply({ ...cur, offset: [off[0] - 1, off[1]] })}>←</button>
        <button type="button" aria-label={t('pos.up')} onClick={() => apply({ ...cur, offset: [off[0], off[1] + 1] })}>↑</button>
        <button type="button" aria-label={t('pos.down')} onClick={() => apply({ ...cur, offset: [off[0], off[1] - 1] })}>↓</button>
        <button type="button" aria-label={t('pos.right')} onClick={() => apply({ ...cur, offset: [off[0] + 1, off[1]] })}>→</button>
      </div>
    </section>
  )
}

/** "Personalisable": one tick per field, position and direction apart, with the limits that belong to each. */
export function PersonaliseBox({ t, step, op, list, onList }: { t: T; step: Step; op: Operation; list: StepList; onList: (l: StepList) => void }): ReactElement | null {
  const fields = op.params.filter(p => p.personalisable)
  if (fields.length === 0) return null
  const toggle = (entry: string, on: boolean): void => {
    const set = new Set(step.personalisable_params)
    if (on) { set.add(entry); if (entry.includes('.')) set.delete(entry.split('.')[0] as string) } else set.delete(entry)
    const pl = op.params.find(q => q.type === 'placement')?.name
    if (pl && set.has(`${pl}.position`) && set.has(`${pl}.direction`)) { set.delete(`${pl}.position`); set.delete(`${pl}.direction`); set.add(pl) }
    onList(setPersonalisableParams(list, step.id, [...set]))
  }
  const label = (name: string): string => { const k = `field.${name}`; const v = t(k); return v !== k ? v : name.replace(/_/g, ' ') }
  const pname = op.params.find(p => p.type === 'placement')?.name
  const place = pname ? step.params[pname] : null
  const sizeParam = isPlacement(place) ? (place.limits?.size_param ?? 'size') : 'size'
  const setLimit = (patch: Partial<NonNullable<PlacementValue['limits']>>): void => {
    if (!pname || !isPlacement(place)) return
    const merged = { ...(place.limits ?? {}), ...patch } as Record<string, unknown>
    for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k]
    const { limits: _l, ...rest } = place; void _l
    onList(setParams(list, step.id, { ...step.params, [pname]: Object.keys(merged).length > 0 ? { ...rest, limits: merged } : rest }))
  }
  const num = (id: string, text: string, value: number | undefined, set: (v: number | undefined) => void): ReactElement => (
    <div className="am-row" key={id}>
      <label htmlFor={`${step.id}-${id}`}>{text}</label>
      <input id={`${step.id}-${id}`} type="number" value={value === undefined ? '' : value} onChange={e => set(e.target.value === '' ? undefined : Number(e.target.value))} />
    </div>
  )
  const tick = (entry: string, text: string, on: boolean): ReactElement => (
    <label className="am-row" key={entry}><input type="checkbox" checked={on} onChange={e => toggle(entry, e.target.checked)} /> {t('personalise.tickField', { field: text })}</label>
  )
  const lim = isPlacement(place) ? (place.limits ?? {}) : {}
  return (
    <section className="am-designerbox" aria-label={t('personalise.tick')}>
      <h3>{t('personalise.tick')}</h3>
      <p className="am-help">{t('personalise.hint')}</p>
      {fields.map(p => {
        const text = label(p.name)
        if (p.type === 'placement') return <div key={p.name}>{tick(`${p.name}.position`, `${text} · ${t('field.position')}`, canPersonalise(step, p.name, 'position'))}{tick(`${p.name}.direction`, `${text} · ${t('field.direction')}`, canPersonalise(step, p.name, 'direction'))}</div>
        const on = step.personalisable_params.includes(p.name)
        const tl = step.personalisable_limits?.[p.name] ?? {}
        const setText = (patch: { max_lines?: number | undefined; max_line_length?: number | undefined }): void => {
          const m = { ...tl, ...patch }
          onList(setPersonalisableLimits(list, step.id, p.name, { ...(m.max_lines ? { max_lines: m.max_lines } : {}), ...(m.max_line_length ? { max_line_length: m.max_line_length } : {}) }))
        }
        return (
          <div key={p.name}>
            {tick(p.name, text, on)}
            {p.type === 'string' && p.multiline && on ? <div className="am-limits">
              {num('lim-lines', t('limits.lines'), tl.max_lines, v => setText({ max_lines: v === undefined ? undefined : Math.max(1, Math.floor(v)) }))}
              {num('lim-chars', t('limits.chars'), tl.max_line_length, v => setText({ max_line_length: v === undefined ? undefined : Math.max(1, Math.floor(v)) }))}
              <p className="am-help">{t('limits.textHint')}</p>
            </div> : null}
          </div>
        )
      })}
      {pname && isPlacement(place) && (hasPersonalisable(step, pname) || step.personalisable_params.includes(sizeParam)) ? (
        <div className="am-limits">
          <h3>{t('limits.title')}</h3>
          <p className="am-help">{t('limits.hint')}</p>
          {canPersonalise(step, pname, 'position') ? num('lim-dist', t('limits.move'), lim.max_distance, v => setLimit({ max_distance: v })) : null}
          {canPersonalise(step, pname, 'direction') ? <>
            {num('lim-dmin', `${t('limits.direction')} ${t('limits.from')}`, lim.direction?.[0], v => setLimit({ direction: v === undefined && lim.direction?.[1] === undefined ? undefined : [v ?? -180, lim.direction?.[1] ?? 180] }))}
            {num('lim-dmax', `${t('limits.direction')} ${t('limits.to')}`, lim.direction?.[1], v => setLimit({ direction: v === undefined && lim.direction?.[0] === undefined ? undefined : [lim.direction?.[0] ?? -180, v ?? 180] }))}
          </> : null}
          {step.personalisable_params.includes(sizeParam) ? <>
            {num('lim-smin', `${t('limits.size')} ${t('limits.from')}`, lim.size?.[0], v => setLimit({ size: v === undefined && lim.size?.[1] === undefined ? undefined : [v ?? 0, lim.size?.[1] ?? 1000] }))}
            {num('lim-smax', `${t('limits.size')} ${t('limits.to')}`, lim.size?.[1], v => setLimit({ size: v === undefined && lim.size?.[0] === undefined ? undefined : [lim.size?.[0] ?? 0, v ?? 1000] }))}
          </> : null}
        </div>
      ) : null}
    </section>
  )
}

void tx
