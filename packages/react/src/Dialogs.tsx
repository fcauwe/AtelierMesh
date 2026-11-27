// The dialogs of the editor: plugin manager, leave with unsaved changes, settings. They show and report; the host does the work
// (loading a package, saving, remembering a setting) because it owns storage, the network and the loader.
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'
import { httpsUrlProblem, isValidEmail } from '@ateliermesh/core'
import { Dialog, fileAccept, tx } from './common'
import type { T } from './common'
import { Icon } from './icons'

// ---------------------------------------------------------------------------------------------------- plugin manager
export interface PluginRow {
  id: string
  name: string
  version: string
  builtIn: boolean
  /** Number of steps in the list that use it. */
  usedBy: number
  signed?: boolean
  signer?: string
  origin?: string
  /** The last run stopped with an error inside this plugin. */
  failed?: boolean
  /** The plugin is switched off. `crashed`: the engine did it because the plugin stopped working; `reason` is the first line of the error. */
  disabled?: { reason: string; crashed: boolean }
  /** From the manifest. Plain text: it is never shown as markup. */
  description?: string
  license?: string
  contact?: PluginContactInfo
  /** The https address the package can be fetched from again (manifest `package_url`, or the address it was loaded from). Only the host name is shown. */
  packageUrl?: string
  /** The package is kept in this browser: its size in bytes and when it was added (milliseconds). */
  stored?: { size: number; added: number }
  /** A stored package that was not started again because it failed a check; the reason is shown. It is kept, not deleted. */
  notStarted?: string
  /** The example picture (from the manifest `image`): a ready address (an object URL or a path inside the app) and its alt text. Absent: the card shows a placeholder. */
  image?: { url: string; alt: string }
  /** Names of the operations the plugin brings, for the gallery's details. */
  operations?: string[]
}
export interface PluginContactInfo { url?: string; email?: string; name?: string }

/** What the person is asked to approve: a new plugin, a replacement, or an update. Plain data; every text in it is shown as text. */
export interface PluginApproval {
  kind: 'install' | 'update'
  name: string
  version: string
  /** The version that is installed now, when this replaces one. */
  installedVersion?: string
  description?: string
  license?: string
  contact?: PluginContactInfo
  signed: boolean
  signer?: string
  /** For an update of a signed plugin: whether the new package is signed by the same trusted key as the installed one. */
  signerCheck?: 'same' | 'other' | 'lost'
  /** Same version number as the installed one but another checksum. */
  sameVersionNewChecksum?: boolean
  permissions: string[]
  origin: string
  /** Replaces a plugin with the same id (a different file). */
  replace: boolean
  /** The package's example picture, as an address the host made from the checked bytes (revoke it when the dialog is gone). */
  image?: { url: string; alt: string }
}
export interface TrustedKey { name: string; publicKey: string }

/** One plugin of a catalog, as the manager shows it: the newest version. Every text is plain text. */
export interface CatalogItem { id: string; name: string; version: string; description?: string; license?: string; contact?: PluginContactInfo; image?: { url: string; alt: string }; size?: number; /** How many times it was downloaded from the catalog (public, counted by the catalog). Shown when there is one. */ downloads?: number; /** Ids of plugins it replaces: shown, and used to say which plugin replaces a missing one. */ replaces?: string[] }
/**
 * A catalog of plugins the person can search and install from, supplied by the host (the standalone app reads one from its own server; the Atelier can bring another).
 * The manager only shows it and calls back: fetching, checking the checksum and asking for approval are the host's work. Nothing is fetched by the manager itself.
 */
export interface PluginCatalogHost {
  /** loading: being fetched now; ready: `items` is the list; unavailable: it could not be read (no catalog on this server, no connection). */
  status: 'loading' | 'ready' | 'unavailable'
  /** Where it comes from, as a host name (text, shown to the person). */
  source?: string
  items: CatalogItem[]
  /** For installed plugins that have a newer version in the catalog: the plugin id → the newest version. */
  updates: Record<string, string>
  /** The id of the plugin whose package is being fetched now. */
  busy?: string | null
  /** Install the newest version of a plugin (also used for "Update"). The host shows the usual approval before anything is added. */
  onInstall: (id: string) => void
  /** Called once each time the manager opens: the host loads the catalog then (and never in the background). */
  onOpen?: () => void
  onRetry?: () => void
}

export interface PluginManagerProps {
  t: T
  plugins: PluginRow[]
  keys?: TrustedKey[]
  /** The result of the last load, shown under the form ("Loaded x 1.2.0 (signed by y)."), or the reason it failed. */
  note?: { kind: 'ok' | 'error'; text: string } | null
  onLoadFile: (file: File) => void
  onLoadUrl: (url: string) => void
  onRemove: (id: string) => void
  /** Whether this browser keeps installed plugins (false in a private window), and how many of how many are kept. */
  storage?: { available: boolean; count: number; max: number }
  /** The file to approve, shown over the manager until approved or cancelled. */
  approval?: PluginApproval | null
  onApprove?: () => void
  onCancelApproval?: () => void
  /** Give the stored package back as a file. */
  onDownload?: (id: string) => void
  /** Send a stored plugin to the catalogue: an admin checks it before it is listed. Absent: no button. */
  onShare?: (id: string) => void
  /** Fetch the package from its address again and ask (only when the person clicks; nothing is fetched by itself). */
  onCheckUpdate?: (id: string) => void
  /** The id of the plugin whose update is being fetched now. */
  checking?: string | null
  /** Switch a plugin off or on (any plugin, built in or not). When absent the dialog shows the state only. */
  onToggle?: (id: string, enabled: boolean) => void
  onTrust?: (name: string, publicKey: string) => void
  onForget?: (name: string) => void
  /**
   * "Build your own plugin": an info panel inside the dialog. Absent: no entry. `guideUrl` is the full guide (opens in a new tab), `promptText` is the prompt
   * for the person's own coding agent (a Copy button; without a clipboard the text is shown to select), `exampleUrl` is a ready, packed example plugin to try the loader with, `kitUrl` is the plugin developer kit (a zip with the guide, the example's source, the packages and the packing tool).
   */
  build?: { guideUrl?: string; promptText?: string; promptTextNoNpm?: string; exampleUrl?: string; kitUrl?: string }
  /** How the plugins are shown: a list (default) or a gallery of cards. With `onView` the dialog offers the switch; the host keeps the choice. */
  view?: 'list' | 'gallery'
  onView?: (v: 'list' | 'gallery') => void
  /** A catalog to search in, under "Add a plugin", and the "Update available" marks on installed plugins. Absent: no catalog section. */
  catalog?: PluginCatalogHost
  /** The manager is the Plugins tab of the settings: the dialog is titled Settings and shows the tab bar; `onSelect` switches to another tab (the host swaps the dialog). */
  tabs?: { onSelect: (tab: SettingsTab) => void }
  onClose: () => void
}

export function PluginManager(p: PluginManagerProps): ReactElement {
  const { t } = p
  const [url, setUrl] = useState('')
  const [kn, setKn] = useState(''), [kv, setKv] = useState('')
  const [view, setView] = useState<'list' | 'add' | 'build'>('list')
  const [fromAdd, setFromAdd] = useState(false)   // the focus returns to the "Add plugin" button when the add screen is closed
  const [cameBack, setCameBack] = useState(false)   // the focus returns to the "Build your own plugin" button when the info panel is closed
  const [removing, setRemoving] = useState<PluginRow | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [openCard, setOpenCard] = useState<string | null>(null)
  const gallery = p.view === 'gallery'
  const [catalogQuery, setCatalogQuery] = useState('')
  const openCatalog = p.catalog?.onOpen
  useEffect(() => { openCatalog?.() }, [])   // once per opening of the manager
  if (p.approval) return <ApprovalDialog t={t} a={p.approval} onApprove={() => p.onApprove?.()} onCancel={() => p.onCancelApproval?.()} />
  if (removing) {
    const r = removing
    return (
      <Dialog title={tx(t, 'plugins.removeTitle', 'Remove this plugin?')} onClose={() => setRemoving(null)} t={t}>
        <p>{tx(t, 'plugins.removeBody', '\u201c{{name}}\u201d will be removed from this browser, and its stored file deleted. You can add the file again later.', { name: r.name })}</p>
        <div className="am-actions">
          <button type="button" data-autofocus onClick={() => setRemoving(null)}>{tx(t, 'plugins.removeCancel', 'Keep it')}</button>
          <button type="button" className="am-primary" onClick={() => { setRemoving(null); p.onRemove(r.id) }}>{tx(t, 'plugins.removeConfirm', 'Remove')}</button>
        </div>
      </Dialog>
    )
  }
  if (view === 'build' && p.build) return <BuildPanel t={t} build={p.build} onBack={() => { setCameBack(true); setView('add') }} />
  const copy = async (id: string, text: string): Promise<void> => { if (await copyText(text)) { setCopied(id); window.setTimeout(() => setCopied(c => (c === id ? null : c)), 2500) } }
  const toggleBtn = (pl: PluginRow): ReactElement | null => (
    <>
              {p.onToggle && !pl.notStarted ? <button type="button" aria-pressed={!pl.disabled} aria-label={`${pl.disabled ? tx(t, 'plugins.switchOn', 'Switch on') : tx(t, 'plugins.switchOff', 'Switch off')} ${pl.name}`} onClick={() => p.onToggle?.(pl.id, !!pl.disabled)}>{pl.disabled ? (pl.disabled.crashed ? tx(t, 'fix.switchOnAgain', 'Switch on again') : tx(t, 'plugins.switchOn', 'Switch on')) : tx(t, 'plugins.switchOff', 'Switch off')}</button> : null}
    </>
  )
  const actionBtns = (pl: PluginRow): ReactElement => (
    <>
                <span className="am-pluginbtns">
                  {pl.packageUrl && p.onCheckUpdate && !pl.notStarted ? <button type="button" disabled={p.checking === pl.id} aria-label={`${tx(t, 'plugins.checkUpdate', 'Check for update')} ${pl.name}`} onClick={() => p.onCheckUpdate?.(pl.id)}>{p.checking === pl.id ? tx(t, 'plugins.checking', 'Checking\u2026') : tx(t, 'plugins.checkUpdate', 'Check for update')}</button> : null}
                  {pl.packageUrl ? <button type="button" aria-label={`${tx(t, 'plugins.copyLink', 'Copy link')} ${pl.name}`} onClick={() => void copy(pl.id, pl.packageUrl ?? '')}>{copied === pl.id ? tx(t, 'plugins.copied', 'Link copied') : tx(t, 'plugins.copyLink', 'Copy link')}</button> : null}
                  {pl.stored && p.onShare ? <button type="button" aria-label={`${tx(t, 'plugins.share', 'Share with the catalogue')} ${pl.name}`} onClick={() => p.onShare?.(pl.id)}>{tx(t, 'plugins.share', 'Share with the catalogue')}</button> : null}
                  {pl.stored && p.onDownload ? <button type="button" aria-label={`${tx(t, 'plugins.download', 'Download')} ${pl.name}`} onClick={() => p.onDownload?.(pl.id)}>{tx(t, 'plugins.download', 'Download')}</button> : null}
                  <button type="button" disabled={pl.usedBy > 0} title={pl.usedBy > 0 ? t('plugins.removeBlocked') : undefined} aria-label={`${t('plugins.remove')} ${pl.name}`} onClick={() => setRemoving(pl)}>{t('plugins.remove')}</button>
                </span>
    </>
  )
  const newer = (pl: PluginRow): string | undefined => (pl.builtIn ? undefined : p.catalog?.updates[pl.id])
  const updateBtn = (pl: PluginRow): ReactElement | null => {
    const v = newer(pl)
    if (!v || !p.catalog) return null
    const cat = p.catalog
    const label = cat.busy === pl.id ? tx(t, 'plugins.catalog.fetching', 'Downloading\u2026') : tx(t, 'plugins.catalog.updateTo', 'Update to {{version}}', { version: v })
    return <button type="button" className="am-updatebtn" disabled={!!cat.busy} aria-label={`${label} ${pl.name}`} onClick={() => cat.onInstall(pl.id)}>{label}</button>
  }
  const info = (pl: PluginRow): ReactElement => (
    <>
                <PluginMeta t={t} description={pl.description} license={pl.license} contact={pl.contact} />
                {pl.usedBy > 0 ? <div className="am-help">{t('plugins.inUse', { count: pl.usedBy })}</div> : null}
                {pl.notStarted ? <div className="am-help am-bad" role="alert">{tx(t, 'plugins.notStarted', 'Kept in this browser but switched off, because it failed a check: {{reason}}', { reason: pl.notStarted })}</div> : null}
                {pl.stored ? <div className="am-help">{tx(t, 'plugins.stored', 'Stored in this browser ({{size}}, added {{date}})', { size: formatSize(pl.stored.size), date: formatDate(pl.stored.added) })}</div> : null}
                {pl.packageUrl ? <div className="am-help">{tx(t, 'plugins.updatesFrom', 'Updates from {{host}}', { host: hostOf(pl.packageUrl) })}</div> : null}
                {pl.failed ? <div className="am-help am-warn">{t('plugins.failedNote')}</div> : null}
                {pl.disabled ? <div className={`am-help ${pl.disabled.crashed ? 'am-bad' : ''}`} role={pl.disabled.crashed ? 'alert' : undefined}>{pl.disabled.crashed ? tx(t, 'plugins.crashed', 'Switched off because it stopped working: {{message}}', { message: pl.disabled.reason }) : tx(t, 'plugins.switchedOff', 'Switched off')}</div> : null}
                {pl.origin ? <div className="am-help">{/^https?:\/\//.test(pl.origin) ? hostOf(pl.origin) : pl.origin}</div> : null}
    </>
  )
  if (view === 'add') {
    return (
      <Dialog key="add" title={t('plugins.add')} onClose={() => { setFromAdd(true); setView('list') }} wider t={t}>
      {p.build ? (
        <div className="am-buildcard">
          <Icon name="book" size={20} />
          <div><strong>{tx(t, 'plugins.build.entryTitle', 'Want to make your own plugin?')}</strong><div className="am-help">{tx(t, 'plugins.build.entryHint', 'A short guide, an example and a prompt for your AI agent.')}</div></div>
          <button type="button" data-autofocus={cameBack ? true : undefined} onClick={() => setView('build')}>{tx(t, 'plugins.build.open', 'Build your own plugin')}</button>
        </div>
      ) : null}
      <div className="am-row">
        <label className="am-filebtn">{tx(t, 'plugins.file', 'Choose a plugin file')}<input type="file" accept={fileAccept('.amplugin,.zip,application/zip')} onChange={e => { const f = e.target.files?.[0]; if (f) p.onLoadFile(f); e.target.value = '' }} /></label>
      </div>
      <form className="am-row" onSubmit={e => { e.preventDefault(); if (url.trim()) { p.onLoadUrl(url.trim()); setUrl('') } }}>
        <label htmlFor="am-plugin-url">{tx(t, 'plugins.url', 'Plugin address (https)')}</label>
        <input id="am-plugin-url" type="url" value={url} onChange={e => setUrl(e.target.value)} />
        <button type="submit" disabled={!url.trim()}>{tx(t, 'plugins.load', 'Load')}</button>
      </form>
      {p.catalog ? <CatalogSection t={t} catalog={p.catalog} installed={p.plugins} query={catalogQuery} onQuery={setCatalogQuery} /> : null}
      {p.note ? <p className={p.note.kind === 'error' ? 'am-error-text' : 'am-help'} role={p.note.kind === 'error' ? 'alert' : 'status'}>{p.note.text}</p> : null}
      {p.onTrust ? (
        <details className="am-keys">
          <summary>{tx(t, 'plugins.keys', 'Trusted signers')}</summary>
          <ul>{(p.keys ?? []).map(k => <li key={k.name}>{k.name} <button type="button" aria-label={`${tx(t, 'plugins.forget', 'Forget')} ${k.name}`} onClick={() => p.onForget?.(k.name)}>{tx(t, 'plugins.forget', 'Forget')}</button></li>)}</ul>
          <form className="am-row" onSubmit={e => { e.preventDefault(); if (kn && kv) { p.onTrust?.(kn, kv.trim()); setKn(''); setKv('') } }}>
            <label htmlFor="am-key-name">{tx(t, 'plugins.keyName', 'Name')}</label><input id="am-key-name" value={kn} onChange={e => setKn(e.target.value)} />
            <label htmlFor="am-key-value">{tx(t, 'plugins.keyValue', 'Public key')}</label><input id="am-key-value" value={kv} onChange={e => setKv(e.target.value)} />
            <button type="submit" disabled={!kn || !kv}>{tx(t, 'plugins.trust', 'Trust this signer')}</button>
          </form>
        </details>
      ) : null}
        <div className="am-actions am-sticky"><button type="button" className="am-primary" onClick={() => { setFromAdd(true); setView('list') }}>{tx(t, 'plugins.back', 'Back to the plugins')}</button></div>
      </Dialog>
    )
  }
  return (
    <Dialog key="list" title={p.tabs ? t('settings.title') : t('plugins.title')} onClose={p.onClose} wider t={t}>
      {p.tabs ? <SettingsTabs t={t} current="plugins" onSelect={p.tabs.onSelect} /> : null}
      <div className="am-pluginhead"><button type="button" className="am-primary" data-autofocus={fromAdd ? true : undefined} onClick={() => setView('add')}><Icon name="plus" size={16} />{tx(t, 'plugins.addButton', 'Add plugin')}</button></div>
      {p.storage && !p.storage.available ? <p className="am-help am-warn" role="status">{tx(t, 'plugins.notStoredHere', 'This browser does not keep plugins (a private window?). They work until you close the page, then you add them again.')}</p> : null}
      {p.onView ? (
        <div className="am-viewswitch" role="group" aria-label={tx(t, 'plugins.viewLabel', 'Show plugins as')}>
          <button type="button" aria-pressed={!gallery} onClick={() => p.onView?.('list')}>{tx(t, 'plugins.viewList', 'List')}</button>
          <button type="button" aria-pressed={gallery} onClick={() => p.onView?.('gallery')}>{tx(t, 'plugins.viewGallery', 'Gallery')}</button>
        </div>
      ) : null}
      {p.plugins.some(x => x.builtIn) ? <p className="am-help">{t('plugins.builtInHint')}</p> : null}
      {p.plugins.length === 0 ? <p>{t('plugins.empty')}</p> : gallery ? (
        <ul className="am-gallery">
          {p.plugins.map(pl => (
            <li key={pl.id} className="am-card" data-plugin={pl.id}>
              {pl.image ? <img className="am-card-img" src={pl.image.url} alt={pl.image.alt} loading="lazy" decoding="async" /> : <div className="am-card-img am-card-none" aria-hidden="true"><Icon name="puzzle" size={32} /></div>}
              <div className="am-card-body">
                <div className="am-card-title"><strong>{pl.name}</strong> <span className="am-sub">{t('plugins.version', { version: pl.version })}</span></div>
                {pl.description ? <div className="am-card-desc">{pl.description}</div> : null}
                <div className="am-metaline">
                  {pl.license ? <span className="am-metalicence" title={tx(t, 'plugins.licenseTitle', 'Licence')}><span className="am-sr">{tx(t, 'plugins.licenseTitle', 'Licence')}: </span>{pl.license}</span> : null}
                  {pl.notStarted || pl.disabled ? <span className="am-chip">{tx(t, 'plugins.switchedOff', 'Switched off')}</span> : null}
                  {pl.builtIn ? <span className="am-chip">{t('plugins.builtIn')}</span> : null}
                  {newer(pl) ? <span className="am-chip am-update">{tx(t, 'plugins.catalog.updateAvailable', 'Update available: {{version}}', { version: newer(pl) ?? '' })}</span> : null}
                </div>
                {updateBtn(pl)}
                <button type="button" className="am-card-more" aria-expanded={openCard === pl.id} aria-label={`${openCard === pl.id ? tx(t, 'plugins.detailsHide', 'Hide details') : tx(t, 'plugins.details', 'Details')} ${pl.name}`} onClick={() => setOpenCard(c => (c === pl.id ? null : pl.id))}>{openCard === pl.id ? tx(t, 'plugins.detailsHide', 'Hide details') : tx(t, 'plugins.details', 'Details')}</button>
                {openCard === pl.id ? (
                  <div className="am-card-details">
                    {info(pl)}
                    {pl.operations && pl.operations.length > 0 ? <ul className="am-card-ops">{pl.operations.map(o => <li key={o}>{o}</li>)}</ul> : null}
                    <div className="am-pluginbtns">{toggleBtn(pl)}{pl.builtIn ? null : actionBtns(pl)}</div>
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="am-pluginlist">
          {p.plugins.map(pl => (
            <li key={pl.id}>
              <div>
                <strong>{pl.name}</strong> <span className="am-sub">{t('plugins.version', { version: pl.version })}</span>
                {pl.builtIn ? <span className="am-badge">{t('plugins.builtIn')}</span> : <span className="am-badge">{pl.signed ? tx(t, 'plugins.signed', 'Signed by {{signer}}', { signer: pl.signer ?? '' }) : tx(t, 'plugins.unsigned', 'Unsigned')}</span>}
                {newer(pl) ? <span className="am-badge am-update">{tx(t, 'plugins.catalog.updateAvailable', 'Update available: {{version}}', { version: newer(pl) ?? '' })}</span> : null}
                <PluginMeta t={t} description={pl.description} license={pl.license} contact={pl.contact} />
                {pl.usedBy > 0 ? <div className="am-help">{t('plugins.inUse', { count: pl.usedBy })}</div> : null}
                {pl.notStarted ? <div className="am-help am-bad" role="alert">{tx(t, 'plugins.notStarted', 'Kept in this browser but switched off, because it failed a check: {{reason}}', { reason: pl.notStarted })}</div> : null}
                {pl.stored ? <div className="am-help">{tx(t, 'plugins.stored', 'Stored in this browser ({{size}}, added {{date}})', { size: formatSize(pl.stored.size), date: formatDate(pl.stored.added) })}</div> : null}
                {pl.packageUrl ? <div className="am-help">{tx(t, 'plugins.updatesFrom', 'Updates from {{host}}', { host: hostOf(pl.packageUrl) })}</div> : null}
                {pl.failed ? <div className="am-help am-warn">{t('plugins.failedNote')}</div> : null}
                {pl.disabled ? <div className={`am-help ${pl.disabled.crashed ? 'am-bad' : ''}`} role={pl.disabled.crashed ? 'alert' : undefined}>{pl.disabled.crashed ? tx(t, 'plugins.crashed', 'Switched off because it stopped working: {{message}}', { message: pl.disabled.reason }) : tx(t, 'plugins.switchedOff', 'Switched off')}</div> : null}
                {pl.origin ? <div className="am-help">{/^https?:\/\//.test(pl.origin) ? hostOf(pl.origin) : pl.origin}</div> : null}
              </div>
              {toggleBtn(pl)}
              {updateBtn(pl)}
              {pl.builtIn ? null : actionBtns(pl)}
            </li>
          ))}
        </ul>
      )}
      {p.note ? <p className={p.note.kind === 'error' ? 'am-error-text' : 'am-help'} role={p.note.kind === 'error' ? 'alert' : 'status'}>{p.note.text}</p> : null}
      <div className="am-actions am-sticky"><button type="button" className="am-primary" onClick={p.onClose}>{t('plugins.close')}</button></div>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------------------------------- the catalog under "Add a plugin"
const CATALOG_SHOWN = 40
/** "Search in the catalog": a search box and the plugins that match, each with Install, Update or the installed version. Everything shown is text; pictures come from the catalog's own address. */
function CatalogSection({ t, catalog, installed, query, onQuery }: { t: T; catalog: PluginCatalogHost; installed: PluginRow[]; query: string; onQuery: (q: string) => void }): ReactElement {
  const q = query.trim().toLowerCase()
  const match = (i: CatalogItem): boolean => q === '' || [i.name, i.description ?? '', i.id, i.license ?? ''].some(x => x.toLowerCase().includes(q))
  const found = catalog.status === 'ready' ? catalog.items.filter(match) : []
  const shown = found.slice(0, CATALOG_SHOWN)
  const button = (i: CatalogItem): ReactElement => {
    const have = installed.find(x => x.id === i.id)
    const busy = catalog.busy === i.id
    if (have?.builtIn) return <span className="am-help">{t('plugins.builtIn')}</span>
    const up = catalog.updates[i.id]
    if (have && !up) return <span className="am-help am-installed">{tx(t, 'plugins.catalog.installed', 'Installed {{version}}', { version: have.version })}</span>
    const label = busy ? tx(t, 'plugins.catalog.fetching', 'Downloading\u2026') : up ? tx(t, 'plugins.catalog.updateTo', 'Update to {{version}}', { version: up }) : tx(t, 'plugins.catalog.install', 'Install')
    return <button type="button" className={up ? 'am-updatebtn' : undefined} disabled={!!catalog.busy} aria-label={`${label} ${i.name}`} onClick={() => catalog.onInstall(i.id)}>{label}</button>
  }
  return (
    <section className="am-catalog" aria-labelledby="am-catalog-h">
      <h4 id="am-catalog-h">{tx(t, 'plugins.catalog.title', 'Plugin catalog')}</h4>
      <div className="am-row">
        <label htmlFor="am-catalog-q">{tx(t, 'plugins.catalog.search', 'Search in the catalog')}</label>
        <input id="am-catalog-q" type="search" value={query} autoComplete="off" disabled={catalog.status !== 'ready'} placeholder={tx(t, 'plugins.catalog.placeholder', 'Name, description or licence')} onChange={e => onQuery(e.target.value)} />
      </div>
      {catalog.status === 'loading' ? <p className="am-help" role="status">{tx(t, 'plugins.catalog.checking', 'Checking the catalog\u2026')}</p> : null}
      {catalog.status === 'unavailable' ? (
        <p className="am-help" role="status">{tx(t, 'plugins.catalog.unavailable', 'The catalog is not available here.')}{' '}{catalog.onRetry ? <button type="button" onClick={catalog.onRetry}>{tx(t, 'plugins.catalog.retry', 'Try again')}</button> : null}</p>
      ) : null}
      {catalog.status === 'ready' ? (
        <>
          <p className="am-help" role="status">{catalog.source ? tx(t, 'plugins.catalog.from', '{{count}} plugins from {{host}}', { count: catalog.items.length, host: catalog.source }) : tx(t, 'plugins.catalog.count', '{{count}} plugins', { count: catalog.items.length })}{q !== '' ? ` \u00b7 ${tx(t, 'plugins.catalog.matches', '{{count}} match', { count: found.length })}` : ''}</p>
          {shown.length === 0 ? <p className="am-help">{tx(t, 'plugins.catalog.none', 'No plugin matches your search.')}</p> : (
            <ul className="am-catalog-list">
              {shown.map(i => (
                <li key={i.id} data-catalog-plugin={i.id}>
                  {i.image ? <img className="am-catalog-img" src={i.image.url} alt={i.image.alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : null}
                  <div className="am-catalog-body">
                    <div><strong>{i.name}</strong> <span className="am-sub">{t('plugins.version', { version: i.version })}</span>{i.downloads !== undefined && i.downloads > 0 ? <span className="am-sub" data-testid="downloads"> · {tx(t, i.downloads === 1 ? 'plugins.catalog.downloads_one' : 'plugins.catalog.downloads_other', '{{count}} downloads', { count: i.downloads.toLocaleString('en-US').replace(/,/g, '\u202f') })}</span> : null}</div>
                    <PluginMeta t={t} description={i.description} license={i.license} contact={i.contact} />
                    {i.replaces && i.replaces.length > 0 ? <div className="am-help" data-testid="replaces">{tx(t, 'plugins.catalog.replaces', 'Replaces {{ids}}', { ids: i.replaces.join(', ') })}</div> : null}
                  </div>
                  <div className="am-catalog-act">{button(i)}</div>
                </li>
              ))}
            </ul>
          )}
          {found.length > shown.length ? <p className="am-help">{tx(t, 'plugins.catalog.more', 'Showing the first {{count}}. Type to narrow the list.', { count: shown.length })}</p> : null}
        </>
      ) : null}
    </section>
  )
}

// ---------------------------------------------------------------------------------------------------- metadata shown as text
const formatSize = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
const formatDate = (ms: number): string => { try { return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) } catch { return '' } }
/** The host name of an address, for showing (never the whole address). */
export const hostOf = (url: string): string => { try { return new URL(url).hostname } catch { return '' } }
/** An address is a link only when it passes the same rule as the manifest check: https, no credentials. */
const safeHref = (url: unknown): string | null => (typeof url === 'string' && httpsUrlProblem(url, 200) === null ? new URL(url).toString() : null)

/** Description, licence and contact of a plugin. Everything is text: no markup from a manifest is ever interpreted; links are https only, the mail link is built from a checked address. */
export function PluginMeta({ t, description, license, contact }: { t: T; description?: string | undefined; license?: string | undefined; contact?: PluginContactInfo | undefined }): ReactElement | null {
  const href = safeHref(contact?.url)
  const mail = contact?.email !== undefined && isValidEmail(contact.email) ? contact.email : null
  if (!description && !license && !href && !mail && !contact?.name) return null
  return (
    <div className="am-meta">
      {description ? <div className="am-metadesc">{description}</div> : null}
      <div className="am-metaline">
        {license ? <span className="am-metalicence" title={tx(t, 'plugins.licenseTitle', 'Licence')}><span className="am-sr">{tx(t, 'plugins.licenseTitle', 'Licence')}: </span>{license}</span> : null}
        {contact?.name ? <span className="am-help">{contact.name}</span> : null}
        {href ? <a href={href} target="_blank" rel="noopener noreferrer">{tx(t, 'plugins.contactWeb', 'Website')}<span className="am-sr"> {tx(t, 'plugins.opensNewTab', '(opens in a new tab)')}</span></a> : null}
        {mail ? <a href={`mailto:${mail}`}>{mail}</a> : null}
      </div>
    </div>
  )
}

/** "Do you want to add this plugin?" with everything a person needs to decide: who made it, what it does, under which licence, whether anyone vouches for it. */
export function ApprovalDialog({ t, a, onApprove, onCancel }: { t: T; a: PluginApproval; onApprove: () => void; onCancel: () => void }): ReactElement {
  const title = a.kind === 'update' ? tx(t, 'plugins.approve.updateTitle', 'Update this plugin?') : a.replace ? tx(t, 'plugins.approve.replaceTitle', 'Replace this plugin?') : tx(t, 'plugins.approve.title', 'Add this plugin?')
  const warn = a.signerCheck === 'lost' || a.signerCheck === 'other' || (!a.signed && a.kind === 'install')
  return (
    <Dialog title={title} onClose={onCancel} wide t={t}>
      <p><strong>{a.name}</strong> {a.installedVersion !== undefined ? tx(t, 'plugins.approve.versions', '{{from}} → {{to}}', { from: a.installedVersion, to: a.version }) : tx(t, 'plugins.version', 'Version {{version}}', { version: a.version })}</p>
      {a.sameVersionNewChecksum ? <p className="am-help am-warn" role="status">{tx(t, 'plugins.approve.sameVersion', 'This is the same version number, but the file is different from the one installed.')}</p> : null}
      {a.image ? <img className="am-approve-img" src={a.image.url} alt={a.image.alt} decoding="async" /> : null}
      <PluginMeta t={t} description={a.description} license={a.license} contact={a.contact} />
      <p className={warn ? 'am-help am-warn' : 'am-help'} role={warn ? 'alert' : 'status'}>
        {a.signed ? tx(t, 'plugins.signed', 'Signed by {{signer}}', { signer: a.signer ?? '' }) : tx(t, 'plugins.approve.unsigned', 'Not signed: nobody vouches for this file.')}
        {a.signerCheck === 'same' ? ` ${tx(t, 'plugins.approve.sameSigner', 'Signed by the same key as the installed version.')}` : ''}
      </p>
      {a.signerCheck === 'lost' ? <p className="am-help am-bad" role="alert">{tx(t, 'plugins.approve.lostSignature', 'Warning: the installed version is signed, this new one is not.')}</p> : null}
      {a.signerCheck === 'other' ? <p className="am-help am-bad" role="alert">{tx(t, 'plugins.approve.otherSigner', 'Warning: this new version is signed by a different key than the installed one.')}</p> : null}
      <p className="am-help">{a.permissions.length > 0 ? tx(t, 'plugins.approve.needs', 'Needs: {{list}}', { list: a.permissions.join(', ') }) : tx(t, 'plugins.approve.needsNothing', 'Needs nothing beyond changing the model.')}</p>
      <p className="am-help">{tx(t, 'plugins.approve.from', 'From: {{origin}}', { origin: a.origin })}</p>
      <div className="am-actions">
        <button type="button" data-autofocus onClick={onCancel}>{tx(t, 'plugins.approve.cancel', 'Cancel')}</button>
        <button type="button" className="am-primary" onClick={onApprove}>{a.kind === 'update' ? tx(t, 'plugins.approve.update', 'Update') : a.replace ? tx(t, 'plugins.approve.replace', 'Replace') : tx(t, 'plugins.approve.add', 'Add')}</button>
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------------------------------- build your own plugin
/** Copy text with the clipboard API, or with a hidden text box when the page has no clipboard API (plain http); false when neither worked. */
async function copyText(text: string): Promise<boolean> {
  try { if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') { await navigator.clipboard.writeText(text); return true } } catch { /* fall through to the old way */ }
  try {
    const a = document.createElement('textarea')
    a.value = text; a.setAttribute('readonly', ''); a.style.position = 'fixed'; a.style.left = '-9999px'
    document.body.append(a); a.select()
    const ok = typeof document.execCommand === 'function' && document.execCommand('copy')
    a.remove()
    return !!ok
  } catch { return false }
}

function BuildPanel({ t, build, onBack }: { t: T; build: NonNullable<PluginManagerProps['build']>; onBack: () => void }): ReactElement {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle')
  const area = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (state === 'manual') { area.current?.focus(); area.current?.select() } }, [state])
  const [noNpm, setNoNpm] = useState(false)
  const promptText = (noNpm ? build.promptTextNoNpm : build.promptText) ?? build.promptText ?? ''
  const copy = async (): Promise<void> => { setState((await copyText(promptText)) ? 'copied' : 'manual') }
  return (
    <Dialog title={tx(t, 'plugins.build.title', 'Build your own plugin')} onClose={onBack} wide t={t}>
      <div className="am-buildpanel">
        <button type="button" className="am-back" data-autofocus onClick={onBack}>{tx(t, 'plugins.build.back', '‹ Back to plugins')}</button>
        <p>{tx(t, 'plugins.build.intro', 'A plugin is a small program that changes a model: it can put a pattern on the surface, bend or twist a shape, hollow it out or check it for printing problems. Anyone can write one, and it works in AtelierMesh like the built-in steps.')}</p>
        <h3>{tx(t, 'plugins.build.needTitle', 'What you need')}</h3>
        <ul>
          <li>{tx(t, 'plugins.build.need1', 'A text editor, or a coding agent that writes the code for you.')}</li>
          <li>{tx(t, 'plugins.build.need2', 'Node.js, to test and pack the plugin.')}</li>
          <li>{tx(t, 'plugins.build.need3', 'An idea of what the plugin should do, in plain words.')}</li>
        </ul>
        <h3>{tx(t, 'plugins.build.stepsTitle', 'Five steps')}</h3>
        <ol>
          <li>{tx(t, 'plugins.build.step1', 'Describe what it does in a sentence or two.')}</li>
          <li>{tx(t, 'plugins.build.step2', 'Start from the example plugin in the kit: copy its folder.')}</li>
          <li>{tx(t, 'plugins.build.step3', 'Write the manifest (its name, settings and limits) and the run function (the code that changes the model).')}</li>
          <li>{tx(t, 'plugins.build.step4', 'Test it: the example shows how to check a result and that a model is never broken.')}</li>
          <li>{tx(t, 'plugins.build.step5', 'Pack it into one file and load it here with “Choose a plugin file”.')}</li>
        </ol>
        <h3>{tx(t, 'plugins.build.safeTitle', 'Is it safe?')}</h3>
        <p>{tx(t, 'plugins.build.safe', 'A plugin from a file runs in a sandbox: it only gets the model it works on, and it has no network. A plugin that is not signed asks for your approval first. You can trust the key of a signer you know under “Trusted signers”.')}</p>
        <div className="am-row am-buildlinks">
          {build.guideUrl ? <a className="am-linkbtn" href={build.guideUrl} target="_blank" rel="noopener noreferrer"><Icon name="external" size={16} />{tx(t, 'plugins.build.guide', 'Open the full guide')}<span className="am-sr"> {tx(t, 'plugins.build.newTab', '(opens in a new tab)')}</span></a> : null}
          {build.promptText && build.promptTextNoNpm ? (
            <div className="am-seg" role="group" aria-label={tx(t, 'plugins.build.variant', 'Which prompt')}>
              <button type="button" aria-pressed={!noNpm} onClick={() => { setNoNpm(false); setState('idle') }}>{tx(t, 'plugins.build.withNpm', 'With npm')}</button>
              <button type="button" aria-pressed={noNpm} onClick={() => { setNoNpm(true); setState('idle') }}>{tx(t, 'plugins.build.withoutNpm', 'Without npm')}</button>
            </div>
          ) : null}
          {build.promptText ? <button type="button" onClick={() => void copy()}><Icon name="copy" size={16} />{tx(t, 'plugins.build.copy', 'Copy a prompt for your AI agent')}</button> : null}
          {build.kitUrl ? <a className="am-linkbtn" href={build.kitUrl} download><Icon name="download" size={16} />{tx(t, 'plugins.build.kit', 'Download the plugin kit (zip)')}</a> : null}
          {build.exampleUrl ? <a className="am-linkbtn" href={build.exampleUrl} download><Icon name="download" size={16} />{tx(t, 'plugins.build.example', 'Download the packed example (.amplugin)')}</a> : null}
        </div>
        {build.kitUrl || build.exampleUrl ? <p className="am-help">{build.kitUrl ? tx(t, 'plugins.build.kitHint', 'The kit has everything to build a plugin on your own computer: the guide, the source of the example, the packages and the packing tool. Nothing needs to be installed from npm except the usual tools.') : ''}{build.kitUrl && build.exampleUrl ? ' ' : ''}{build.exampleUrl ? tx(t, 'plugins.build.exampleHint', 'The packed example is only for trying the loader: choose it with “Choose a plugin file”.') : ''}</p> : null}
        {build.promptTextNoNpm ? <p className="am-help">{tx(t, 'plugins.build.noNpmHint', 'No npm? Pick “Without npm”: the prompt then asks for plain JavaScript and uses tools that need only Node, only Python 3, or nothing but a text editor.')}</p> : null}
        <p className="am-help" role="status">{state === 'copied' ? tx(t, 'plugins.build.copied', 'Copied. Paste it into your coding agent and fill in the parts in {{double braces}}.') : state === 'manual' ? tx(t, 'plugins.build.manual', 'Your browser would not copy it. Select the text below and copy it yourself.') : ''}</p>
        {state === 'manual' && promptText ? (
          <div>
            <label className="am-label" htmlFor="am-prompt-text">{tx(t, 'plugins.build.promptLabel', 'The prompt')}</label>
            <textarea id="am-prompt-text" ref={area} className="am-prompt" readOnly rows={10} value={promptText} onFocus={e => e.currentTarget.select()} />
          </div>
        ) : null}
      </div>
      <div className="am-actions"><button type="button" className="am-primary" onClick={onBack}>{tx(t, 'plugins.build.backToList', 'Back to plugins')}</button></div>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------------------------------- leave
export interface LeaveDialogProps {
  t: T
  /** When it was last saved ("14:32"); absent when it never was. */
  savedAt?: string | null
  /** Save, then leave. The dialog shows nothing while it waits; reject to stay with the dialog open. */
  onSave?: () => Promise<void> | void
  onDiscard: () => void
  onStay: () => void
}

export function LeaveDialog({ t, savedAt, onSave, onDiscard, onStay }: LeaveDialogProps): ReactElement {
  const [busy, setBusy] = useState(false)
  return (
    <Dialog title={t('leave.title')} onClose={onStay} strict t={t}>
      <p>{savedAt ? t('leave.body', { time: savedAt }) : t('leave.bodyNever')}</p>
      <div className="am-actions">
        <button type="button" data-autofocus onClick={onStay}>{t('leave.stay')}</button>
        <button type="button" className="am-danger" onClick={onDiscard}>{t('leave.discard')}</button>
        {onSave ? <button type="button" className="am-primary" disabled={busy} onClick={() => { setBusy(true); void Promise.resolve(onSave()).finally(() => setBusy(false)) }}>{t('leave.save')}</button> : null}
      </div>
    </Dialog>
  )
}

/** Warns the browser when the page is closed or reloaded with unsaved changes. In-page navigation is the host's: show a `LeaveDialog`. */
export function useLeaveGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return
    const fn = (e: BeforeUnloadEvent): void => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', fn)
    return () => window.removeEventListener('beforeunload', fn)
  }, [dirty])
}

// ---------------------------------------------------------------------------------------------------- settings
/** The tabs of the settings: General, Plugins (the plugin manager) and Catalogues. A host that gives `tabs` gets the tab bar; one that does not gets the one list it always had. */
export type SettingsTab = 'general' | 'plugins' | 'catalogues'

export function SettingsTabs({ t, current, onSelect }: { t: T; current: SettingsTab; onSelect: (tab: SettingsTab) => void }): ReactElement {
  const tabs: Array<[SettingsTab, string]> = [['general', tx(t, 'settings.general', 'General')], ['plugins', tx(t, 'settings.plugins', 'Plugins')], ['catalogues', tx(t, 'catalogues.title', 'Catalogues')]]
  const move = (e: KeyboardEvent, i: number): void => {
    const k = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'Home' ? -i : e.key === 'End' ? tabs.length - 1 - i : 0
    if (!k) return
    e.preventDefault(); const n = (tabs[(i + k + tabs.length) % tabs.length] as [SettingsTab, string])[0]; onSelect(n)
  }
  return (
    <div className="am-stabs" role="tablist" aria-label={t('settings.title')}>
      {tabs.map(([id, label], i) => <button key={id} type="button" role="tab" id={`am-stab-${id}`} aria-selected={current === id} tabIndex={current === id ? 0 : -1} data-autofocus={current === id ? true : undefined} onKeyDown={e => move(e, i)} onClick={() => onSelect(id)}>{label}</button>)}
    </div>
  )
}

/** One catalogue as the Catalogues tab shows it. */
export interface CatalogueCard {
  id: string
  name: string
  address: string
  isDefault: boolean
  /** What it offers; `count` is how many (when known), `offered: false` shows the chip struck through. */
  offers: Array<{ kind: 'plugins' | 'designs'; offered: boolean; count?: number }>
  /** A catalogue the person added can be removed; the default one cannot. */
  removable?: boolean
}

/** What looking at a new catalogue's address found: its name and how many plugins and examples it offers (a part it does not offer is left out), or why it is no catalogue. */
export type CatalogueCheck = { ok: true; name: string; address: string; offers: { plugins?: number; designs?: number } } | { ok: false; reason: 'address' | 'network' | 'format' | 'duplicate' }

export interface SettingsDialogProps {
  t: T
  /** With tabs: the tab bar, and only the part of the settings that belongs to the tab (the plugin manager is the Plugins tab, shown by the host). */
  tabs?: { current: 'general' | 'catalogues'; onSelect: (tab: SettingsTab) => void }
  /** The catalogues the app reads (the Catalogues tab). The default one shows its address field (`catalog`). */
  catalogues?: CatalogueCard[]
  /** Adding a catalogue: look at an address (nothing is added by this), then add it with what it may be used for, or remove one. Absent: the list is only shown. */
  onCheckCatalogue?: (name: string, address: string) => Promise<CatalogueCheck>
  onAddCatalogue?: (c: { name: string; address: string; plugins: boolean; designs: boolean; offers: { plugins?: number; designs?: number } }) => void
  onRemoveCatalogue?: (id: string) => void
  showPersonalised: boolean
  onShowPersonalised: (on: boolean) => void
  /** Opens the plugin manager (a row of its own, as drawn). */
  onPlugins?: () => void
  /** The address of the plugin catalog. `value` is what the person set ('' = the default, shown as `placeholder`); `onChange` is called when the field is left. */
  catalog?: { value: string; placeholder: string; onChange: (value: string) => void }
  /** The most colours (filaments) a design may use: in the standalone app the person sets it; in the Atelier it is the connector's setting. */
  maxColours?: { value: number; onChange: (value: number) => void }
  /** The About block: what this is and which version runs. `plugins` are the ones installed now. */
  about?: { name: string; version: string; build?: string; licence?: string; plugins: Array<{ name: string; version: string; builtin: boolean }> }
  onClose: () => void
}

export function SettingsDialog({ t, tabs, catalogues, onCheckCatalogue, onAddCatalogue, onRemoveCatalogue, showPersonalised, onShowPersonalised, onPlugins, catalog, maxColours, about, onClose }: SettingsDialogProps): ReactElement {
  const [addr, setAddr] = useState(catalog?.value ?? '')
  const [adding, setAdding] = useState(false), [form, setForm] = useState({ name: '', address: '' }), [problem, setProblem] = useState(''), [checking, setChecking] = useState(false)
  const [found, setFound] = useState<null | { name: string; address: string; offers: { plugins?: number; designs?: number } }>(null)
  const [uses, setUses] = useState({ plugins: true, designs: false })
  if (tabs && tabs.current === 'catalogues' && found) {
    // the first time a catalogue is met: what it is, what it offers, and what it may be used for
    const own = (catalogues ?? []).find(c => c.isDefault)?.name ?? ''
    const cancel = (): void => setFound(null)
    return (
      <Dialog title={tx(t, 'catalogues.unknownTitle', 'What is this catalogue?')} onClose={cancel} strict t={t}>
        <p className="am-outsidehost"><code>{found.address}</code></p>
        <p>{tx(t, 'catalogues.unknownOffers', 'This address offers:')} <strong>{found.offers.designs ?? 0}</strong> {tx(t, 'catalogues.countDesigns', 'examples')}, <strong>{found.offers.plugins ?? 0}</strong> {tx(t, 'catalogues.countPlugins', 'plugins')}</p>
        <p className="am-help am-warn" role="note">{tx(t, 'catalogues.unknownText', '{{catalog}} doesn\u2019t check what this catalogue offers. Its examples can carry plugins, and plugins run code in your browser.', { catalog: own })} {tx(t, 'catalogues.unknownAsk', 'You\u2019ll still be asked before any plugin from it is installed.')}</p>
        <fieldset className="am-choices"><legend>{tx(t, 'catalogues.useFor', 'Use it for')}</legend>
          {(['plugins', 'designs'] as const).map(k => {
            const offered = found.offers[k] !== undefined
            return <label key={k} className="am-choice"><input type="checkbox" disabled={!offered} checked={offered && uses[k]} onChange={e => setUses(u => ({ ...u, [k]: e.target.checked }))} /><span>{k === 'plugins' ? tx(t, 'catalogues.pluginsOffer', 'Plugins') : tx(t, 'catalogues.designs', 'Examples')}{offered ? '' : <span className="am-help"> ({tx(t, 'catalogues.notOffered', 'Not offered here')})</span>}</span></label>
          })}
        </fieldset>
        <div className="am-actions">
          <button type="button" data-autofocus onClick={cancel}>{tx(t, 'open.cancel', 'Cancel')}</button>
          <button type="button" disabled={!uses.plugins && !uses.designs} onClick={() => { onAddCatalogue?.({ name: found.name, address: found.address, plugins: found.offers.plugins !== undefined && uses.plugins, designs: found.offers.designs !== undefined && uses.designs, offers: found.offers }); setFound(null); setAdding(false); setForm({ name: '', address: '' }) }}>{tx(t, 'catalogues.addYes', 'Add catalogue')}</button>
        </div>
      </Dialog>
    )
  }
  if (tabs && tabs.current === 'catalogues') {
    const offer = (o: CatalogueCard['offers'][number]): ReactElement => {
      const label = o.kind === 'plugins' ? tx(t, 'catalogues.pluginsOffer', 'Plugins') : tx(t, 'catalogues.designs', 'Examples')
      return <span key={o.kind} className={`am-chip${o.offered ? '' : ' am-chip-off'}`}>{o.offered ? (o.count !== undefined ? `${label} \u00b7 ${o.count}` : label) : <s>{label}</s>}{o.offered ? null : <span className="am-sr"> ({tx(t, 'catalogues.notOffered', 'Not offered here')})</span>}</span>
    }
    return (
      <Dialog title={t('settings.title')} onClose={onClose} t={t}>
        <SettingsTabs t={t} current="catalogues" onSelect={tabs.onSelect} />
        <p className="am-help">{tx(t, 'catalogues.intro', 'Where AtelierMesh finds examples and plugins. One address can offer both.')}</p>
        {(catalogues ?? []).map(c => (
          <section key={c.id} className="am-cataloguecard" aria-label={c.name}>
            <h3>{c.name}{c.isDefault ? <span className="am-chip am-chip-tag">{tx(t, 'catalogues.default', 'Default')}</span> : null}</h3>
            <p className="am-mono am-help">{c.address}</p>
            <div className="am-chips">{c.offers.map(offer)}</div>
            {c.removable && onRemoveCatalogue ? <div className="am-actions"><button type="button" aria-label={`${tx(t, 'catalogues.removeC', 'Remove {{name}}', { name: c.name })}`} onClick={() => onRemoveCatalogue(c.id)}><Icon name="trash" size={16} />{tx(t, 'catalogues.remove', 'Remove')}</button></div> : null}
            {c.isDefault && catalog ? (
              <div className="am-setting-stack">
                <label htmlFor="am-set-catalog"><strong>{tx(t, 'settings.catalogAddress', 'Plugin catalog address')}</strong></label>
                <p className="am-help" id="am-set-catalog-h">{tx(t, 'settings.catalogAddressHint', 'Where the plugin manager looks for plugins and updates. Leave it empty to use this site\u2019s own catalog. Use an https address or a path on this site.')}</p>
                <input id="am-set-catalog" type="text" inputMode="url" autoCapitalize="none" spellCheck={false} aria-describedby="am-set-catalog-h" value={addr} placeholder={catalog.placeholder} onChange={e => setAddr(e.target.value)} onBlur={() => { if (addr.trim() !== catalog.value) catalog.onChange(addr.trim()) }} />
              </div>
            ) : null}
          </section>
        ))}
        {onCheckCatalogue ? (adding ? (
          <form className="am-cataloguecard" onSubmit={e => {
            e.preventDefault(); if (checking) return
            setChecking(true); setProblem('')
            void onCheckCatalogue(form.name.trim(), form.address.trim()).then(r => {
              if (r.ok) { setFound({ name: form.name.trim() || r.name, address: r.address, offers: r.offers }); setUses({ plugins: r.offers.plugins !== undefined, designs: r.offers.designs !== undefined }) }
              else setProblem(tx(t, `catalogues.problem.${r.reason}`, ({ address: 'That is not a usable address. Start it with https://.', network: 'Could not reach that address.', format: 'That address is not a catalogue.', duplicate: 'That catalogue is in the list already.' } as const)[r.reason]))
            }).finally(() => setChecking(false))
          }}>
            <h3>{tx(t, 'catalogues.add', 'Add a catalogue')}</h3>
            <div className="am-field"><label htmlFor="am-cat-name">{tx(t, 'catalogues.name', 'Name')}</label><input id="am-cat-name" type="text" maxLength={80} placeholder={tx(t, 'catalogues.namePh', 'How you\u2019ll recognise it')} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></div>
            <div className="am-field"><label htmlFor="am-cat-addr">{tx(t, 'catalogues.address', 'Address')}</label><input id="am-cat-addr" type="text" inputMode="url" autoCapitalize="none" spellCheck={false} required aria-describedby="am-cat-addr-h" value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} /><p className="am-help" id="am-cat-addr-h">{tx(t, 'catalogues.addressHint', 'Starts with https://. We look at what it offers before adding it.')}</p></div>
            {problem ? <p className="am-problem" role="alert">{problem}</p> : null}
            <div className="am-actions"><button type="button" onClick={() => { setAdding(false); setProblem('') }}>{tx(t, 'open.cancel', 'Cancel')}</button><button type="submit" className="am-primary" disabled={checking || form.address.trim() === ''}>{tx(t, 'catalogues.check', 'Check address')}</button></div>
          </form>
        ) : <p><button type="button" onClick={() => setAdding(true)}><Icon name="plus" size={16} />{tx(t, 'catalogues.add', 'Add a catalogue')}</button></p>) : null}
        <div className="am-actions am-sticky"><button type="button" className="am-primary" onClick={onClose}>{t('settings.close')}</button></div>
      </Dialog>
    )
  }
  return (
    <Dialog title={t('settings.title')} onClose={onClose} t={t}>
      {tabs ? <SettingsTabs t={t} current="general" onSelect={tabs.onSelect} /> : null}
      <div className="am-setting">
        <div>
          <label htmlFor="am-set-pers"><strong>{t('settings.showPersonalised')}</strong></label>
          <p className="am-help" id="am-set-pers-h">{t('settings.showPersonalisedHint')}</p>
        </div>
        <input id="am-set-pers" type="checkbox" role="switch" aria-describedby="am-set-pers-h" checked={showPersonalised} onChange={e => onShowPersonalised(e.target.checked)} />
      </div>
      {onPlugins && !tabs ? <div className="am-setting"><strong>{t('settings.plugins')}</strong><button type="button" onClick={onPlugins}>{t('settings.plugins')}</button></div> : null}
      {catalog && !tabs ? (
        <div className="am-setting am-setting-stack">
          <label htmlFor="am-set-catalog"><strong>{tx(t, 'settings.catalogAddress', 'Plugin catalog address')}</strong></label>
          <p className="am-help" id="am-set-catalog-h">{tx(t, 'settings.catalogAddressHint', 'Where the plugin manager looks for plugins and updates. Leave it empty to use this site\u2019s own catalog. Use an https address or a path on this site.')}</p>
          <input id="am-set-catalog" type="text" inputMode="url" autoCapitalize="none" spellCheck={false} aria-describedby="am-set-catalog-h" value={addr} placeholder={catalog.placeholder} onChange={e => setAddr(e.target.value)} onBlur={() => { if (addr.trim() !== catalog.value) catalog.onChange(addr.trim()) }} />
        </div>
      ) : null}
      {maxColours ? (
        <div className="am-setting">
          <div>
            <label htmlFor="am-set-colours"><strong>{tx(t, 'settings.maxColours', 'Most colours')}</strong></label>
            <p className="am-help" id="am-set-colours-h">{tx(t, 'settings.maxColoursHint', 'How many filaments one design may use. A printer with fewer slots needs a lower number.')}</p>
          </div>
          <input id="am-set-colours" type="number" min={1} max={16} step={1} aria-describedby="am-set-colours-h" value={maxColours.value} onChange={e => { const n = Math.round(Number(e.target.value)); if (Number.isFinite(n)) maxColours.onChange(Math.min(16, Math.max(1, n))) }} />
        </div>
      ) : null}
      {about ? (
        <section className="am-setting am-setting-stack" aria-labelledby="am-about-h">
          <h3 id="am-about-h">{tx(t, 'settings.about', 'About')}</h3>
          <p><strong>{about.name}</strong> {tx(t, 'settings.version', 'version')} {about.version}{about.build ? ` (${about.build})` : ''}</p>
          {about.licence ? <p className="am-help">{tx(t, 'settings.licence', 'Licence')}: {about.licence}</p> : null}
          {about.plugins.length > 0 ? (
            <details>
              <summary>{tx(t, 'settings.installedPlugins', 'Installed plugins')} ({about.plugins.length})</summary>
              <ul className="am-help">{about.plugins.map(pl => <li key={pl.name + pl.version}>{pl.name} {pl.version}{pl.builtin ? '' : ` \u00b7 ${tx(t, 'settings.addedPlugin', 'added')}`}</li>)}</ul>
            </details>
          ) : null}
        </section>
      ) : null}
      <div className="am-actions am-sticky"><button type="button" className="am-primary" onClick={onClose}>{t('settings.close')}</button></div>
    </Dialog>
  )
}
