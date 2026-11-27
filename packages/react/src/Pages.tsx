// Screens around the editor that the standalone app and the Atelier's /upload-3d page both need: the upload page, the units step, the load checks,
// the list of saved configurations and the "cannot run here" view. They show and report; the host reads the files, measures the mesh and keeps the storage.
import { useId, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Dialog, fileAccept, tx } from './common'
import type { T } from './common'
import { Icon } from './icons'

// ---------------------------------------------------------------------------------------------------- upload page
export interface SavedItem { id: string; name: string; updated: number; size: number; /** The project's preview picture (an object URL or data URL); without it a neutral placeholder is drawn. */ image?: string }

/** The small picture in front of a saved configuration. */
function SavedThumb({ image }: { image?: string }): ReactElement {
  return <span className="am-saved-thumb" aria-hidden="true">{image ? <img src={image} alt="" width={96} height={64} /> : <span className="am-saved-ph" />}</span>
}
export interface SampleItem { id: string; name: string; /** A short line under the name, for example the steps the sample starts with. */ note?: string; /** A render image of the model (see `useThumbnails`); without it the card shows the name only. */ image?: string }

export interface UploadPageProps {
  t: T
  /** `A`: standalone (STL, 3MF or saved configuration). `B`: the designer in the Atelier (STL or 3MF). */
  journey: 'A' | 'B'
  samples?: SampleItem[]
  /** Configurations kept in this browser, newest first. */
  saved?: SavedItem[]
  /** The example gallery of the standalone app: shown after the saved list, full width. The host passes `samples` only while it has no gallery to show. */
  examples?: ReactNode
  onFile: (file: File) => void
  onSample?: (id: string) => void
  onOpenSaved?: (id: string) => void
  /** Opens the list dialog with every saved configuration (shown when there are more than the page lists). */
  onShowSaved?: () => void
  /** Say that everything runs in the browser and nothing is sent to a server. On by default for the standalone (journey A); the Atelier sends the file to its server, so it leaves it off. */
  privacy?: boolean
  /** Content for the top of the page, for example the host's own recent uploads. */
  children?: ReactNode
}

export function UploadPage({ t, journey, samples = [], saved = [], examples, onFile, onSample, onOpenSaved, onShowSaved, privacy, children }: UploadPageProps): ReactElement {
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const accept = fileAccept(journey === 'A' ? '.stl,.3mf,.amproj,model/stl,model/3mf' : '.stl,.3mf,model/stl,model/3mf')
  const pick = (f: File | undefined): void => { if (f) onFile(f) }
  const shown = saved.slice(0, 5)
  return (
    <main className="am-page">
      <div className="am-page-in">
        <div>
          <h1>{t('upload.title')}</h1>
          <p className="am-lead">{t(journey === 'A' ? 'upload.leadA' : 'upload.leadB')}</p>
        </div>
        <div className={`am-drop${over ? ' am-over' : ''}`} onDragOver={e => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
          onDrop={e => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files[0]) }}>
          <strong>{t('upload.drop')}</strong>
          <span className="am-help">{t(journey === 'A' ? 'upload.formatsA' : 'upload.formatsB')}</span>
          <button type="button" className="am-primary" onClick={() => input.current?.click()}>{t('upload.browse')}</button>
          <input ref={input} type="file" accept={accept} className="am-visually-hidden" aria-label={t('upload.browse')} tabIndex={-1} onChange={e => { pick(e.target.files?.[0]); e.target.value = '' }} />
        </div>
        {(privacy ?? journey === 'A') ? <p className="am-privacy"><Icon name="lock" size={16} /><span>{t('upload.privacy')}</span></p> : null}
        {children}
        <div className="am-grid2">
          {samples.length > 0 ? (
            <section className="am-card" aria-label={t('upload.samples')}>
              <h2>{t('upload.samples')}</h2>
              <div className="am-samples">{samples.map((s, i) => <button key={s.id} type="button" className="am-sample" onClick={() => onSample?.(s.id)}>{s.image ? <img src={s.image} alt="" width={320} height={220} loading={i < 2 ? 'eager' : 'lazy'} decoding="async" /> : null}<span>{s.name}</span>{s.note ? <small className="am-sample-note">{s.note}</small> : null}</button>)}</div>
            </section>
          ) : null}
          {journey === 'A' ? (
            <section className={`am-card am-savedcard${shown.length === 0 ? ' am-savedempty' : ''}`} aria-label={t('upload.saved')}>
              <h2>{t('upload.saved')}{saved.length > 0 && onShowSaved ? <button type="button" className="am-link" onClick={onShowSaved}>{t('upload.savedAll')}</button> : null}</h2>
              {shown.length === 0 ? <p className="am-help">{t('upload.savedEmpty')}</p> : (
                <ul className="am-list">
                  {shown.map(s => (
                    <li key={s.id}>
                      <SavedThumb {...(s.image ? { image: s.image } : {})} />
                      <div className="am-grow"><strong>{s.name}</strong><span>{new Date(s.updated).toLocaleString()} · {Math.round(s.size / 1024)} KB</span></div>
                      <button type="button" aria-label={`${t('upload.open')} ${s.name}`} onClick={() => onOpenSaved?.(s.id)}>{t('upload.open')}</button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
        </div>
        {examples}
      </div>
    </main>
  )
}

// ---------------------------------------------------------------------------------------------------- units step
export type FileUnit = 'mm' | 'inch'
export interface UnitsDialogProps {
  t: T
  /** The size in millimetres if the file is read in this unit. */
  size: (unit: FileUnit) => [number, number, number]
  /** The size looks like inches (the host asks `unitHint`). */
  suspect: boolean
  onContinue: (unit: FileUnit) => void
  onBack: () => void
}

const r1 = (v: number): number => Math.round(v * 10) / 10

export function UnitsDialog({ t, size, suspect, onContinue, onBack }: UnitsDialogProps): ReactElement {
  const [unit, setUnit] = useState<FileUnit>('mm')
  const name = useId()
  const s = size(unit)
  const text = t('units.size', { x: r1(s[0]), y: r1(s[1]), z: r1(s[2]) })
  return (
    <Dialog title={t('units.title')} onClose={onBack} strict t={t}>
      <p>{t('units.lead')}</p>
      <fieldset className="am-choices">
        <legend className="am-label">{t('units.label')}</legend>
        {(['mm', 'inch'] as const).map(u => (
          <label key={u} className="am-choice"><input type="radio" name={name} value={u} checked={unit === u} onChange={() => setUnit(u)} /> <span>{t(u === 'mm' ? 'units.mm' : 'units.inch')}</span></label>
        ))}
      </fieldset>
      <p className="am-sizebox" role="status" id="units-size">{text}</p>
      {suspect ? (
        <div className={unit === 'mm' ? 'am-flag' : 'am-okbox'} id="units-hint">
          <p>{unit === 'mm' ? t('units.flag') : `${t('units.confirmed')} ${text}`}</p>
          <button type="button" onClick={() => setUnit(unit === 'mm' ? 'inch' : 'mm')}>{t(unit === 'mm' ? 'units.readAsInch' : 'units.undoInch')}</button>
        </div>
      ) : null}
      <div className="am-actions">
        <button type="button" onClick={onBack}>{t('units.back')}</button>
        <button type="button" className="am-primary" data-autofocus onClick={() => onContinue(unit)}>{t('units.continue')}</button>
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------------------------------- load checks
export interface LoadCheckDialogProps {
  t: T
  kind: 'triangles' | 'toolarge' | 'manifold' | 'unreadable'
  /** `triangles` and `toolarge`: how many the file has, how many the browser edits, and what a simplification aims for. */
  count?: number
  max?: number
  target?: number
  onSimplify?: () => void
  onOpenAnyway?: () => void
  /** `manifold`: "Repair it", which opens the file with a Repair mesh step first. Offered only when the host has the repair plugin. */
  onRepair?: () => void
  /** `manifold`: the file has no openings, only edges that three or more triangles share (parts that touch along a line): the text says so instead of "openings". */
  touching?: boolean
  /** "Choose another file". */
  onOther: () => void
}

export function LoadCheckDialog({ t, kind, touching = false, count = 0, max = 0, target = 0, onSimplify, onOpenAnyway, onRepair, onOther }: LoadCheckDialogProps): ReactElement {
  const title = kind === 'unreadable' ? t('check.unreadable.title') : kind === 'manifold' ? t('check.manifold.title') : t('check.triangles.title')
  // a file beyond what can be read at all cannot be simplified here: drop the sentence that offers it
  const body = kind === 'unreadable' ? t('check.unreadable.body') : kind === 'manifold' ? (touching
      ? (onRepair ? tx(t, 'check.manifold.touchingRepair', 'Some parts of it touch along an edge, so it can\'t be printed as it is. We can try to fix that here, or you can repair it in your 3D program or choose another file.') : tx(t, 'check.manifold.touching', 'Some parts of it touch along an edge, so it can\'t be printed as it is. Repair it in your 3D program, or choose another file.'))
      : onRepair ? tx(t, 'check.manifold.bodyRepair', t('check.manifold.body')) : t('check.manifold.body'))
    : kind === 'toolarge' ? t('check.triangles.body', { count, max, target }).replace(/ We can simplify[^.]*\./, '') : t('check.triangles.body', { count, max, target })
  return (
    <Dialog title={title} onClose={onOther} strict t={t}>
      <p>{body}</p>
      {kind === 'manifold' ? <p className="am-help">{t('check.manifold.anywayHint')}</p> : null}
      <div className="am-actions">
        <button type="button" className={kind === 'unreadable' || kind === 'toolarge' ? 'am-primary' : ''} onClick={onOther}>{t('check.other')}</button>
        {kind === 'triangles' && onSimplify ? <button type="button" className="am-primary" onClick={onSimplify}>{t('check.triangles.simplify', { target })}</button> : null}
        {kind === 'manifold' && onRepair ? <button type="button" className="am-primary" onClick={onRepair}>{tx(t, 'check.repair', 'Repair it')}</button> : null}
        {kind === 'manifold' && onOpenAnyway ? <button type="button" className={onRepair ? '' : 'am-primary'} onClick={onOpenAnyway}>{t('check.manifold.openAnyway')}</button> : null}
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------------------------------- saved configurations
export interface ProjectListDialogProps {
  t: T
  items: SavedItem[]
  /** The browser refused storage: shown instead of the list. */
  error?: string | null
  onOpen: (id: string) => void
  onDelete: (id: string, name: string) => void
  onClose: () => void
}

export function ProjectListDialog({ t, items, error, onOpen, onDelete, onClose }: ProjectListDialogProps): ReactElement {
  return (
    <Dialog title={t('upload.saved')} onClose={onClose} wide t={t}>
      <p className="am-help">{tx(t, 'upload.savedNote', 'They stay in this browser only. Clearing site data removes them; download a .amproj file to keep one.')}</p>
      {error ? <p className="am-error-text" role="alert">{error}</p> : items.length === 0 ? <p>{t('upload.savedEmpty')}</p> : (
        <ul className="am-list">
          {items.map(s => (
            <li key={s.id}>
              <SavedThumb {...(s.image ? { image: s.image } : {})} />
              <div className="am-grow"><strong>{s.name}</strong><span>{new Date(s.updated).toLocaleString()} · {Math.round(s.size / 1024)} KB</span></div>
              <button type="button" aria-label={`${t('upload.open')} ${s.name}`} onClick={() => onOpen(s.id)}>{t('upload.open')}</button>
              <button type="button" className="am-danger" aria-label={`${t('editor.delete')} ${s.name}`} onClick={() => onDelete(s.id, s.name)}>{t('editor.delete')}</button>
            </li>
          ))}
        </ul>
      )}
      <div className="am-actions"><button type="button" className="am-primary" onClick={onClose}>{t('plugins.close')}</button></div>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------------------------------- cannot run here
export interface CannotRunProps {
  t: T
  kind: 'webgl' | 'memory' | 'worker'
  /** `webgl`: copy the link to this page. `memory` and `worker`: reload. The host does it. */
  onAction: () => void | Promise<void>
}

export function CannotRunView({ t, kind, onAction }: CannotRunProps): ReactElement {
  const [done, setDone] = useState(false)
  return (
    <main className="am-cannot" role="alert">
      <div className="am-cannot-in">
        <h1>{t(`cannot.${kind}.title`)}</h1>
        <p>{t(`cannot.${kind}.body`)}</p>
        <button type="button" className="am-primary" onClick={() => { void Promise.resolve(onAction()).then(() => { if (kind === 'webgl') setDone(true) }) }}>
          {done ? t('cannot.copied') : t(kind === 'webgl' ? 'cannot.webgl.action' : 'cannot.reload')}
        </button>
      </div>
    </main>
  )
}
