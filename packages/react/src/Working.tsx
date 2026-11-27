// The waiting behaviour of the design (decisions section 4): after a short delay a row under the view shows the AtelierMesh loader, the stage
// of the running step, a thin bar and a Stop link; the last good model stays on screen, dimmed (the "ghost"); a polite live region says
// "Working" once at the start and "Done" once at the end. Reduced motion: the label and a still loader.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { stageKey } from '@ateliermesh/ui'
import type { T } from './common'
import { tx } from './common'

/** What the engine last reported: the step it is working on, its stage and how far it is (0 to 1). */
export interface RunProgress { stepId: string; stage: string; fraction: number }
/** Runs shorter than this never show the indicator, so a quick change does not flash. */
export const WORKING_DELAY_MS = 400

/** `true` once `running` has lasted `delay` ms; goes back to `false` at once when the run ends. */
export function useWorking(running: boolean, delay = WORKING_DELAY_MS): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!running) { setShown(false); return }
    const id = setTimeout(() => setShown(true), delay)
    return () => clearTimeout(id)
  }, [running, delay])
  return shown
}

/** The engine's `onProgress`, kept as state without a render per tick: only a new step, a new stage or a visible move of the bar counts. */
export function useProgress(): { progress: RunProgress | null; report: (stepId: string, stage: string, fraction: number) => void; reset: () => void } {
  const [progress, setProgress] = useState<RunProgress | null>(null)
  const last = useRef<RunProgress | null>(null)
  const report = useCallback((stepId: string, stage: string, fraction: number): void => {
    const p = last.current
    if (p && p.stepId === stepId && p.stage === stage && Math.abs(p.fraction - fraction) < 0.02) return
    last.current = { stepId, stage, fraction }; setProgress(last.current)
  }, [])
  const reset = useCallback((): void => { last.current = null; setProgress(null) }, [])
  return { progress, report, reset }
}

/** The text for a polite live region: "Working" when the indicator appears, "Done" when it goes, nothing in between. */
export function useAnnouncement(shown: boolean, t: T): string {
  const [text, setText] = useState('')
  const was = useRef(false)
  useEffect(() => {
    if (shown) { was.current = true; setText(t('work.sr.busy')); return }
    if (!was.current) return
    was.current = false; setText(t('work.sr.done'))
    const id = setTimeout(() => setText(''), 2500)
    return () => clearTimeout(id)
  }, [shown, t])
  return text
}

const TRIANGLES: Array<[string, string]> = [
  ['#a3a3a3', 'M7.95 11.82 L19.19 36.03 L30.43 20.47 Z'], ['#525252', 'M33.57 20.47 L56.05 11.82 L44.81 36.03 Z'], ['#737373', 'M7 14.53 L7 52.91 L17.85 37.89 Z'],
  ['#1a1a1a', 'M46.15 37.89 L57 14.53 L57 52.91 Z'], ['#737373', 'M20.96 37 L32 21.71 L43.04 37 Z'], ['#525252', 'M7.96 55 L19 39.71 L30.04 55 Z'],
  ['#525252', 'M45 39.71 L56.04 55 L33.96 55 Z'], ['#f97316', 'M20.96 39 L43.04 39 L32 54.29 Z'],
]
/**
 * The waiting icon every screen of this package uses (the loader page, the row under the view, the middle of the view). By default it is the AtelierMesh loader, a square. A host
 * that has its own (the Atelier's) wraps the screens once:
 *   `<LoaderIconProvider value={size => <MySpinner height={size} />}>`            an icon that is square, or
 *   `<LoaderIconProvider value={{ render: size => <MySpinner height={size} />, aspect: 1.5 }}>`   an icon that is wider than it is high (width = height x aspect).
 * `size` is the **height of the slot** the layouts reserve, in pixels: 28 in the row under the view, 64 in the middle of the view, larger on the loader page. The slot is
 * `size` high and `size x aspect` wide (`aspect` default 1, a square), so a different shape needs no guessing and nothing shifts. The icon should fill its slot and be decorative
 * (`aria-hidden`): the rows name the work in words. Reduced motion is the icon's own job.
 */
export type LoaderIconValue = ((size: number) => ReactElement) | { render: (size: number) => ReactElement; aspect?: number }
const LoaderIcon = createContext<LoaderIconValue | null>(null)
export const LoaderIconProvider = LoaderIcon.Provider

/** The AtelierMesh loader (design 06-logo/animation/ateliermesh-loader.svg): the triangles dim one after another, 1.8 s loop. Decorative; the row names the work. */
export function Loader({ size = 28 }: { size?: number }): ReactElement {
  const custom = useContext(LoaderIcon)
  if (custom) {
    const render = typeof custom === 'function' ? custom : custom.render
    const aspect = typeof custom === 'function' ? 1 : (custom.aspect ?? 1)
    return <span className="am-loader-slot" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto', width: size * aspect, height: size }}>{render(size)}</span>
  }
  return (
    <svg className="am-loader" viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" focusable="false">
      {TRIANGLES.map(([fill, d], i) => <path key={i} className="am-loader-f" style={{ animationDelay: `${i * 150}ms` }} fill={fill} d={d} />)}
    </svg>
  )
}

/** The row under the view while a run takes long: loader, "Step 2 of 4 · Fitting the text to the surface…", a thin bar and Stop. */
export function WorkingRow({ t, progress, index, total, onStop, op }: { t: T; progress: RunProgress | null; index: number; total: number; onStop: () => void; /** The running step's operation id: a plugin's own text for its stage (`ops.<op>.stage.<stage>`) is shown before the host's. */ op?: string }): ReactElement {
  const own = progress && op ? t(`ops.${op}.stage.${progress.stage}`) : ''
  const stage = progress ? (own && own !== `ops.${op}.stage.${progress.stage}` ? own : t(stageKey(progress.stage))) : t('work.other')
  const label = index >= 0 && total > 1 ? `${tx(t, 'work.step', 'Step {{n}} of {{total}}', { n: index + 1, total })} · ${stage}` : stage
  const f = progress?.fraction ?? 0
  const known = f > 0 && f < 1
  return (
    <div className="am-working" data-testid="working">
      <Loader />
      <span className="am-working-label">{label}</span>
      <span className="am-bar" aria-hidden="true"><span className={known ? 'am-bar-fill' : 'am-bar-fill am-bar-indeterminate'} style={known ? { width: `${Math.round(f * 100)}%` } : undefined} /></span>
      <button type="button" className="am-stop" onClick={onStop}>{t('work.stop')}</button>
    </div>
  )
}

/** The loader alone, in the middle of the view, while the model is being made (the stage row and bar stay where they are). */
export function CenterLoader(): ReactElement {
  return <div className="am-center-loader" aria-hidden="true" data-testid="center-loader"><Loader size={64} /></div>
}
