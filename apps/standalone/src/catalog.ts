// The plugin catalog of this site (or of another one the person chose): read the list, check it, work out which installed plugins have a newer version.
// Nothing here runs by itself: the page asks only when the plugin manager opens. Everything the server says is treated as untrusted text and checked here;
// a package taken from the catalog is checked again, like any other file, before anything is installed (checksum, manifest, signature, approval).
import { PLUGIN_ID_RE, SEMVER_RE, compareSemver, httpsUrlProblem, isValidEmail } from '@ateliermesh/core'

export interface CatalogVersion { version: string; url: string; sha256: string; size: number; uploaded?: string; signed: boolean }
export interface CatalogEntry {
  id: string; name: string; description: string; license: string
  contact?: { name?: string; url?: string; email?: string }
  image?: { url: string; alt: string }
  latest: string
  versions: CatalogVersion[]
  /** How many times the plugin was downloaded from this catalog (all versions); absent when the catalog does not say. */
  downloads?: number
  /** Ids of plugins this one replaces (it was published under them before): a design saved with one of them runs with this plugin. */
  replaces?: string[]
  /** Which catalogue it was read from, when several are merged (the host of that catalogue). */
  from?: string
}
export interface Catalog { source: string; host: string; generated?: string; plugins: CatalogEntry[] }
export type CatalogResult = { ok: true; catalog: Catalog } | { ok: false; reason: 'address' | 'network' | 'timeout' | 'http' | 'format'; status?: number }

export const DEFAULT_CATALOG_PATH = 'catalog/catalog.php'
export const CATALOG_KEY = 'am.catalogUrl'
const MAX_BYTES = 1_500_000
const MAX_PLUGINS = 500
const MAX_VERSIONS = 100

// ---- the address
/** The address the person set (or null for "this site's own"). */
export function storedCatalogAddress(): string {
  try { return localStorage.getItem(CATALOG_KEY) ?? '' } catch { return '' }
}
export function saveCatalogAddress(v: string): void {
  try { if (v) localStorage.setItem(CATALOG_KEY, v); else localStorage.removeItem(CATALOG_KEY) } catch { /* private window: lasts until the page closes */ }
}
/**
 * The full address of the catalog, or null when the text is not acceptable: empty means this site's own catalog; otherwise an https address, or a path on
 * this site (the page itself may be http, e.g. on a local network or in development, and then a path on it is fine).
 */
export function resolveCatalogAddress(text: string, page: string = location.href): string | null {
  const v = text.trim()
  try {
    const u = new URL(v === '' ? DEFAULT_CATALOG_PATH : v, page)
    if (u.username || u.password) return null
    u.hash = ''
    if (u.protocol === 'https:') return u.toString()
    if (u.protocol === 'http:' && u.origin === new URL(page).origin) return u.toString()
    return null
  } catch { return null }
}

// ---- reading what the server says
// eslint-disable-next-line no-control-regex
const clean = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : null)
const sameOriginOrHttps = (u: URL, page: URL): boolean => !u.username && !u.password && (u.protocol === 'https:' || (u.protocol === 'http:' && u.origin === page.origin))

/** The catalog from the JSON the server sent, or null when it is not a catalog of the supported format. Entries that are not usable are left out. */
export function parseCatalog(json: unknown, source: string, page: string = location.href): Catalog | null {
  const o = json as { format?: unknown; version?: unknown; generated?: unknown; plugins?: unknown } | null
  if (!o || typeof o !== 'object' || o.format !== 'ateliermesh-catalog' || o.version !== 1 || !Array.isArray(o.plugins)) return null
  const pageUrl = new URL(page)
  const src = new URL(source)
  const plugins: CatalogEntry[] = []
  const seen = new Set<string>()
  for (const raw of o.plugins.slice(0, MAX_PLUGINS)) {
    const r = raw as Record<string, unknown> | null
    if (!r || typeof r !== 'object') continue
    const id = clean(r['id'], 100), name = clean(r['name'], 120), description = clean(r['description'], 300), license = clean(r['license'], 64), latest = clean(r['latest'], 32)
    if (!id || !PLUGIN_ID_RE.test(id) || seen.has(id) || !name || !description || !license || !latest || !SEMVER_RE.test(latest)) continue
    const versions: CatalogVersion[] = []
    if (Array.isArray(r['versions'])) {
      for (const vr of r['versions'].slice(0, MAX_VERSIONS)) {
        const v = vr as Record<string, unknown> | null
        if (!v || typeof v !== 'object') continue
        const version = clean(v['version'], 32), url = clean(v['url'], 500), sha = clean(v['sha256'], 64)
        if (!version || !SEMVER_RE.test(version) || !url || !sha || !/^[0-9a-f]{64}$/.test(sha)) continue
        let abs: URL
        try { abs = new URL(url, src) } catch { continue }
        if (!sameOriginOrHttps(abs, pageUrl)) continue
        abs.hash = ''
        const size = typeof v['size'] === 'number' && Number.isInteger(v['size']) && v['size'] > 0 && v['size'] <= 50 * 1024 * 1024 ? v['size'] : 0
        if (size === 0) continue
        const uploaded = clean(v['uploaded'], 40)
        versions.push({ version, url: abs.toString(), sha256: sha, size, ...(uploaded ? { uploaded } : {}), signed: v['signed'] === true })
      }
    }
    if (!versions.some(v => v.version === latest)) continue
    versions.sort((a, b) => compareSemver(b.version, a.version))
    const e: CatalogEntry = { id, name, description, license, latest, versions }
    const rep = Array.isArray(r['replaces']) ? [...new Set((r['replaces'] as unknown[]).filter((x): x is string => typeof x === 'string' && x.length <= 100 && PLUGIN_ID_RE.test(x) && x !== id))].slice(0, 8) : []
    if (rep.length > 0) e.replaces = rep
    // a whole number the catalog counted: nothing else is a count (not a string, not negative, not a fraction)
    if (typeof r['downloads'] === 'number' && Number.isInteger(r['downloads']) && r['downloads'] >= 0 && r['downloads'] <= 1e12) e.downloads = r['downloads']
    const c = r['contact'] as Record<string, unknown> | undefined
    if (c && typeof c === 'object') {
      const contact: NonNullable<CatalogEntry['contact']> = {}
      const cn = clean(c['name'], 80); if (cn) contact.name = cn
      if (typeof c['url'] === 'string' && httpsUrlProblem(c['url'], 200) === null) contact.url = c['url']
      if (isValidEmail(c['email'])) contact.email = c['email']
      if (Object.keys(contact).length > 0) e.contact = contact
    }
    const im = r['image'] as Record<string, unknown> | undefined
    if (im && typeof im === 'object') {
      const iu = clean(im['url'], 500), alt = clean(im['alt'], 160)
      if (iu && alt) { try { const abs = new URL(iu, src); if (abs.origin === src.origin && sameOriginOrHttps(abs, pageUrl)) e.image = { url: abs.toString(), alt } } catch { /* no picture */ } }
    }
    seen.add(id)
    plugins.push(e)
  }
  const gen = clean(o.generated, 40)
  return { source, host: src.hostname, ...(gen ? { generated: gen } : {}), plugins }
}

/** Fetch and read the catalog. Never throws: the reason it could not be had comes back instead. */
export async function fetchCatalog(address: string, opts: { fetch?: typeof fetch; timeoutMs?: number; page?: string } = {}): Promise<CatalogResult> {
  const url = resolveCatalogAddress(address, opts.page)
  if (!url) return { ok: false, reason: 'address' }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 10_000)
  try {
    let res: Response
    try { res = await (opts.fetch ?? fetch)(url, { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'follow', signal: ctl.signal, headers: { accept: 'application/json' } }) }
    catch { return { ok: false, reason: ctl.signal.aborted ? 'timeout' : 'network' } }
    if (!res.ok) return { ok: false, reason: 'http', status: res.status }
    const declared = Number(res.headers.get('content-length') ?? NaN)
    if (Number.isFinite(declared) && declared > MAX_BYTES) return { ok: false, reason: 'format' }
    let text: string
    try { text = await res.text() } catch { return { ok: false, reason: ctl.signal.aborted ? 'timeout' : 'network' } }
    if (text.length > MAX_BYTES) return { ok: false, reason: 'format' }
    let json: unknown
    try { json = JSON.parse(text) } catch { return { ok: false, reason: 'format' } }   // a page that is not JSON (a "not found" page, a login page) is no catalog
    const catalog = parseCatalog(json, res.url && res.url !== '' ? res.url : url, opts.page)
    return catalog ? { ok: true, catalog } : { ok: false, reason: 'format' }
  } finally { clearTimeout(timer) }
}

/** The installed plugins that have a newer version in the catalog: plugin id → the catalog entry. `installed` maps plugin id → installed version. */
export function updatesFor(installed: Record<string, string>, catalog: Catalog): Record<string, CatalogEntry> {
  const out: Record<string, CatalogEntry> = {}
  for (const e of catalog.plugins) {
    const have = installed[e.id]
    if (have !== undefined && compareSemver(e.latest, have) > 0) out[e.id] = e
  }
  return out
}

/** The address to fetch a version from, with the checksum pinned (`#sha256=`): the loader then refuses a file that is not the one the catalog described. */
export function pinnedPackageUrl(v: CatalogVersion): string { return `${v.url}#sha256=${v.sha256}` }
/** True when a package address may be fetched over plain http: only a page of this same (http) site, such as a local network or development server. */
export function allowHttpFor(url: string, page: string = location.href): boolean {
  try { const u = new URL(url); return u.protocol === 'http:' && u.origin === new URL(page).origin } catch { return false }
}
