// The catalogues the app reads besides its own: kept in this browser, looked at before they are added, and turned into the addresses the plugin list and the gallery use.
// A catalogue is a folder on a server (see apps/standalone/server/catalog): index.php says what it offers, catalog.php lists plugins, gallery.php lists designs.
import { parseCatalog, resolveCatalogAddress } from './catalog'
import { catalogueBase } from './galleryData'

export interface AddedCatalogue {
  id: string
  name: string
  /** The folder of the catalogue, with a closing slash. */
  base: string
  /** What the person lets it be used for (only what it offers can be on). */
  plugins: boolean
  designs: boolean
  /** How many it offered when it was added. */
  offers: { plugins?: number; designs?: number }
}

const KEY = 'am.catalogues'
const MAX = 8
const clean = (v: unknown, max: number): string => (typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : '')   // eslint-disable-line no-control-regex

/** The catalogues the person added, checked: anything damaged is left out. */
export function readCatalogues(): AddedCatalogue[] {
  let raw: unknown
  try { raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') } catch { return [] }
  if (!Array.isArray(raw)) return []
  const out: AddedCatalogue[] = []
  for (const r of raw.slice(0, MAX) as Array<Record<string, unknown> | null>) {
    if (!r || typeof r !== 'object') continue
    const id = clean(r['id'], 40), name = clean(r['name'], 80), base = typeof r['base'] === 'string' ? catalogueBase(r['base'] as string) : ''
    if (!id || !name || !/^https?:\/\//.test(base) || out.some(x => x.id === id)) continue
    const o = (r['offers'] ?? {}) as Record<string, unknown>
    const offers: AddedCatalogue['offers'] = {}
    if (Number.isInteger(o['plugins'])) offers.plugins = o['plugins'] as number
    if (Number.isInteger(o['designs'])) offers.designs = o['designs'] as number
    out.push({ id, name, base, plugins: r['plugins'] === true && offers.plugins !== undefined, designs: r['designs'] === true && offers.designs !== undefined, offers })
  }
  return out
}

export function saveCatalogues(list: AddedCatalogue[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))) } catch { /* private window: lasts until the page closes */ }
}

export type Probe = { ok: true; name: string; base: string; offers: { plugins?: number; designs?: number } } | { ok: false; reason: 'address' | 'network' | 'format' }

/** Look at an address: the folder's index.php says what it offers; a plain plugin catalogue (only catalog.php) offers plugins. Nothing is kept. */
export async function probeCatalogue(address: string, f: typeof fetch = fetch, page?: string): Promise<Probe> {
  const url = resolveCatalogAddress(address, page)
  if (url === null || address.trim() === '') return { ok: false, reason: 'address' }
  const base = catalogueBase(url, page)
  if (base === '') return { ok: false, reason: 'address' }
  const get = async (u: string): Promise<{ ok: boolean; json: unknown; net: boolean }> => {
    try { const r = await f(u, { credentials: 'omit', referrerPolicy: 'no-referrer', headers: { accept: 'application/json' } }); if (!r.ok) return { ok: false, json: null, net: false }; return { ok: true, json: JSON.parse(await r.text()), net: false } }
    catch (e) { return { ok: false, json: null, net: !(e instanceof SyntaxError) } }
  }
  const idx = await get(`${base}index.php`)
  const o = idx.json as { format?: unknown; version?: unknown; name?: unknown; offers?: { plugins?: { count?: unknown }; designs?: { count?: unknown } } } | null
  if (idx.ok && o && o.format === 'ateliermesh-catalogue' && o.version === 1) {
    const offers: { plugins?: number; designs?: number } = {}
    const p = o.offers?.plugins?.count, d = o.offers?.designs?.count
    if (Number.isInteger(p)) offers.plugins = p as number
    if (Number.isInteger(d)) offers.designs = d as number
    return { ok: true, name: clean(o.name, 80) || new URL(base).host, base, offers }
  }
  const pl = await get(`${base}catalog.php`)
  if (pl.ok) { const c = parseCatalog(pl.json, `${base}catalog.php`, page); if (c) return { ok: true, name: new URL(base).host, base, offers: { plugins: c.plugins.length } } }
  return { ok: false, reason: idx.net || pl.net ? 'network' : 'format' }
}

/** The address of a catalogue's plugin list. */
export const pluginListAddress = (base: string): string => `${base}catalog.php`
