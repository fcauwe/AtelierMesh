import { beforeEach, describe, expect, it } from 'vitest'
import { probeCatalogue, readCatalogues, saveCatalogues } from '../src/catalogues'
import { newSource, takeMerged } from '../src/galleryData'
import type { GalleryItem } from '../src/galleryData'

const PAGE = 'https://app.example.org/'
const item = (id: string, created: string, opens = 0): GalleryItem => ({ id, name: id, plugins: [], opens, size: 1, created, picture: 'p', project: 'q', link: '', base: '' })
const serve = (lists: Record<string, GalleryItem[]>, fail: string[] = []): typeof fetch => async (u) => {
  const url = new URL(String(u)), base = `${url.origin}${url.pathname.replace(/gallery\.php$/, '')}`
  if (fail.includes(base)) return new Response('x', { status: 500 })
  const all = [...(lists[base] ?? [])].sort((a, b) => (url.searchParams.get('sort') === 'popular' ? b.opens - a.opens || b.created.localeCompare(a.created) : b.created.localeCompare(a.created)) || a.id.localeCompare(b.id))
  const after = Number(url.searchParams.get('after') ?? 0), limit = 2   // pages of two, to make the merge work
  const items = all.slice(after, after + limit)
  return new Response(JSON.stringify({ format: 'ateliermesh-gallery', version: 1, total: all.length, next: after + limit < all.length ? after + limit : null, items: items.map(i => ({ ...i, picture: 'gallery.php?picture=' + i.id, project: 'gallery.php?project=' + i.id, link: '' })) }))
}
const A = 'https://a.example.org/cat/', B = 'https://b.example.org/cat/'

describe('several catalogues as one gallery', () => {
  const lists = { [A]: [item('aaaaaaaa', '2026-11-05'), item('aaaaaaab', '2026-11-03'), item('aaaaaaac', '2026-11-01')], [B]: [item('bbbbbbbb', '2026-11-04'), item('bbbbbbbc', '2026-11-02')] }
  it('merges by the same order as each catalogue, newest first, and names where each came from', async () => {
    const srcs = [newSource(A, 'Alpha'), newSource(B, 'Beta')]
    const got = await takeMerged(srcs, { sort: 'new', search: '', plugin: '' }, 10, undefined, serve(lists))
    expect(got.map(i => i.id)).toEqual(['aaaaaaaa', 'bbbbbbbb', 'aaaaaaab', 'bbbbbbbc', 'aaaaaaac'])
    expect(got.map(i => i.catalogue)).toEqual(['Alpha', 'Beta', 'Alpha', 'Beta', 'Alpha'])
  })
  it('pages on: the next call goes on where the last stopped, and only asks a catalogue when its buffer is empty', async () => {
    const srcs = [newSource(A, 'Alpha'), newSource(B, 'Beta')]
    const f = serve(lists); let asked = 0
    const counted: typeof fetch = async (u, i) => { asked++; return f(u, i) }
    const first = await takeMerged(srcs, { sort: 'new', search: '', plugin: '' }, 3, undefined, counted)
    const second = await takeMerged(srcs, { sort: 'new', search: '', plugin: '' }, 3, undefined, counted)
    expect([...first, ...second].map(i => i.id)).toEqual(['aaaaaaaa', 'bbbbbbbb', 'aaaaaaab', 'bbbbbbbc', 'aaaaaaac'])
    expect(asked).toBeLessThanOrEqual(5)   // pages of two: A twice, B once at most twice
  })
  it('sorts by opens when asked, and leaves out a catalogue that cannot be reached (Try again asks it again)', async () => {
    const pop = { [A]: [item('aaaaaaaa', '2026-11-05', 1), item('aaaaaaab', '2026-11-03', 9)], [B]: [item('bbbbbbbb', '2026-11-04', 5)] }
    expect((await takeMerged([newSource(A, 'Alpha'), newSource(B, 'Beta')], { sort: 'popular', search: '', plugin: '' }, 5, undefined, serve(pop))).map(i => i.id)).toEqual(['aaaaaaab', 'bbbbbbbb', 'aaaaaaaa'])
    const srcs = [newSource(A, 'Alpha'), newSource(B, 'Beta')]
    const got = await takeMerged(srcs, { sort: 'new', search: '', plugin: '' }, 5, undefined, serve(lists, [B]))
    expect(got.map(i => i.id)).toEqual(['aaaaaaaa', 'aaaaaaab', 'aaaaaaac']); expect(srcs[1]?.failed).toBe(true); expect(srcs[1]?.failure).toBe('down')
  })
})

describe('looking at a catalogue before it is added', () => {
  const json = (o: unknown, status = 200): Response => new Response(JSON.stringify(o), { status })
  it('reads the description a catalogue gives, with what it offers', async () => {
    const f: typeof fetch = async u => String(u) === 'https://c.example.org/mesh/index.php' ? json({ format: 'ateliermesh-catalogue', version: 1, name: 'Voronoi club', offers: { plugins: { url: 'catalog.php', count: 3 }, designs: { url: 'gallery.php', count: 0 } } }) : json({}, 404)
    expect(await probeCatalogue('https://c.example.org/mesh', f, PAGE)).toEqual({ ok: true, name: 'Voronoi club', base: 'https://c.example.org/mesh/', offers: { plugins: 3, designs: 0 } })
    expect(await probeCatalogue('https://c.example.org/mesh/catalog.php', f, PAGE)).toMatchObject({ ok: true, base: 'https://c.example.org/mesh/' })   // the old address of a plugin list works too
  })
  it('takes a plain plugin catalogue (only catalog.php) as offering plugins', async () => {
    const f: typeof fetch = async u => String(u).endsWith('/catalog.php') ? json({ format: 'ateliermesh-catalog', version: 1, plugins: [{ id: 'org.x.y', name: 'Y', description: 'd', license: 'MIT', latest: '1.0.0', versions: [{ version: '1.0.0', url: 'y.amplugin', sha256: 'a'.repeat(64), size: 10, signed: false }] }] }) : json({}, 404)
    expect(await probeCatalogue('https://d.example.org/c/', f, PAGE)).toEqual({ ok: true, name: 'd.example.org', base: 'https://d.example.org/c/', offers: { plugins: 1 } })
  })
  it('says why it is no catalogue: a bad address, nothing there, a page that is not one, no connection', async () => {
    const ok404: typeof fetch = async () => json({}, 404)
    expect(await probeCatalogue('', ok404, PAGE)).toEqual({ ok: false, reason: 'address' })
    expect(await probeCatalogue('ftp://x.example.org/', ok404, PAGE)).toEqual({ ok: false, reason: 'address' })
    expect(await probeCatalogue('https://e.example.org/', ok404, PAGE)).toEqual({ ok: false, reason: 'format' })
    expect(await probeCatalogue('https://e.example.org/', async () => new Response('<html>'), PAGE)).toEqual({ ok: false, reason: 'format' })
    expect(await probeCatalogue('https://e.example.org/', async () => { throw new TypeError('network') }, PAGE)).toEqual({ ok: false, reason: 'network' })
  })
})

describe('the catalogues kept in this browser', () => {
  beforeEach(() => { const m = new Map<string, string>(); (globalThis as unknown as { localStorage: Storage }).localStorage = { getItem: k => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v) }, removeItem: k => { m.delete(k) }, clear: () => m.clear(), key: () => null, length: 0 } })
  it('keeps what was added, and drops what is damaged or not an address', () => {
    saveCatalogues([{ id: 'one', name: 'Alpha', base: 'https://a.example.org/cat/', plugins: true, designs: false, offers: { plugins: 2 } }])
    expect(readCatalogues()).toEqual([{ id: 'one', name: 'Alpha', base: 'https://a.example.org/cat/', plugins: true, designs: false, offers: { plugins: 2 } }])
    localStorage.setItem('am.catalogues', JSON.stringify([{ id: 'x', name: 'Bad', base: 'javascript:alert(1)' }, { id: 'y', name: '', base: 'https://a.example.org/' }, null, 5, { id: 'z', name: 'Odd', base: 'https://z.example.org/c', plugins: true, designs: true, offers: { plugins: 1 } }]))
    expect(readCatalogues().map(c => [c.id, c.plugins, c.designs])).toEqual([['z', true, false]])   // a use needs an offer
    localStorage.setItem('am.catalogues', 'not json'); expect(readCatalogues()).toEqual([])
  })
})
