// The logo intro (design: ateliermesh-logo-intro.svg, 3 s, plays once): shown over the page when the app opens, once per browser session.
// Not shown with reduced motion, for automated browsers (navigator.webdriver) or with ?intro=0; ?intro=1 forces it. A click or a key skips it.
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

const KEY = 'am.intro'
const wanted = (): boolean => {
  try {
    const q = new URLSearchParams(location.search).get('intro')
    if (q === '1') return true
    if (q === '0' || navigator.webdriver) return false
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return false
    return sessionStorage.getItem(KEY) !== '1'
  } catch { return false }
}

export function Intro({ dark }: { dark: boolean }): ReactElement | null {
  const [phase, setPhase] = useState<'play' | 'out' | 'gone'>(() => (wanted() ? 'play' : 'gone'))
  useEffect(() => {
    if (phase === 'gone') return
    try { sessionStorage.setItem(KEY, '1') } catch { /* private window: it plays again next time */ }
    const a = setTimeout(() => setPhase('out'), 3100)
    const b = setTimeout(() => setPhase('gone'), 3500)
    const skip = (): void => setPhase(p => (p === 'play' ? 'out' : p))
    window.addEventListener('keydown', skip); window.addEventListener('pointerdown', skip)
    return () => { clearTimeout(a); clearTimeout(b); window.removeEventListener('keydown', skip); window.removeEventListener('pointerdown', skip) }
  }, [phase === 'gone'])
  useEffect(() => { if (phase === 'out') { const c = setTimeout(() => setPhase('gone'), 400); return () => clearTimeout(c) } }, [phase])
  // tell the rest of the page when the intro is over (the welcome popup waits for it); also when there was no intro
  useEffect(() => { if (phase === 'gone') { const x = setTimeout(() => window.dispatchEvent(new Event('am:intro-done')), 0); return () => clearTimeout(x) } }, [phase])
  if (phase === 'gone') return null
  return (
    <div className={`am-intro${phase === 'out' ? ' am-intro-out' : ''}`} role="presentation" aria-hidden="true">
      <img src={dark ? 'brand/ateliermesh-logo-intro-white.svg' : 'brand/ateliermesh-logo-intro.svg'} alt="" width={256} height={256} />
    </div>
  )
}
