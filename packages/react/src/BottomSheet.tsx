// The phone's bottom sheet: the view stays on top, the steps and the settings live in a panel that is pulled up and down.
// Three heights: peek (the handle and one line), half and full. The handle is a real button, so the keyboard and a screen reader work;
// a drag on it moves the sheet and snaps to the nearest height. Content inside scrolls on its own at every height.
import { useEffect, useRef, useState } from 'react'
import type { PointerEvent, ReactElement, ReactNode } from 'react'
import type { T } from './common'
import { tx } from './common'

export type SheetHeight = 'peek' | 'half' | 'full'
const ORDER: SheetHeight[] = ['peek', 'half', 'full']
const FRACTION: Record<SheetHeight, number> = { peek: 0, half: 0.45, full: 0.85 }

export function BottomSheet({ t, height, onHeight, title, footer, tabs, children }: { t: T; height: SheetHeight; onHeight: (h: SheetHeight) => void; title: string; footer?: ReactNode; /** The column switcher: under the handle, visible when the sheet is closed. The title is then not shown. */ tabs?: ReactNode; children: ReactNode }): ReactElement {
  const [drag, setDrag] = useState<number | null>(null)       // extra pixels while the finger is down (negative = up)
  const start = useRef<{ y: number; moved: boolean } | null>(null)
  const parent = useRef<HTMLDivElement>(null)
  const foot = useRef<HTMLDivElement>(null)
  // the height of the footer goes to the parent as --am-footer-h, so the sheet and the view both leave room for it
  useEffect(() => {
    const host = parent.current?.parentElement, el = foot.current
    if (!host) return
    if (!el) { host.style.removeProperty('--am-footer-h'); return }
    const set = (): void => host.style.setProperty('--am-footer-h', `${el.getBoundingClientRect().height}px`)
    set()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(set) : null
    ro?.observe(el)
    return () => { ro?.disconnect(); host.style.removeProperty('--am-footer-h') }
  }, [footer])
  const room = (): number => (parent.current?.parentElement?.getBoundingClientRect().height ?? window.innerHeight)
  const down = (e: PointerEvent): void => { start.current = { y: e.clientY, moved: false }; (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId) }
  const move = (e: PointerEvent): void => {
    if (!start.current) return
    const dy = e.clientY - start.current.y
    if (Math.abs(dy) > 6) start.current.moved = true
    if (start.current.moved) setDrag(dy)
  }
  const up = (e: PointerEvent): void => {
    const s = start.current; start.current = null
    if (!s) return
    const dy = e.clientY - s.y
    setDrag(null)
    if (!s.moved) return                                         // a tap: the click handler cycles the height
    const target = FRACTION[height] * room() - dy                // where the top edge ended up, measured as a height
    let best: SheetHeight = height, gap = Infinity
    for (const h of ORDER) { const g = Math.abs(FRACTION[h] * room() - target); if (g < gap) { gap = g; best = h } }
    onHeight(best)
    ;(e.currentTarget as HTMLElement).dataset['swallow'] = '1'    // the click that follows a drag must not also cycle
  }
  const cycle = (e: React.MouseEvent<HTMLButtonElement>): void => {
    if (e.currentTarget.dataset['swallow']) { delete e.currentTarget.dataset['swallow']; return }
    onHeight(height === 'peek' ? 'half' : height === 'half' ? 'full' : 'peek')
  }
  const px = Math.max(tabs ? 82 : 56, FRACTION[height] * room() - (drag ?? 0))
  return (
    <div ref={parent} className={`am-sheet am-sheet-${height}${tabs ? ' am-sheet-tabbed' : ''}`} style={{ ['--am-sheet-h' as string]: drag === null ? undefined : `${px}px` }} role="region" aria-label={title}>
      <button type="button" className="am-sheet-handle" aria-expanded={height !== 'peek'} aria-label={tx(t, 'sheet.handle', 'Pull the panel')} onClick={cycle} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { start.current = null; setDrag(null) }}>
        <span aria-hidden="true" className="am-grip" />
        <span className="am-sheet-title">{title}</span>
      </button>
      {tabs ?? null}
      <div className="am-sheet-body">{children}</div>
      {footer ? <div ref={foot} className="am-sheet-footer">{footer}</div> : null}
    </div>
  )
}
