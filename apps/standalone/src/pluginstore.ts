// Plugins kept in this browser. The packed file is stored in IndexedDB when the person approves it and is loaded again, in the background, on every start.
// Nothing stored is trusted: every start checks the bytes against the stored checksum, reads the package again with the same rules as a fresh install
// (manifest, hashes, signature against the keys trusted NOW), starts it once in the sandbox, and only then registers it. A stored plugin that fails any
// of this stays in the store, switched off, with the reason shown: it is never deleted behind the person's back and it cannot take the page down.
import { PluginTexts, compareSemver, sha256Hex } from '@ateliermesh/core'
import type { Registry } from '@ateliermesh/core'
import { packageEntry, probePackage, readPluginPackage } from '@ateliermesh/loader'
import type { LoadedPackage, TrustedKey } from '@ateliermesh/loader'
import { MAX_STORED_PLUGINS, MAX_STORED_PLUGIN_BYTES, deletePlugin, getPlugin, listPlugins, putPlugin } from './library'
import type { StoredPlugin } from './library'
import type { PluginApproval } from '@ateliermesh/react'

type T = (key: string, values?: Record<string, string | number>) => string

/** What the manager shows of a plugin that is kept but not running. */
export interface NotStarted { id: string; name: string; version: string; size: number; added: number; reason: string }
export interface StoredInfo { size: number; added: number; url?: string }

const imageUrls = new Map<string, string>()
/** An address for the package's example picture, made from its checked bytes; the same address while the package is the same. Undefined without a picture. */
export function imageUrlFor(pkg: LoadedPackage): { url: string; alt: string } | undefined {
  if (!pkg.image) return undefined
  let url = imageUrls.get(pkg.hash)
  if (!url) {
    try { url = URL.createObjectURL(new Blob([pkg.image.bytes as BlobPart], { type: pkg.image.mime })) } catch { return undefined }
    imageUrls.set(pkg.hash, url)
  }
  return { url, alt: pkg.image.alt }
}
/** Let go of the address of a package's picture (the package was refused, replaced or removed). */
export function dropImage(pkg: LoadedPackage | undefined): void {
  if (!pkg) return
  const u = imageUrls.get(pkg.hash)
  if (u) { try { URL.revokeObjectURL(u) } catch { /* nothing to free */ } imageUrls.delete(pkg.hash) }
}

/** A readable sentence for what a failed load threw: the manifest problems by their own texts, the rest by code and numbers. */
export function loadErrorText(t: T, e: unknown): string {
  const err = e as { code?: string; params?: { reason?: string; issues?: Array<{ code: string; params?: Record<string, unknown>; path?: string }> } }
  const issues = err?.params?.issues
  if (err?.params?.reason === 'invalid_manifest' && Array.isArray(issues) && issues.length > 0) {
    return issues.map(i => { const k = `mesh.${i.code}`; const txt = t(k, { ...(i.params as Record<string, string | number> | undefined), path: i.path ?? '' }); return txt === k ? `${i.code} ${JSON.stringify(i.params ?? {})}` : txt }).join(' ')
  }
  const r = err?.params?.reason
  if (err?.code === 'loader.invalid_package' && typeof r === 'string' && r.startsWith('image_')) { const k = `plugins.${r.replace(/_(\w)/g, (_m, c: string) => c.toUpperCase())}`; const txt = t(k, err.params as Record<string, string | number>); if (txt !== k) return txt }
  if (err?.code === 'loader.invalid_package' && r === 'image_missing') return t('plugins.imageMissing', err.params as Record<string, string | number>)
  if (err?.code === 'loader.bad_url' && err.params?.reason === 'network_or_cors') return t('plugins.corsError', { url: String((err.params as { url?: string }).url ?? '') })
  if (err?.code === 'loader.bad_url' && err.params?.reason === 'hash_pin_mismatch') return t('plugins.catalog.hashMismatch')
  if (err?.code === 'loader.bad_url' && err.params?.reason === 'timeout') return t('plugins.timeoutError', { url: String((err.params as { url?: string }).url ?? '') })
  return `${err?.code ?? (e instanceof Error ? e.message : String(e))} ${JSON.stringify(err?.params ?? {})}`.trim()
}

/** The texts of the installed packages; the page builds its `t` from the app's files and this store (see `makeT`). */
export const pluginTexts = new PluginTexts()

export interface RestoreDeps {
  registry: Registry
  packages: Map<string, LoadedPackage>
  keys: TrustedKey[]
  /** The ids switched off by hand or by a crash earlier (localStorage): they come back switched off. */
  disabled: Record<string, { reason?: string; crashed?: boolean }>
  onOne?: () => void
}

/** Why a stored record cannot be started, or the package ready to register. Never throws. */
export async function verifyStored(rec: StoredPlugin, keys: TrustedKey[]): Promise<{ ok: true; pkg: LoadedPackage } | { ok: false; reason: string }> {
  try {
    if (!(rec.bytes instanceof Uint8Array)) return { ok: false, reason: 'the stored file is missing' }
    if (sha256Hex(rec.bytes) !== rec.sha256) return { ok: false, reason: 'the stored file does not match its checksum (it was changed or damaged)' }
    const pkg = await readPluginPackage(rec.bytes, { trustedKeys: keys, origin: rec.url ?? rec.name })
    if (pkg.fileSha256 !== rec.sha256) return { ok: false, reason: 'the checksum of the package differs from the one stored' }
    if (pkg.hash !== rec.pkgHash) return { ok: false, reason: 'the files inside the package do not match the stored fingerprint' }
    if (pkg.manifest.id !== rec.id) return { ok: false, reason: 'the stored package is a different plugin than recorded' }
    if (rec.signedBy && !(pkg.signed && pkg.signer === rec.signedBy)) return { ok: false, reason: `it was signed by ${rec.signedBy} but that signature no longer verifies` }
    const probe = await probePackage(pkg)
    if (!probe.ok) return { ok: false, reason: probe.message }
    return { ok: true, pkg }
  } catch (e) {
    const err = e as { params?: { reason?: string } }
    if (err?.params?.reason === 'signature_not_trusted') return { ok: false, reason: 'its signature is from a signer you no longer trust' }
    return { ok: false, reason: e instanceof Error ? e.message : `${(e as { code?: string })?.code ?? 'unreadable'} ${JSON.stringify((e as { params?: unknown })?.params ?? {})}`.trim() }
  }
}

/** Load every stored plugin again, one after the other. Returns what could not be started. Reading the store may fail (private window): then there is nothing to restore. */
export async function restoreStoredPlugins(d: RestoreDeps): Promise<{ stored: Record<string, StoredInfo>; notStarted: NotStarted[]; available: boolean }> {
  const stored: Record<string, StoredInfo> = {}
  const notStarted: NotStarted[] = []
  let all: StoredPlugin[]
  try { all = await listPlugins() } catch { return { stored, notStarted, available: false } }
  for (const rec of all) {
    stored[rec.id] = { size: rec.size, added: rec.added, ...(rec.url ? { url: rec.url } : {}) }
    const v = await verifyStored(rec, d.keys)
    if (!v.ok) { notStarted.push({ id: rec.id, name: rec.name, version: rec.version, size: rec.size, added: rec.added, reason: v.reason }); d.onOne?.(); continue }
    try {
      if (d.registry.has(rec.id)) { notStarted.push({ id: rec.id, name: rec.name, version: rec.version, size: rec.size, added: rec.added, reason: 'a plugin with the same id is already running' }); continue }
      d.packages.set(rec.id, v.pkg)
      pluginTexts.set(rec.id, v.pkg.locales.texts)
      d.registry.register(packageEntry(v.pkg))
      const off = d.disabled[rec.id]
      if (!rec.enabled) d.registry.setEnabled(rec.id, false, '', false)
      else if (off) d.registry.setEnabled(rec.id, false, off.reason ?? '', off.crashed === true)
    } catch (e) {
      d.packages.delete(rec.id); pluginTexts.remove(rec.id)
      notStarted.push({ id: rec.id, name: rec.name, version: rec.version, size: rec.size, added: rec.added, reason: e instanceof Error ? e.message : String(e) })
    }
    d.onOne?.()
  }
  return { stored, notStarted, available: true }
}

/** Keep a package: true when stored, otherwise the message key and numbers of why not. The session still has the plugin either way. */
export async function storePackage(pkg: LoadedPackage, bytes: Uint8Array, source: 'file' | 'url', url?: string): Promise<{ ok: true; info: StoredInfo } | { ok: false; key: string; values: Record<string, string | number> }> {
  if (bytes.length > MAX_STORED_PLUGIN_BYTES) return { ok: false, key: 'plugins.tooBigToStore', values: { max: Math.round(MAX_STORED_PLUGIN_BYTES / 1024 / 1024) } }
  try {
    const existing = await listPlugins()
    if (!existing.some(r => r.id === pkg.manifest.id) && existing.length >= MAX_STORED_PLUGINS) return { ok: false, key: 'plugins.tooManyToStore', values: { max: MAX_STORED_PLUGINS } }
    const added = Date.now()
    const rec: StoredPlugin = {
      id: pkg.manifest.id, name: pkg.manifest.name, version: pkg.manifest.version, sha256: pkg.fileSha256, pkgHash: pkg.hash, size: bytes.length, bytes, source,
      ...(url ? { url } : {}), ...(pkg.signed && pkg.signer ? { signedBy: pkg.signer } : {}), added, enabled: true,
    }
    await putPlugin(rec)
    return { ok: true, info: { size: rec.size, added, ...(url ? { url } : {}) } }
  } catch { return { ok: false, key: 'plugins.notStoredHere', values: {} } }
}

export async function forgetPlugin(id: string): Promise<boolean> { try { await deletePlugin(id); return true } catch { return false } }
export async function storedBytes(id: string): Promise<{ bytes: Uint8Array; name: string; version: string } | null> {
  try { const r = await getPlugin(id); return r ? { bytes: r.bytes, name: r.name, version: r.version } : null } catch { return null }
}
export async function setStoredEnabled(id: string, enabled: boolean): Promise<void> {
  try { const r = await getPlugin(id); if (r && r.enabled !== enabled) await putPlugin({ ...r, enabled }) } catch { /* private window or full disk: the switch lasts for this session */ }
}
export async function isApprovedBefore(id: string, fileSha256: string): Promise<boolean> {
  try { const r = await getPlugin(id); return r !== null && r.sha256 === fileSha256 } catch { return false }
}

/** The approval a person is shown for a fresh file or a fetched update. */
export function buildApproval(pkg: LoadedPackage, old: { version: string; pkg?: LoadedPackage | undefined } | undefined, origin: string, kind: 'install' | 'update'): PluginApproval {
  const m = pkg.manifest
  let signerCheck: PluginApproval['signerCheck']
  if (old?.pkg?.signed) signerCheck = pkg.signed ? (pkg.signer === old.pkg.signer ? 'same' : 'other') : 'lost'
  return {
    kind, name: m.name, version: m.version,
    ...(old ? { installedVersion: old.version } : {}),
    ...(m.description ? { description: m.description } : {}), ...(m.license ? { license: m.license } : {}), ...(m.contact ? { contact: m.contact } : {}),
    signed: pkg.signed, ...(pkg.signer ? { signer: pkg.signer } : {}), ...(signerCheck ? { signerCheck } : {}),
    ...(old && old.version === m.version ? { sameVersionNewChecksum: true } : {}),
    permissions: pkg.permissions, origin, replace: old !== undefined, ...(imageUrlFor(pkg) ? { image: imageUrlFor(pkg) as { url: string; alt: string } } : {}),
  }
}

/** What an update check found: nothing newer, a different plugin, or a package to ask about. */
export function compareUpdate(installed: { id: string; version: string; fileSha256?: string | undefined }, pkg: LoadedPackage): 'different_plugin' | 'up_to_date' | 'older' | 'newer' | 'same_version_new_checksum' {
  if (pkg.manifest.id !== installed.id) return 'different_plugin'
  const c = compareSemver(pkg.manifest.version, installed.version)
  if (c > 0) return 'newer'
  if (c < 0) return 'older'
  return installed.fileSha256 !== undefined && installed.fileSha256 === pkg.fileSha256 ? 'up_to_date' : 'same_version_new_checksum'
}
