// Small shared pieces of the editor: the translator type, a modal dialog and a media query hook.
import { useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

export type T = (key: string, values?: Record<string, string | number>) => string

/** A text with a plain-English fallback for the few words design has not written yet. */
/**
 * A problem's text with its values filled in. A value the sender did not give leaves nothing behind: a plugin's own text may name a value that only some of its errors carry
 * (`({{part}}{{message}})`), and a person should not read the braces. Empty brackets and doubled spaces left by that are tidied.
 */
export const problemText = (t: T, key: string, values: Record<string, string | number>): string => t(key, values).replace(/\{\{\s*\w+\s*\}\}/g, '').replace(/\s*\(\s*\)/g, '').replace(/ {2,}/g, ' ').trim()

export const tx = (t: T, key: string, fallback: string, values?: Record<string, string | number>): string => {
  const v = t(key, values)
  return v === key ? fallback.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, n: string) => String(values?.[n] ?? '')) : v
}

export function useMediaQuery(query: string): boolean {
  const get = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches
  const [on, setOn] = useState(get)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const m = window.matchMedia(query)
    const fn = (): void => setOn(m.matches)
    fn(); m.addEventListener('change', fn)
    return () => m.removeEventListener('change', fn)
  }, [query])
  return on
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * A modal dialog: named, closes with Escape, keeps Tab inside and gives the focus back to what opened it.
 * `onClose` is also what a click on the dimmed background does, unless `strict` (a dialog that must be answered).
 */
export function Dialog({ title, onClose, children, strict = false, wide = false, wider = false, t }: { title: string; onClose: () => void; children: ReactNode; strict?: boolean; wide?: boolean; /** For lists of cards (the plugin manager): up to 1040 px on a large screen. */ wider?: boolean; t?: T }): ReactElement {
  const box = useRef<HTMLDivElement>(null)
  const id = useRef(`am-dlg-${Math.random().toString(36).slice(2, 8)}`).current
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const first = box.current?.querySelector<HTMLElement>('[data-autofocus]') ?? box.current?.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus()
    return () => { before?.focus?.() }
  }, [])
  // on the document, so Escape and Tab still work when the focused button was disabled by the click and the focus fell to the page
  const close = useRef(onClose); close.current = onClose
  useEffect(() => {
    const fn = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { if (!strict) { e.stopPropagation(); close.current() } }
      else if (e.key === 'Tab' && box.current && !box.current.contains(document.activeElement)) { e.preventDefault(); box.current.querySelector<HTMLElement>(FOCUSABLE)?.focus() }
    }
    document.addEventListener('keydown', fn)
    return () => document.removeEventListener('keydown', fn)
  }, [strict])
  const key = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Tab' || !box.current) return
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
    if (items.length === 0) return
    const a = items[0] as HTMLElement, z = items[items.length - 1] as HTMLElement
    if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus() }
    else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus() }
  }
  void t
  return (
    <div className="am-scrim" onMouseDown={e => { if (e.target === e.currentTarget && !strict) onClose() }}>
      <div ref={box} className={`am-dialog${wider ? ' am-wider' : wide ? ' am-wide' : ''}`} role={strict ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby={id} onKeyDown={key}>
        <h2 id={id}>{title}</h2>
        {children}
      </div>
    </div>
  )
}

/**
 * The `accept` list for a file picker: none. A list greys out files of a type the browser does not know (`.amplugin`, `.amproj`, often `.3mf`) in Safari on
 * an iPhone or iPad, and in Firefox a file dialog with a list can leave out "All files" or hide a file whose type it maps differently. Without a list every
 * file can be chosen; what the file really is gets checked after it is chosen anyway, with a message that says what was wrong.
 */
export function fileAccept(_list: string): string | undefined {
  return undefined
}
