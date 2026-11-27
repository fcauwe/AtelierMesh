// Opening a file takes a moment: reading the bytes, unpacking, reading the model, checking it. These pieces show the AtelierMesh loader, the stage in words,
// a thin bar that moves with what is known (bytes read, share of the model parsed) and a Stop that returns to the start page. A quick open never shows them
// (`useLoadingShown` waits 300 ms), and a screen reader hears "Working" once at the start and "Done" once at the end.
import { useCallback, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { T } from './common'
import { Dialog, tx } from './common'
import { Loader, useAnnouncement, useWorking } from './Working'

export type LoadStage = 'read' | 'unpack' | 'parse' | 'check' | 'prepare' | 'simplify'
export interface LoadingState {
  stage: LoadStage
  /** 0 to 1 when the work can say how far it is; left out when it cannot (the bar then slides). */
  fraction?: number
  /** Bytes read so far and in all, for "12.3 of 48.0 MB". */
  bytes?: { done: number; total: number }
}

export const LOADING_DELAY_MS = 300
const FALLBACK: Record<LoadStage, string> = {
  read: 'Reading the file…', unpack: 'Unpacking the file…', parse: 'Reading the model…', check: 'Checking the model…', prepare: 'Preparing the view…', simplify: 'Simplifying the model…',
}
const mb = (n: number): string => (n / 1_048_576).toFixed(1)

/** `true` once something has been loading for 300 ms; `false` again as soon as it ends. */
export const useLoadingShown = (active: boolean, delay = LOADING_DELAY_MS): boolean => useWorking(active, delay)

/**
 * The state of one load, for a host: `begin()` returns an AbortSignal for the parsers, `set` reports a stage and how far it is, `end()` clears it, `stop()` aborts.
 * A progress update that moves the bar by less than one percent is dropped, so a parser reporting thousands of times does not render thousands of times.
 */
export function useLoading(): { state: LoadingState | null; begin: (stage?: LoadStage) => AbortSignal; set: (stage: LoadStage, fraction?: number, bytes?: LoadingState['bytes']) => void; end: () => void; stop: () => void } {
  const [state, setState] = useState<LoadingState | null>(null)
  const last = useRef<LoadingState | null>(null)
  const ac = useRef<AbortController | null>(null)
  const set = useCallback((stage: LoadStage, fraction?: number, bytes?: LoadingState['bytes']): void => {
    const p = last.current
    if (p && p.stage === stage && fraction !== undefined && p.fraction !== undefined && Math.abs(p.fraction - fraction) < 0.01) return
    last.current = { stage, ...(fraction !== undefined ? { fraction } : {}), ...(bytes ? { bytes } : {}) }
    setState(last.current)
  }, [])
  const begin = useCallback((stage: LoadStage = 'read'): AbortSignal => {
    ac.current?.abort(); ac.current = new AbortController(); last.current = null; set(stage, 0); return ac.current.signal
  }, [set])
  const end = useCallback((): void => { ac.current = null; last.current = null; setState(null) }, [])
  const stop = useCallback((): void => { ac.current?.abort() }, [])
  return { state, begin, set, end, stop }
}

/** Loader, stage, bar and (optionally) Stop in one row. */
export function LoadingRow({ t, state, onStop }: { t: T; state: LoadingState; onStop?: () => void }): ReactElement {
  const label = tx(t, `loading.${state.stage}`, FALLBACK[state.stage])
  const pct = state.fraction === undefined ? undefined : Math.round(Math.max(0, Math.min(1, state.fraction)) * 100)
  const detail = state.bytes ? tx(t, 'loading.bytes', '{{done}} of {{total}} MB', { done: mb(state.bytes.done), total: mb(state.bytes.total) }) : ''
  return (
    <div className="am-working am-loadrow" data-testid="loading" data-stage={state.stage}>
      <Loader />
      <span className="am-working-label">{label}</span>
      <span className="am-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} {...(pct !== undefined ? { 'aria-valuenow': pct, 'data-progress': pct } : {})}>
        <span className={pct !== undefined ? 'am-bar-fill' : 'am-bar-fill am-bar-indeterminate'} style={pct !== undefined ? { width: `${pct}%` } : undefined} />
      </span>
      {detail ? <span className="am-loaddetail">{detail}</span> : null}
      {onStop ? <button type="button" className="am-stop" onClick={onStop}>{t('work.stop')}</button> : null}
    </div>
  )
}

/** The page while a file opens: the loader, large, with the stage, the bar and Stop under it. Appears after 300 ms; before that the page stays as it was. */
export function LoadingView({ t, state, onStop, delay, intro }: { t: T; state: LoadingState | null; onStop?: () => void; /** What the page is about, shown above the loader: for an example from the gallery its picture, name and a line about the copy you get. */ intro?: ReactNode; /** Milliseconds before the page shows (300 by default; tests use 0). */ delay?: number }): ReactElement | null {
  const shown = useLoadingShown(state !== null, delay)
  const said = useAnnouncement(shown, t)
  return (
    <>
      <div className="am-sr" role="status" aria-live="polite">{said}</div>
      {shown && state ? (
        <div className="am-loadview" role="region" aria-label={t('page.loading')}>
          <div className="am-loadbox">
            {intro ?? <h2>{t('page.loading')}</h2>}
            <LoadingRow t={t} state={state} {...(onStop ? { onStop } : {})} />
          </div>
        </div>
      ) : null}
    </>
  )
}

/** "Simplifying the model": the dialog of the design while the triangles are reduced; Stop goes back to choosing another file. */
export function SimplifyingDialog({ t, fraction, onStop }: { t: T; fraction?: number; onStop: () => void }): ReactElement {
  return (
    <Dialog title={t('check.simplifying.title')} onClose={onStop} strict t={t}>
      <p>{t('check.simplifying.body')}</p>
      <LoadingRow t={t} state={{ stage: 'simplify', ...(fraction !== undefined ? { fraction } : {}) }} />
      <div className="am-actions"><button type="button" data-autofocus onClick={onStop}>{t('work.stop')}</button></div>
    </Dialog>
  )
}

/** "The model is simplified": the counts before and after, a picture of the result when the host has one, and the way on. */
export function SimplifiedDialog({ t, from, to, image, onOpen, onOther }: { t: T; from: number; to: number; image?: string; onOpen: () => void; onOther: () => void }): ReactElement {
  const fmt = (n: number): string => n.toLocaleString('en').replace(/,/g, ' ')
  return (
    <Dialog title={t('check.simplified.title')} onClose={onOther} strict t={t}>
      <p>{t('check.simplified.body', { from: fmt(from), to: fmt(to) })}</p>
      {image ? <img className="am-simplified-img" src={image} alt="" width={320} height={220} /> : null}
      <div className="am-actions">
        <button type="button" onClick={onOther}>{t('check.other')}</button>
        <button type="button" className="am-primary" data-autofocus onClick={onOpen}>{t('check.simplified.continue')}</button>
      </div>
    </Dialog>
  )
}
