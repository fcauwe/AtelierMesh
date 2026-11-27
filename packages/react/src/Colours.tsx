// The Colours panel: which part of the model is printed in which filament. A design is one colour until the designer switches several colours on; then it has slots (a few, up to
// the host's limit), each with the parts that go in it. Parts no slot has are shown with their own colours in the editor and join the first slot everywhere else
// (colours.ts, docs/proposals/colour-slots-plan.md). The screen only edits the `ColourMap`; the host keeps it (`useProjectSession().setColours`).
import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { DEFAULT_COLOUR_MAP, DEFAULT_MAX_COLOURS, colourMapProblems, colourParts, resolveColours } from '@ateliermesh/core'
import type { ColourMap, ColourSlot, Mesh } from '@ateliermesh/core'
import { Dialog, tx } from './common'
import type { T } from './common'
import { Icon } from './icons'

/** The colours the editor draws slots in when "Show mapped colours" is on (the real filaments are the host's: previews and files use those). */
export const SLOT_PREVIEW_COLOURS = ['#2563eb', '#ea580c', '#16a34a', '#9333ea', '#dc2626', '#0891b2', '#ca8a04', '#db2777', '#4d7c0f', '#7c3aed', '#0f766e', '#b45309', '#be123c', '#1d4ed8', '#c2410c', '#15803d'] as const
export const slotPreviewColour = (index: number): string => SLOT_PREVIEW_COLOURS[index % SLOT_PREVIEW_COLOURS.length] as string
/** The colour a slot shows: the host's choice for it, else the colour the designer gave it, else a preview colour. */
export const slotShownColour = (s: { id: string; color?: string }, index: number, host?: Record<string, { color: string }>): string => host?.[s.id]?.color ?? s.color ?? slotPreviewColour(index)

export interface ColoursHost {
  /** The design's colour slots, or null when it is one colour. */
  map: ColourMap | null
  onChange: (map: ColourMap | null) => void
  /** The most slots (the Atelier connector's setting). Default `DEFAULT_MAX_COLOURS`; `null` is no limit (the standalone). */
  maxColours?: number | null
  /** The colour the host chose for each slot, by slot id (the filament of the shop). The model and the swatches use it; a slot without one gets a preview colour. */
  colours?: Record<string, { color: string }>
}

const nextId = (map: ColourMap): string => { let n = 1; while (map.slots.some(s => s.id === String(n))) n++; return String(n) }
const WHOLE = '*'

export function ColoursPanel({ t, host, mesh, showMapped, onShowMapped }: { t: T; host: ColoursHost; mesh: Mesh | null; showMapped: boolean; onShowMapped: (on: boolean) => void }): ReactElement {
  const { map } = host
  const max = host.maxColours === null ? Infinity : host.maxColours ?? DEFAULT_MAX_COLOURS
  const [confirmOff, setConfirmOff] = useState(false)
  const parts = useMemo(() => { if (!mesh) return [] as string[]; const p = colourParts(mesh); return [...new Set([...p.segments, ...p.groups])] }, [mesh])
  const left = useMemo(() => (map && mesh ? resolveColours(mesh, map, { mode: 'edit' }).unassigned : []), [map, mesh])
  if (!map) {
    return (
      <section className="am-colours" aria-label={tx(t, 'colours.title', 'Colours')}>
        <h3>{tx(t, 'colours.title', 'Colours')}</h3>
        <p className="am-help">{tx(t, 'colours.offBody', 'This design is printed in one colour: the customer chooses one filament for the whole part.')}</p>
        <button type="button" className="am-primary" onClick={() => host.onChange({ slots: DEFAULT_COLOUR_MAP.slots.map(s => ({ ...s, parts: [...s.parts] })) })}>{tx(t, 'colours.useSeveral', 'Use several colours')}</button>
      </section>
    )
  }
  const set = (slots: ColourSlot[]): void => host.onChange({ slots })
  const patch = (id: string, f: (s: ColourSlot) => ColourSlot): void => set(map.slots.map(s => (s.id === id ? f(s) : s)))
  /** A part belongs to one slot: putting it in one takes it out of the others. */
  const assign = (part: string, to: string | null): void => set(map.slots.map(s => {
    const without = s.parts.filter(p => p !== part)
    return s.id === to ? { ...s, parts: [...without, part] } : { ...s, parts: without }
  }))
  const problems = colourMapProblems(map, { maxColours: max })
  const slotOf = (part: string): string | null => map.slots.find(s => s.parts.includes(part))?.id ?? null
  const inModel = new Set(parts)
  const used = map.slots.length
  const problemText = (c: string, p: Record<string, unknown>): string => {
    if (c === 'colours.too_many') return tx(t, 'colours.tooMany', 'This design has {{count}} colours; the most here is {{max}}. Remove a colour.', { count: Number(p['count']), max: Number(p['max']) })
    if (c === 'colours.part_twice') return tx(t, 'colours.partTwice', '“{{part}}” is in more than one colour.', { part: String(p['part'] === WHOLE ? tx(t, 'colours.whole', 'Whole part') : p['part']) })
    return tx(t, 'colours.invalid', 'The colours of this design are not valid.')
  }
  return (
    <section className="am-colours" aria-label={tx(t, 'colours.title', 'Colours')}>
      <button type="button" className="am-panelact" disabled={used >= max} title={used >= max ? tx(t, 'colours.maxReached', 'The most colours is {{max}}.', { max }) : undefined} onClick={() => set([...map.slots, { id: nextId(map), name: tx(t, 'colours.newName', 'Colour {{n}}', { n: used + 1 }), parts: [] }])}><Icon name="plus" size={16} />{tx(t, 'colours.add', 'Add a colour')}</button>
      <p className="am-help am-panelabout">{tx(t, 'colours.about', 'Which part of the model prints in which filament.')}</p>
      <p className="am-help" data-testid="colours-count">{Number.isFinite(max) ? tx(t, 'colours.uses', 'Uses {{count}} of {{max}} colours', { count: used, max }) : tx(t, 'colours.usesAny', 'Uses {{count}} colours', { count: used })}</p>
      <label className="am-check"><input type="checkbox" checked={showMapped} onChange={e => onShowMapped(e.target.checked)} /> {tx(t, 'colours.showMapped', 'Show mapped colours')}</label>
      <p className="am-help">{tx(t, 'colours.showMappedHint', 'Off: each part in its own colour, to tell them apart. On: each colour of this list.')}</p>
      {problems.map((p, i) => <p key={i} className="am-error-text" role="alert">{problemText(p.code, p.params)}</p>)}
      <ul className="am-slots">
        {map.slots.map((s, i) => (
          <li key={s.id} className="am-slot" data-slot={s.id}>
            <div className="am-slothead">
              {host.colours
                ? <span className="am-swatch-dot" style={{ background: slotShownColour(s, i, host.colours) }} aria-hidden="true" />
                : <input type="color" className="am-swatch-input" aria-label={tx(t, 'colours.slotColour', 'Colour of {{name}}', { name: s.name })} value={slotShownColour(s, i)} onChange={e => patch(s.id, x => ({ ...x, color: e.target.value }))} />}
              <input type="text" aria-label={tx(t, 'colours.slotName', 'Name of colour {{n}}', { n: i + 1 })} value={s.name} maxLength={40} onChange={e => patch(s.id, x => ({ ...x, name: e.target.value }))} />
              <button type="button" className="am-ib" aria-label={tx(t, 'colours.remove', 'Remove {{name}}', { name: s.name })} disabled={map.slots.length <= 1} onClick={() => set(map.slots.filter(x => x.id !== s.id))}><Icon name="trash" size={16} /></button>
            </div>
            <ul className="am-slotparts">
              {s.parts.map(p => (
                <li key={p} className="am-chip">
                  <span className={p !== WHOLE && !inModel.has(p) ? 'am-help' : ''}>{p === WHOLE ? tx(t, 'colours.whole', 'Whole part') : p}{p !== WHOLE && !inModel.has(p) ? ` · ${tx(t, 'colours.notInModel', 'not in the model')}` : ''}</span>
                  <button type="button" className="am-link" aria-label={tx(t, 'colours.takeOut', 'Take {{part}} out of {{name}}', { part: p === WHOLE ? tx(t, 'colours.whole', 'Whole part') : p, name: s.name })} onClick={() => patch(s.id, x => ({ ...x, parts: x.parts.filter(q => q !== p) }))}>×</button>
                </li>
              ))}
              {s.parts.length === 0 ? <li className="am-help">{tx(t, 'colours.noParts', 'No parts yet.')}</li> : null}
            </ul>
            <label className="am-slotadd">
              <span className="am-sr">{tx(t, 'colours.addPart', 'Add a part to {{name}}', { name: s.name })}</span>
              <select value="" onChange={e => { if (e.target.value) assign(e.target.value, s.id) }}>
                <option value="">{tx(t, 'colours.addPartPlaceholder', 'Add a part…')}</option>
                {!s.parts.includes(WHOLE) ? <option value={WHOLE}>{tx(t, 'colours.whole', 'Whole part')}</option> : null}
                {parts.filter(p => !s.parts.includes(p)).map(p => <option key={p} value={p}>{p}{slotOf(p) ? ` (${map.slots.find(x => x.id === slotOf(p))?.name})` : ''}</option>)}
              </select>
            </label>
          </li>
        ))}
      </ul>
      {left.length > 0 ? (
        <div className="am-leftover" role="note">
          <strong>{tx(t, 'colours.unassigned', 'Not in a colour')}</strong>
          <p className="am-help">{tx(t, 'colours.unassignedHint', 'The editor shows these in their own colours. Everywhere else — previews, the customer’s screen, the pictures and the files — they use the first colour.')}</p>
          <ul className="am-slotparts">{left.map(p => <li key={p} className="am-chip"><span>{p}</span></li>)}</ul>
        </div>
      ) : null}
      <button type="button" className="am-link am-colours-off" onClick={() => setConfirmOff(true)}>{tx(t, 'colours.useOne', 'Use one colour')}</button>
      {confirmOff ? (
        <Dialog title={tx(t, 'colours.offTitle', 'Use one colour?')} onClose={() => setConfirmOff(false)} t={t}>
          <p>{tx(t, 'colours.offConfirm', 'The colours you set up are removed. The whole part will be one colour.')}</p>
          <div className="am-actions"><button type="button" data-autofocus onClick={() => setConfirmOff(false)}>{tx(t, 'colours.keep', 'Keep the colours')}</button><button type="button" className="am-primary" onClick={() => { setConfirmOff(false); host.onChange(null) }}>{tx(t, 'colours.useOne', 'Use one colour')}</button></div>
        </Dialog>
      ) : null}
    </section>
  )
}
