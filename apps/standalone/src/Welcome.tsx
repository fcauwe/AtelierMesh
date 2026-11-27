// The welcome popup: shown once, the first time the app is opened, after the logo intro. A short word on what the app is and how it works, and what is new.
// A visitor who has already seen the welcome gets the news alone, once for each entry in `news.ts` that is newer than the newest one they have seen: adding an entry
// there is all it takes to tell everyone about a change.
// Not shown in automated browsers (navigator.webdriver) or with ?welcome=0; ?welcome=1 forces the welcome, ?welcome=news forces the news.
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Dialog } from '@ateliermesh/react'
import { LATEST_NEWS, NEWS, newsKey, unseenNews } from './news'

const KEY = 'am.welcomed'
const NEWS_KEY = 'am.newsSeen'   // the newest version of the news this visitor has seen (see news.ts)

export type WelcomeMode = 'welcome' | 'news'

/** What to show: the full welcome (first visit), the news alone (the visitor knows the app and there is news they have not seen), or nothing. Pure, so it can be tested. */
export function welcomeMode(o: { query: string | null; webdriver: boolean; welcomed: string | null; newsSeen: string | null }): WelcomeMode | null {
  if (o.query === '1') return 'welcome'
  if (o.query === 'news') return 'news'
  if (o.query === '0' || o.webdriver) return null
  if (o.welcomed !== '1') return 'welcome'
  return unseenNews(o.newsSeen).length > 0 ? 'news' : null
}

const wanted = (): WelcomeMode | null => {
  try {
    return welcomeMode({ query: new URLSearchParams(location.search).get('welcome'), webdriver: !!navigator.webdriver, welcomed: localStorage.getItem(KEY), newsSeen: localStorage.getItem(NEWS_KEY) })
  } catch { return null }
}

export function Welcome({ t }: { t: (key: string, values?: Record<string, string | number>) => string }): ReactElement | null {
  const [mode] = useState(wanted)
  const [seen] = useState(() => { try { return localStorage.getItem(NEWS_KEY) } catch { return null } })
  const [ready, setReady] = useState(false)   // the intro is over (or was not shown)
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!mode) return
    const on = (): void => setReady(true)
    window.addEventListener('am:intro-done', on)
    return () => window.removeEventListener('am:intro-done', on)
  }, [mode])
  const close = (): void => {
    try { localStorage.setItem(KEY, '1'); localStorage.setItem(NEWS_KEY, LATEST_NEWS) } catch { /* private window: it comes back next time */ }
    setReady(false); setDone(true)
  }
  if (!mode || !ready || done) return null
  const unseen = unseenNews(seen)
  const entries = unseen.length === 0 && mode === 'news' ? NEWS.slice(0, 1) : unseen   // ?welcome=news shows the latest even when it has been seen
  const news = entries.length === 0 ? null : (
    <>
      {entries.map(e => (
        <section key={e.version}>
          <h3 className="am-welcome-news">{entries.length === 1 && mode === 'welcome' ? t('welcome.newTitle') : t('welcome.newIn', { version: e.version })}</h3>
          <ul className="am-welcome-list am-welcome-newlist">{e.items.map(k => <li key={k}>{t(newsKey(e.version, k))}</li>)}</ul>
        </section>
      ))}
    </>
  )
  return (
    <Dialog title={t(mode === 'news' ? 'welcome.newsOnlyTitle' : 'welcome.title')} onClose={close} t={t}>
      {mode === 'welcome' ? (
        <>
          <p className="am-welcome-lead">{t('welcome.lead')}</p>
          <ul className="am-welcome-list">
            <li>{t('welcome.open')}</li>
            <li>{t('welcome.steps')}</li>
            <li>{t('welcome.private')}</li>
            <li>{t('welcome.save')}</li>
          </ul>
        </>
      ) : null}
      {news}
      <div className="am-actions"><button type="button" className="am-primary" data-autofocus onClick={close}>{t(mode === 'news' ? 'welcome.gotIt' : 'welcome.start')}</button></div>
    </Dialog>
  )
}
