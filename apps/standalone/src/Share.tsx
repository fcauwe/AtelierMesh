// Sharing a design as an example: the form (one screen), what happens after sending, and the list of what you shared (its state, a link, and taking it back).
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Dialog, Icon } from '@ateliermesh/react'
import { sharedLink } from './shared'
import type { SendResult, SharedRecord } from './shared'

type T = (key: string, values?: Record<string, string | number>) => string
export type Angle = '3d' | 'front' | 'top'
const kb = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

export interface ShareDialogProps {
  t: T
  /** The design's name (the form starts with it) and what is in the file: the model, the steps, the stored drawings. */
  name: string
  fileName: string
  size: number
  steps: number
  stored: string[]
  /** Draws the picture from one side (the browser does, with the same camera and look for every example); null when it cannot. */
  makePicture: (angle: Angle) => Promise<Uint8Array | null>
  send: (fields: { name: string; line: string; author: string }, picture: Uint8Array) => Promise<SendResult>
  /** Told when the design was sent, so the list of shared designs knows it. */
  onSent: (r: { id: string; key: string; name: string }) => void
  onClose: () => void
}

export function ShareDialog({ t, name, fileName, size, steps, stored, makePicture, send, onSent, onClose }: ShareDialogProps): ReactElement {
  const [angle, setAngle] = useState<Angle>('3d')
  const [picture, setPicture] = useState<Uint8Array | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [drawing, setDrawing] = useState(true)
  const [form, setForm] = useState({ name, line: '', author: '' })
  const [consent, setConsent] = useState(false)
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState('')
  const [sent, setSent] = useState(false)
  const gen = useRef(0)

  useEffect(() => {
    const n = ++gen.current
    setDrawing(true)
    void makePicture(angle).then(p => {
      if (n !== gen.current) return
      setPicture(p); setDrawing(false)
      setUrl(old => { if (old) URL.revokeObjectURL(old); return p ? URL.createObjectURL(new Blob([p as BlobPart], { type: 'image/png' })) : null })
    })
  }, [angle])
  useEffect(() => () => { gen.current++; setUrl(old => { if (old) URL.revokeObjectURL(old); return null }) }, [])

  const submit = async (): Promise<void> => {
    if (!picture || !consent || sending || form.name.trim() === '') return
    setSending(true); setProblem('')
    const r = await send({ name: form.name.trim(), line: form.line.trim(), author: form.author.trim() }, picture)
    setSending(false)
    if (r.ok) { onSent({ id: r.id, key: r.key, name: form.name.trim() }); setSent(true) }
    else setProblem(t(`share.error.${r.error}`))
  }

  if (sent) {
    return (
      <Dialog title={t('share.title')} onClose={onClose} t={t}>
        <p className="am-okbox" role="status"><Icon name="check" size={18} /> <strong>{t('share.thanks')}</strong></p>
        <p><span className="am-pill am-pill-wait"><Icon name="clock" size={14} /> {t('share.waiting')}</span></p>
        <p className="am-help">{t('share.whereLater')}</p>
        <p className="am-help">{t('share.keyNote')}</p>
        <div className="am-actions"><button type="button" className="am-primary" data-autofocus onClick={onClose}>{t('common.done')}</button></div>
      </Dialog>
    )
  }
  return (
    <Dialog title={t('share.title')} onClose={onClose} wide t={t}>
      <form onSubmit={e => { e.preventDefault(); void submit() }} className="am-shareform">
        <div className="am-sharepic">
          <div className="am-sharepic-box" aria-busy={drawing}>{url ? <img src={url} alt="" width={240} height={160} /> : <span className="am-help">{drawing ? t('gallery.loading') : t('share.error.picture')}</span>}</div>
          <div className="am-gseg" role="group" aria-label={t('share.picture')}>
            {(['3d', 'front', 'top'] as const).map(a => <button key={a} type="button" aria-pressed={angle === a} onClick={() => setAngle(a)}>{t(`share.angle.${a}`)}</button>)}
          </div>
          <p className="am-help">{t('share.pictureHint')}</p>
        </div>
        <div className="am-field"><label htmlFor="am-sh-name">{t('share.name')}</label><input id="am-sh-name" type="text" required maxLength={80} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></div>
        <div className="am-field"><label htmlFor="am-sh-line">{t('share.line')} <span className="am-help">({t('share.optional')}, {form.line.length} / 80)</span></label><input id="am-sh-line" type="text" maxLength={80} placeholder={t('share.linePh')} value={form.line} onChange={e => setForm(f => ({ ...f, line: e.target.value }))} /></div>
        <div className="am-field"><label htmlFor="am-sh-author">{t('share.author')} <span className="am-help">({t('share.optional')})</span></label><input id="am-sh-author" type="text" maxLength={60} aria-describedby="am-sh-author-h" value={form.author} onChange={e => setForm(f => ({ ...f, author: e.target.value }))} /><p className="am-help" id="am-sh-author-h">{t('share.authorHint')}</p></div>
        <div className="am-sharebox">
          <strong><Icon name="archive" size={16} /> {t('share.inside')}</strong>
          <ul>
            <li>{t('share.insideModel', { file: fileName, size: kb(size) })}</li>
            {steps > 0 ? <li>{t('share.insideSteps', { count: steps })}</li> : null}
            {stored.length > 0 ? <li>{t('share.insideStored', { names: stored.join(', ') })}</li> : null}
          </ul>
          <p className="am-help">{t('share.insideAfter')}</p>
        </div>
        <label className="am-choice"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} /><span>{t('share.consent')} <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">{t('share.licence')}</a></span></label>
        {problem ? <p className="am-problem" role="alert">{problem}</p> : null}
        <p className="am-help">{t('share.check')}</p>
        <div className="am-actions"><button type="button" onClick={onClose}>{t('open.cancel')}</button><button type="submit" className="am-primary" disabled={!consent || !picture || sending || form.name.trim() === ''}>{t('share.send')}</button></div>
      </form>
    </Dialog>
  )
}

/** What the person shared: the state of each (waiting, shared, not accepted, removed), a link to a listed one, and taking one back. Nothing is shown when nothing was shared. */
export function SharedList({ t, records, say, onRemove, onForget }: { t: T; records: SharedRecord[]; say: (text: string) => void; onRemove: (r: SharedRecord) => Promise<boolean>; onForget: (id: string) => void }): ReactElement | null {
  const [asking, setAsking] = useState<SharedRecord | null>(null)
  if (records.length === 0) return null
  const copy = async (r: SharedRecord): Promise<void> => { const u = sharedLink(r); try { await navigator.clipboard.writeText(u); say(t('gallery.linkCopied')) } catch { say(u) } }
  const stateOf = (r: SharedRecord): ReactElement => r.state === 'pending' ? <span className="am-pill am-pill-wait"><Icon name="clock" size={14} /> {t('share.waiting')}</span>
    : r.state === 'accepted' ? <span className="am-pill am-pill-live"><Icon name="share" size={14} /> {t('share.live')}</span>
    : r.state === 'rejected' ? <span className="am-pill am-pill-no">{t('share.notAccepted')}{r.reason ? `: ${r.reason}` : ''}</span>
    : <span className="am-pill">{t('share.gone')}</span>
  return (
    <section className="am-card am-sharedlist" aria-label={t('share.mine')}>
      <h2>{t('share.mine')}</h2>
      <ul className="am-list">
        {records.map(r => (
          <li key={r.id}>
            <div className="am-grow"><strong>{r.name}</strong><span>{stateOf(r)}</span></div>
            {r.state === 'accepted' ? <button type="button" aria-label={`${t('gallery.copyLink')}: ${r.name}`} onClick={() => void copy(r)}><Icon name="link" size={16} /></button> : null}
            {r.state === 'pending' || r.state === 'accepted' ? <button type="button" className="am-danger" aria-label={`${t('share.remove')}: ${r.name}`} onClick={() => setAsking(r)}>{t('share.remove')}</button>
              : <button type="button" aria-label={`${t('catalogues.remove')}: ${r.name}`} onClick={() => onForget(r.id)}>{t('catalogues.remove')}</button>}
          </li>
        ))}
      </ul>
      {asking ? (
        <Dialog title={t('share.removeTitle', { name: asking.name })} onClose={() => setAsking(null)} strict t={t}>
          <p>{t('share.removeText')}</p>
          <div className="am-actions">
            <button type="button" data-autofocus onClick={() => setAsking(null)}>{t('share.removeKeep')}</button>
            <button type="button" className="am-danger" onClick={() => { const r = asking; setAsking(null); void onRemove(r) }}>{t('share.removeYes')}</button>
          </div>
        </Dialog>
      ) : null}
    </section>
  )
}
