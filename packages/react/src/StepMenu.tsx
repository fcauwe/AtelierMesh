// The "⋮" menu of the selected step, in the settings header: move up and down, switch off or on, delete.
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Icon } from './icons'
import type { T } from './common'

export interface StepMenuProps { t: T; index: number; count: number; enabled: boolean; onMove: (to: number) => void; onToggle: () => void; onDelete: () => void; onApply?: () => void; applyDisabled?: boolean }

export function StepMenu({ t, index, count, enabled, onMove, onToggle, onDelete, onApply, applyDisabled }: StepMenuProps): ReactElement {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent): void => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') { setOpen(false); trigger.current?.focus() } }
    document.addEventListener('mousedown', away); document.addEventListener('keydown', key)
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus()
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key) }
  }, [open])
  const run = (f: () => void): void => { setOpen(false); f(); trigger.current?.focus() }
  return (
    <div className="am-stepmenu" ref={root}>
      <button ref={trigger} type="button" className="am-ib am-ib-light" aria-label={t('editor.stepMenu')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <Icon name="dots" />
      </button>
      {open ? (
        <div className="am-menu am-menu-right" role="menu" aria-label={t('editor.stepMenu')}>
          <button type="button" role="menuitem" disabled={index === 0} onClick={() => run(() => onMove(index - 1))}>{t('order.moveUp')}</button>
          <button type="button" role="menuitem" disabled={index === count - 1} onClick={() => run(() => onMove(index + 1))}>{t('order.moveDown')}</button>
          <button type="button" role="menuitem" onClick={() => run(onToggle)}>{t(enabled ? 'editor.switchOff' : 'editor.switchOn')}</button>
          {onApply ? <button type="button" role="menuitem" disabled={applyDisabled} onClick={() => run(onApply)}>{t('editor.applyPermanent')}</button> : null}
          <button type="button" role="menuitem" className="am-danger" onClick={() => run(onDelete)}>{t('editor.delete')}</button>
        </div>
      ) : null}
    </div>
  )
}
