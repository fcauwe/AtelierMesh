// The example gallery on the start page: cards, sort, search, a plugin filter, and a list that goes on as you scroll (always with a "Show more" button as well).
// It reads the catalogue itself and tells the page whether it has anything to show (`onAvailable`): when it has not, the page shows the built-in samples as before.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Dialog, Icon } from '@ateliermesh/react'
import { REPORT_REASONS, moreMerged, newSource, sendReport, shortCount, takeMerged, totalMerged } from './galleryData'
import type { GalleryItem, GalleryPlugin, GallerySource, ReportReason } from './galleryData'

type T = (key: string, values?: Record<string, string | number>) => string
const REASON_KEY: Record<ReportReason, string> = { broken: 'report.broken', not_a_model: 'report.notModel', not_theirs: 'report.copied', offensive: 'report.offensive', dangerous: 'report.danger' }

/** New for the first month, then Popular: a young gallery has no counts yet. */
export const defaultSort = (now: number = Date.now()): 'new' | 'popular' => (now < Date.UTC(2026, 11, 21) ? 'new' : 'popular')

export interface GalleryProps {
  t: T
  lang: 'en' | 'nl' | 'fr'
  /** The catalogues whose designs are shown, in the order of the list. With more than one, a card names its catalogue. */
  sources: Array<{ base: string; name: string }>
  /** The plugins this browser has (id and name), and the ones the catalogue offers that it has not: for the filter and the "needs" chips. */
  installed: GalleryPlugin[]
  others: GalleryPlugin[]
  /** Told when the gallery has something to show (true) or has not (false, with why: `missing` = no gallery here, `down` = it could not be reached). */
  onAvailable: (available: boolean, why?: 'missing' | 'down' | 'empty') => void
  onOpen: (item: GalleryItem) => void
  /** Said to the person for a moment ("Link copied"). */
  say: (text: string) => void
  /** Overrides, for tests. */
  fetcher?: typeof fetch
}

export function Gallery({ t, lang, sources, installed, others, onAvailable, onOpen, say, fetcher }: GalleryProps): ReactElement | null {
  const [sort, setSort] = useState<'new' | 'popular'>(defaultSort)
  const [search, setSearch] = useState(''), [typed, setTyped] = useState('')
  const [plugin, setPlugin] = useState('')
  const [total, setTotal] = useState(0)
  const [more, setMore] = useState(false)
  const srcs = useRef<GallerySource[]>([])
  const [items, setItems] = useState<GalleryItem[]>([])
  const [phase, setPhase] = useState<'first' | 'ready' | 'more' | 'error' | 'down'>('first')
  const [announce, setAnnounce] = useState('')
  const [menu, setMenu] = useState<string | null>(null)
  const [reporting, setReporting] = useState<GalleryItem | null>(null)
  const [reason, setReason] = useState<ReportReason | ''>('')
  const [thanks, setThanks] = useState(false)
  const [filters, setFilters] = useState(false)
  const everReady = useRef(false)
  const sentinel = useRef<HTMLDivElement>(null)
  const ctl = useRef<AbortController | null>(null)
  const query = useRef({ sort, search, plugin })
  query.current = { sort, search, plugin }

  // search: the list follows the typing a moment after it stops
  useEffect(() => { const id = window.setTimeout(() => setSearch(typed), 300); return () => window.clearTimeout(id) }, [typed])

  const sourcesKey = JSON.stringify(sources)
  const load = useCallback(async (replace: boolean): Promise<void> => {
    ctl.current?.abort()
    const c = new AbortController(); ctl.current = c
    setPhase(replace ? 'first' : 'more')
    if (replace) srcs.current = sources.map(s => newSource(s.base, s.name))
    else for (const s of srcs.current) s.failed = false   // Try again asks the failed pages again
    const taken = await takeMerged(srcs.current, query.current, 24, c.signal, fetcher)
    if (c.signal.aborted) return
    const all = srcs.current
    if (taken.length === 0 && all.length > 0 && all.every(s => s.failed)) {
      if (!everReady.current) { setPhase('down'); onAvailable(false, all.some(s => s.failure === 'down') ? 'down' : 'missing') } else setPhase('error')
      return
    }
    // a catalogue that has a gallery but no design yet (nothing imported, nothing shared) shows the built-in samples, as a missing one does; the page still lets people share
    if (replace && !everReady.current && taken.length === 0 && query.current.search.trim() === '' && query.current.plugin === '') { setPhase('down'); onAvailable(false, 'empty'); return }
    everReady.current = true
    setTotal(totalMerged(all)); setMore(moreMerged(all)); setPhase(all.some(s => s.failed) && taken.length < 24 && moreMerged(all) ? 'error' : 'ready')
    setItems(prev => (replace ? taken : [...prev, ...taken]))
    if (!replace && taken.length > 0) setAnnounce(t('gallery.loaded', { count: taken.length }))
    if (replace) onAvailable(true)
  }, [sourcesKey, fetcher, onAvailable, t])

  useEffect(() => { void load(true) }, [sort, search, plugin, sourcesKey])
  useEffect(() => () => ctl.current?.abort(), [])

  // scrolling near the end loads the next page by itself
  useEffect(() => {
    const el = sentinel.current
    if (!el || !more || phase !== 'ready' || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) void load(false) }, { rootMargin: '600px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [more, phase, load])

  // the menu of a card closes with Escape and a click elsewhere
  useEffect(() => {
    if (menu === null) return
    const out = (e: MouseEvent): void => { if (!(e.target as Element).closest?.('.am-gmenu, .am-gmore')) setMenu(null) }
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') setMenu(null) }
    document.addEventListener('mousedown', out); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', out); document.removeEventListener('keydown', esc) }
  }, [menu])

  if (phase === 'down' || (phase === 'first' && !everReady.current && items.length === 0)) return null

  const have = new Set(installed.map(p => p.id))
  const share = async (it: GalleryItem): Promise<void> => {
    const url = it.link || it.picture
    try {
      if (typeof navigator.share === 'function' && window.matchMedia?.('(pointer: coarse)').matches) { await navigator.share({ title: it.name, url }); return }
    } catch { /* cancelled: nothing to say */ return }
    try { await navigator.clipboard.writeText(url); say(t('gallery.linkCopied')) } catch { say(url) }
  }
  const copy = async (it: GalleryItem): Promise<void> => { setMenu(null); try { await navigator.clipboard.writeText(it.link || it.picture); say(t('gallery.linkCopied')) } catch { say(it.link || it.picture) } }
  const send = async (): Promise<void> => { if (!reporting || reason === '') return; const ok = await sendReport(reporting.base, reporting.id, reason, fetcher); if (ok) setThanks(true); else say(t('gallery.loadError')) }
  const closeReport = (): void => { setReporting(null); setReason(''); setThanks(false) }
  const pluginName = (id: string): string => installed.find(p => p.id === id)?.name ?? others.find(p => p.id === id)?.name ?? id
  const filtered = search.trim() !== '' || plugin !== ''

  return (
    <section className="am-exgallery" aria-labelledby="am-gal-h">
      <div className="am-ghead">
        <div><h2 id="am-gal-h">{t('gallery.title')}</h2><p className="am-help">{t('gallery.intro')}</p></div>
        <div className="am-gctl">
          <div className="am-gseg" role="group" aria-label={t('gallery.sortBy')}>
            {(['popular', 'new'] as const).map(k => <button key={k} type="button" aria-pressed={sort === k} onClick={() => setSort(k)}>{t(k === 'popular' ? 'gallery.sortPopular' : 'gallery.sortNew')}</button>)}
          </div>
          <div className="am-gsearch"><Icon name="search" size={16} /><input type="search" aria-label={t('gallery.search')} placeholder={t('gallery.search')} value={typed} onChange={e => setTyped(e.target.value)} />
            {typed ? <button type="button" className="am-gclear" aria-label={t('gallery.searchClear')} onClick={() => { setTyped(''); setSearch('') }}><Icon name="close" size={14} /></button> : null}</div>
          <button type="button" className="am-gfilterbtn" aria-expanded={filters} aria-controls="am-gfilters" onClick={() => setFilters(v => !v)}><Icon name="sliders" size={16} />{t('gallery.filter')}{plugin !== '' ? <span className="am-gbadge">1</span> : null}</button>
          <div id="am-gfilters" className={`am-gfilters${filters ? ' am-open' : ''}`}>
            <label className="am-sr" htmlFor="am-gplugin">{t('gallery.plugin')}</label>
            <select id="am-gplugin" value={plugin} onChange={e => setPlugin(e.target.value)} className={plugin !== '' ? 'am-active' : ''}>
              <option value="">{t('gallery.pluginAll')}</option>
              {installed.length > 0 ? <optgroup label={t('gallery.pluginYours')}>{installed.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup> : null}
              {others.length > 0 ? <optgroup label={t('gallery.pluginOthers')}>{others.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup> : null}
            </select>
          </div>
        </div>
      </div>

      {phase === 'ready' && items.length === 0 ? (
        <div className="am-gnone">
          <p><strong>{filtered ? t('gallery.noMatch', { query: search.trim() || pluginName(plugin) }) : t('gallery.noMatch', { query: '' })}</strong>{plugin !== '' && search.trim() !== '' ? ` ${t('gallery.noMatchPlugin', { plugin: pluginName(plugin) })}` : ''}</p>
          <p className="am-help">{t('gallery.noMatchHint')}</p>
          <div className="am-actions"><button type="button" onClick={() => { setTyped(''); setSearch('') }}>{t('gallery.searchClear')}</button>{plugin !== '' ? <button type="button" onClick={() => setPlugin('')}>{t('gallery.searchAll')}</button> : null}</div>
        </div>
      ) : (
        <ul className="am-ggrid" aria-busy={phase === 'first' || phase === 'more'}>
          {items.map((it, i) => {
            const shown = it.plugins.slice(0, 2), extra = it.plugins.length - shown.length
            return (
              <li key={it.id}>
                <article className="am-gcard" aria-labelledby={`am-gt-${it.id}`}>
                  <a className="am-gpic" href={it.link || it.picture} tabIndex={-1} aria-hidden="true" onClick={e => { e.preventDefault(); onOpen(it) }}>
                    <img src={it.picture} alt="" width={320} height={220} loading={i < 4 ? 'eager' : 'lazy'} decoding="async" />
                    {it.official ? <span className="am-gofficial">AtelierMesh</span> : null}
                    <span className="am-gopen">{t('gallery.openChange')}</span>
                  </a>
                  <div className="am-gbody">
                    <h3 id={`am-gt-${it.id}`}><a href={it.link || it.picture} onClick={e => { e.preventDefault(); onOpen(it) }}>{it.name}</a></h3>
                    {it.author ? <p className="am-gby">{t('gallery.by', { name: it.author })}</p> : null}
                    {sources.length > 1 && it.catalogue ? <p className="am-gby am-gcat">{it.catalogue}</p> : null}
                    {shown.length > 0 ? (
                      <div className="am-gchips">
                        {shown.map(p => have.has(p.id)
                          ? <button key={p.id} type="button" className="am-gchip" title={t('gallery.moreWith', { plugin: p.name })} onClick={() => setPlugin(p.id)}>{p.name}</button>
                          : <span key={p.id} className="am-gchip am-gneeds"><Icon name="puzzle" size={12} />{t('gallery.needs', { plugin: p.name })}</span>)}
                        {extra > 0 ? <span className="am-gchip am-gextra">+{extra}</span> : null}
                      </div>
                    ) : null}
                    <div className="am-gfoot1">
                      <span className="am-help">{t('gallery.opened', { count: shortCount(it.opens, lang) })}</span>
                      <span className="am-gacts">
                        <button type="button" className="am-gshare" aria-label={`${t('gallery.share')}: ${it.name}`} title={t('gallery.share')} onClick={() => void share(it)}><Icon name="share" size={18} /></button>
                        <span className="am-gmenuwrap">
                          <button type="button" className="am-gmore" aria-haspopup="menu" aria-expanded={menu === it.id} aria-label={t('gallery.moreActions', { name: it.name })} onClick={() => setMenu(menu === it.id ? null : it.id)}><Icon name="dots" size={18} /></button>
                          {menu === it.id ? (
                            <div className="am-gmenu" role="menu">
                              <button type="button" role="menuitem" onClick={() => void copy(it)}><Icon name="link" size={16} />{t('gallery.copyLink')}</button>
                              <button type="button" role="menuitem" onClick={() => { setMenu(null); setReporting(it) }}><Icon name="flag" size={16} />{t('gallery.report')}</button>
                            </div>
                          ) : null}
                        </span>
                      </span>
                    </div>
                  </div>
                </article>
              </li>
            )
          })}
          {phase === 'first' || phase === 'more' ? [0, 1, 2, 3].map(i => <li key={`sk${i}`} className="am-gskel" aria-hidden="true"><div className="am-gcard"><div className="am-gpic" /><div className="am-gbody"><div className="am-gline" /><div className="am-gline am-short" /></div></div></li>) : null}
        </ul>
      )}

      {items.length > 0 ? (
        <div className="am-gfoot">
          <div ref={sentinel} className="am-gsentinel" />
          {more || phase === 'error' ? (
            <>
              <p className="am-help">{t('gallery.shown', { shown: items.length, count: total })}</p>
              <span className="am-gbar" role="presentation"><span style={{ width: `${Math.round((items.length / Math.max(1, total)) * 100)}%` }} /></span>
              {phase === 'error' ? <p className="am-gerr" role="alert"><Icon name="refresh" size={16} />{t('gallery.loadError')} <button type="button" className="am-link" onClick={() => void load(false)}>{t('gallery.tryAgain')}</button></p> : null}
              <button type="button" disabled={phase === 'more'} aria-busy={phase === 'more'} onClick={() => void load(false)}>{phase === 'more' ? t('gallery.loading') : t('gallery.showMore', { count: Math.min(24, Math.max(0, total - items.length)) })}</button>
            </>
          ) : (
            <div className="am-gend"><strong>{t('gallery.endTitle', { count: total })}</strong><p className="am-help">{t('gallery.endText')}</p>
              <button type="button" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}><Icon name="arrowUp" size={16} />{t('gallery.endTop')}</button></div>
          )}
        </div>
      ) : null}
      <div className="am-sr" role="status" aria-live="polite">{announce}</div>

      {reporting ? (
        <Dialog title={thanks ? t('report.thanks') : t('report.title')} onClose={closeReport} t={t}>
          {thanks ? (
            <><p>{t('report.thanksText')}</p><div className="am-actions"><button type="button" className="am-primary" data-autofocus onClick={closeReport}>{t('settings.close')}</button></div></>
          ) : (
            <>
              <p><strong>{reporting.name}</strong></p>
              <fieldset className="am-choices"><legend>{t('report.why')}</legend>
                {REPORT_REASONS.map(k => <label key={k} className="am-choice"><input type="radio" name="am-report" checked={reason === k} onChange={() => setReason(k)} /><span>{t(REASON_KEY[k])}</span></label>)}
              </fieldset>
              <p className="am-help">{t('report.private')}</p>
              <div className="am-actions"><button type="button" onClick={closeReport}>{t('open.cancel')}</button><button type="button" className="am-primary" disabled={reason === ''} onClick={() => void send()}>{t('report.send')}</button></div>
            </>
          )}
        </Dialog>
      ) : null}
    </section>
  )
}
