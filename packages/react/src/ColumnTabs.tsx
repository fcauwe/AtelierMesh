// The switcher at the top of the steps column and of the phone sheet (design round 7): tabs with the icon above the label, a count beside the icon and a red "!" on the icon's corner.
// One component for both screens. Roving tab index, selection follows focus, a tooltip after 500 ms, and a polite announcement when a "!" appears on a tab that is not selected.
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'
import type { T } from './common'
import { tx } from './common'
import { Icon } from './icons'

export interface ColumnTab {
  id: string
  /** The visible label: about 9 characters; a longer one is cut with an ellipsis (the full name is in the tooltip and the screen-reader name). */
  label: string
  icon: string
  /** A number beside the icon; none when `undefined` or `null`. */
  count?: number | null
  /** One sentence saying what is wrong: it puts the "!" on the icon and is the last line of the tooltip. */
  alert?: string | null
  /** What the panel is for (the tooltip). */
  about?: string
  /** The screen-reader name: label, count and problem. Defaults to the label. */
  name?: string
  /** The host's own tab (Print): after a thin divider. */
  host?: boolean
}

export function ColumnTabs({ t, tabs, value, onChange, label, idPrefix }: { t: T; tabs: ColumnTab[]; value: string; onChange: (id: string) => void; label: string; idPrefix: string }): ReactElement {
  const [tip, setTip] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [said, setSaid] = useState('')
  const before = useRef<Record<string, string | null | undefined> | null>(null)
  // a "!" that appears on a tab that is not selected is said once
  useEffect(() => {
    const now: Record<string, string | null | undefined> = Object.fromEntries(tabs.map(x => [x.id, x.alert]))
    const old = before.current
    before.current = now
    if (!old) return
    const fresh = tabs.find(x => x.alert && !old[x.id] && x.id !== value)
    if (fresh) setSaid(tx(t, 'editor.tabAlertNew', '{{panel}}: {{alert}}', { panel: fresh.label, alert: fresh.alert ?? '' }))
  }, [tabs, value, t])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const show = (id: string): void => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setTip(id), 500) }
  const hide = (): void => { if (timer.current) clearTimeout(timer.current); setTip(null) }
  const keys = (e: KeyboardEvent): void => {
    const i = tabs.findIndex(x => x.id === value)
    const to = e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : e.key === 'ArrowLeft' ? tabs[(i - 1 + tabs.length) % tabs.length] : e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[tabs.length - 1] : undefined
    if (!to) return
    e.preventDefault(); onChange(to.id)
    requestAnimationFrame(() => document.getElementById(`${idPrefix}${to.id}`)?.focus())
  }
  const shown = tabs.find(x => x.id === tip)
  return (
    <div className="am-ctabs-wrap">
      <div className="am-ctabs" role="tablist" aria-label={label} data-items={tabs.length} onKeyDown={keys} onMouseLeave={hide}>
        {tabs.map((x, i) => (
          <span key={x.id} className="am-ctab-slot">
            {x.host && !tabs[i - 1]?.host ? <span className="am-ctab-divider" aria-hidden="true" /> : null}
            <button type="button" role="tab" id={`${idPrefix}${x.id}`} className="am-ctab" aria-selected={value === x.id} tabIndex={value === x.id ? 0 : -1} aria-label={x.name ?? x.label}
              onClick={() => onChange(x.id)} onMouseEnter={() => show(x.id)} onFocus={e => { if (e.currentTarget.matches(':focus-visible')) show(x.id) }} onBlur={hide}>
              <span className="am-ctab-top" aria-hidden="true">
                <span className="am-ctab-icon"><Icon name={x.icon as never} size={18} />{x.alert ? <span className="am-ctab-bang">!</span> : null}</span>
                {x.count !== undefined && x.count !== null ? <span className="am-tabcount">{x.count}</span> : null}
              </span>
              <span className="am-ctab-label" aria-hidden="true">{x.label}</span>
            </button>
          </span>
        ))}
      </div>
      {shown && (shown.about || shown.alert) ? (
        <div className="am-ctip" role="tooltip">
          <strong>{shown.label}</strong>
          {shown.about ? <span>{shown.about}</span> : null}
          {shown.alert ? <span className="am-ctip-alert"><span className="am-ctab-bang" aria-hidden="true">!</span>{shown.alert}</span> : null}
        </div>
      ) : null}
      <span className="am-sr" role="status" aria-live="polite">{said}</span>
    </div>
  )
}
