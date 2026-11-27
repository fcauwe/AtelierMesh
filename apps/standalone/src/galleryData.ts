// The example gallery, app side: where the catalogue is, how its pages are read, and the small things around a card. The server side is apps/standalone/server/catalog (gallery.php).
// Everything the server says is data: texts are shown as text, addresses are checked before they are used.

export interface GalleryPlugin { id: string; name: string }
export interface GalleryItem {
  id: string
  name: string
  line?: string
  author?: string
  plugins: GalleryPlugin[]
  opens: number
  size: number
  created: string
  official?: boolean
  picture: string
  project: string
  link: string
  /** The folder of the catalogue it came from (where its open count and reports go), and that catalogue's name (shown when there is more than one). */
  base: string
  catalogue?: string
}
export interface GalleryPage { items: GalleryItem[]; total: number; next: number | null }
export interface GalleryQuery { sort: 'new' | 'popular'; search: string; plugin: string; after: number }

/** The folder address of a catalogue from the address in the settings: either the folder itself or the address of its plugin list (…/catalog.php). Always ends with a slash. */
export function catalogueBase(address: string, page: string | undefined = typeof location !== 'undefined' ? location.href : undefined): string {
  try {
    const u = new URL(address, page)
    u.hash = ''; u.search = ''
    u.pathname = /\.[a-z0-9]+$/i.test(u.pathname) ? u.pathname.replace(/[^/]*$/, '') : u.pathname.replace(/\/?$/, '/')
    return u.toString()
  } catch { return '' }
}

const text = (v: unknown, max: number): string => (typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : '')   // eslint-disable-line no-control-regex

/** An address the server gave for a piece of a design, made absolute against the catalogue's folder and kept only when it stays on that site or is https. */
function safeUrl(v: unknown, base: string): string {
  if (typeof v !== 'string' || v.length > 500) return ''
  try {
    const u = new URL(v, base); const b = new URL(base)
    if (u.username || u.password) return ''
    return u.protocol === 'https:' || (u.protocol === 'http:' && u.origin === b.origin) ? u.toString() : ''
  } catch { return '' }
}

/** Why a page could not be had: `missing` (nothing there that is a gallery: a missing file, a page that is not JSON, another format; a site without a catalogue is quiet) or `down` (no connection, a server error: worth saying). */
export interface GalleryFailure { failed: 'missing' | 'down' }
export const isFailure = (r: GalleryPage | GalleryFailure): r is GalleryFailure => 'failed' in r

/** One page of the list, checked, or why there is none. */
export async function fetchGallery(base: string, q: GalleryQuery, signal?: AbortSignal, f: typeof fetch = fetch): Promise<GalleryPage | GalleryFailure> {
  const p = new URLSearchParams()
  if (q.sort === 'popular') p.set('sort', 'popular')
  if (q.search.trim()) p.set('search', q.search.trim().slice(0, 80))
  if (q.plugin) p.set('plugin', q.plugin)
  if (q.after > 0) p.set('after', String(q.after))
  p.set('limit', '24')
  let json: unknown
  try {
    const r = await f(`${base}gallery.php?${p.toString()}`, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: signal ?? null, headers: { accept: 'application/json' } })
    if (!r.ok) return { failed: r.status >= 500 || r.status === 429 ? 'down' : 'missing' }
    json = JSON.parse(await r.text())
  } catch (e) { return { failed: e instanceof SyntaxError ? 'missing' : 'down' } }
  const o = json as { format?: unknown; version?: unknown; items?: unknown; total?: unknown; next?: unknown } | null
  if (!o || o.format !== 'ateliermesh-gallery' || o.version !== 1 || !Array.isArray(o.items)) return { failed: 'missing' }
  const items: GalleryItem[] = []
  for (const raw of o.items.slice(0, 48)) {
    const r = raw as Record<string, unknown> | null
    if (!r || typeof r !== 'object') continue
    const id = typeof r['id'] === 'string' && /^[a-z2-7]{8}$/.test(r['id']) ? r['id'] : ''
    const name = text(r['name'], 80)
    const picture = safeUrl(r['picture'], base), project = safeUrl(r['project'], base)
    if (!id || !name || !picture || !project) continue
    const plugins = Array.isArray(r['plugins']) ? (r['plugins'] as Array<Record<string, unknown>>).slice(0, 30).map(x => ({ id: text(x?.['id'], 100), name: text(x?.['name'], 120) })).filter(x => x.id !== '').map(x => ({ id: x.id, name: x.name || x.id })) : []
    const e: GalleryItem = { id, name, plugins, opens: Number.isInteger(r['opens']) && (r['opens'] as number) >= 0 ? (r['opens'] as number) : 0, size: Number.isInteger(r['size']) ? (r['size'] as number) : 0, created: text(r['created'], 40), picture, project, link: safeUrl(r['link'], base), base }
    const line = text(r['line'], 80), author = text(r['author'], 60)
    if (line) e.line = line
    if (author) e.author = author
    if (r['official'] === true) e.official = true
    items.push(e)
  }
  const total = Number.isInteger(o.total) && (o.total as number) >= 0 ? (o.total as number) : items.length
  return { items, total, next: Number.isInteger(o.next) && (o.next as number) > 0 ? (o.next as number) : null }
}

/** One more open for a design, at most once a day for each design in this browser. Only the id is sent. Never blocks anything. */
export function countOpen(base: string, id: string, f: typeof fetch = fetch): void {
  const key = `am.opened.${id}`, day = new Date().toISOString().slice(0, 10)
  try { if (localStorage.getItem(key) === day) return; localStorage.setItem(key, day) } catch { /* private window: counted each time */ }
  void f(`${base}gallery.php?open=${encodeURIComponent(id)}`, { method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true }).catch(() => undefined)
}

export type ReportReason = 'broken' | 'not_a_model' | 'not_theirs' | 'offensive' | 'dangerous'
export const REPORT_REASONS: ReportReason[] = ['broken', 'not_a_model', 'not_theirs', 'offensive', 'dangerous']

export async function sendReport(base: string, id: string, reason: ReportReason, f: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await f(`${base}gallery.php?report=${encodeURIComponent(id)}`, { method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', body: new URLSearchParams({ reason }) })
    return r.ok
  } catch { return false }
}

/** The bytes of a design's project file (at most 60 MB). Throws a message-less error when it cannot be had; the caller says "that example is gone". */
export async function fetchProject(url: string, onProgress?: (loaded: number, total: number) => void, signal?: AbortSignal, f: typeof fetch = fetch): Promise<Uint8Array> {
  const r = await f(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: signal ?? null })
  if (!r.ok) throw new Error(String(r.status))
  const total = Number(r.headers.get('content-length') ?? 0)
  if (total > 60 * 1024 * 1024) throw new Error('too large')
  if (!r.body) return new Uint8Array(await r.arrayBuffer())
  const reader = r.body.getReader(); const chunks: Uint8Array[] = []; let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value); n += value.length
    if (n > 60 * 1024 * 1024) throw new Error('too large')
    onProgress?.(n, total)
  }
  const out = new Uint8Array(n); let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  return out
}

/** A short count: below a thousand the whole number; above, one decimal and a "k" (1.2k, 1,2k, 1,2 k). */
export function shortCount(n: number, lang: 'en' | 'nl' | 'fr'): string {
  if (n < 1000) return String(n)
  const v = Math.round(n / 100) / 10, s = (v % 1 === 0 ? String(v) : v.toFixed(1))
  return lang === 'en' ? `${s}k` : lang === 'nl' ? `${s.replace('.', ',')}k` : `${s.replace('.', ',')}${String.fromCharCode(160)}k`
}

/** One catalogue the gallery reads from, with what is left of it: the items already fetched but not shown, where the next page starts (null: no more) and how many it has in all. */
export interface GallerySource { base: string; name: string; buf: GalleryItem[]; next: number | null; total: number; failed: boolean; failure?: 'missing' | 'down'; started: boolean }
export const newSource = (base: string, name: string): GallerySource => ({ base, name, buf: [], next: 0, total: 0, failed: false, started: false })

/** The order the server uses: newest first, or most opened first (then newest). */
const before = (sort: 'new' | 'popular') => (a: GalleryItem, b: GalleryItem): number =>
  (sort === 'popular' ? (b.opens - a.opens) || b.created.localeCompare(a.created) : b.created.localeCompare(a.created)) || a.id.localeCompare(b.id)

/**
 * The next `n` designs of several catalogues as one list in the same order: each catalogue's own pages are already in that order, so the heads of their buffers are merged, and a page is
 * fetched from a catalogue only when its buffer is empty. A catalogue that cannot be reached is left out (`failed`). Returns what was taken; the sources keep their state for the next call.
 */
export async function takeMerged(sources: GallerySource[], q: { sort: 'new' | 'popular'; search: string; plugin: string }, n: number, signal?: AbortSignal, f: typeof fetch = fetch): Promise<GalleryItem[]> {
  const out: GalleryItem[] = []
  const cmp = before(q.sort)
  while (out.length < n) {
    await Promise.all(sources.map(async s => {
      if (s.buf.length > 0 || s.next === null || s.failed) return
      const r = await fetchGallery(s.base, { ...q, after: s.next }, signal, f)
      s.started = true
      if (isFailure(r)) { s.failed = true; s.failure = r.failed; return }   // its place in the list is kept: Try again asks the same page again
      s.buf = r.items.map(i => ({ ...i, catalogue: s.name })); s.next = r.next; s.total = r.total
    }))
    const heads = sources.filter(s => s.buf.length > 0).sort((a, b) => cmp(a.buf[0] as GalleryItem, b.buf[0] as GalleryItem))
    if (heads.length === 0) break
    out.push((heads[0] as GallerySource).buf.shift() as GalleryItem)
  }
  return out
}
export const moreMerged = (sources: GallerySource[]): boolean => sources.some(s => !s.failed && (s.buf.length > 0 || s.next !== null))
export const totalMerged = (sources: GallerySource[]): number => sources.reduce((n, s) => n + (s.failed ? 0 : s.total), 0)

/** What a shared link says in the address: `#design=<id>`. Returns the id, or null. */
export function designFromHash(hash: string): string | null {
  const m = /^#design=([a-z2-7]{8})(?:&|$)/.exec(hash)
  return m ? (m[1] as string) : null
}

/** The catalogue a shared link names (`&catalog=<address of its folder>`), or null. The app uses it only when that catalogue is one it reads. */
export function catalogueFromHash(hash: string): string | null {
  const m = /[&#]catalog=([^&]+)/.exec(hash)
  try { return m ? decodeURIComponent(m[1] as string) : null } catch { return null }
}
