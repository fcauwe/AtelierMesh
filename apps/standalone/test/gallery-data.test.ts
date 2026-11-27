import { describe, expect, it } from 'vitest'
import { catalogueBase, designFromHash, fetchGallery, shortCount } from '../src/galleryData'

const base = 'https://cat.example.org/mesh/'
const page = (items: unknown[], extra: object = {}): Response => new Response(JSON.stringify({ format: 'ateliermesh-gallery', version: 1, total: items.length, next: null, items, ...extra }))
const good = { id: 'abcdefgh', name: 'Vase', plugins: [{ id: 'org.example.twist', name: 'Twist' }], opens: 3, size: 100, created: '2026-11-21T10:00:00+00:00', picture: 'gallery.php?picture=abcdefgh', project: 'gallery.php?project=abcdefgh', link: 'e/abcdefgh' }

describe('the gallery data', () => {
  it('finds the folder of a catalogue from the address in the settings', () => {
    expect(catalogueBase('https://cat.example.org/mesh/catalog.php')).toBe('https://cat.example.org/mesh/')
    expect(catalogueBase('https://cat.example.org/mesh')).toBe('https://cat.example.org/mesh/')
    expect(catalogueBase('https://cat.example.org/mesh/?x=1#y')).toBe('https://cat.example.org/mesh/')
  })
  it('counts short: whole below a thousand, one decimal above, by language', () => {
    expect([shortCount(980, 'en'), shortCount(1234, 'en'), shortCount(1234, 'nl'), shortCount(1234, 'fr'), shortCount(2000, 'en')]).toEqual(['980', '1.2k', '1,2k', '1,2 k', '2k'])
  })
  it('reads #design=<id> and nothing else', () => {
    expect(designFromHash('#design=abcdefgh')).toBe('abcdefgh')
    expect(designFromHash('#design=abcdefgh&catalog=x')).toBe('abcdefgh')
    for (const h of ['', '#design=abc', '#design=ABCDEFGH', '#design=abcdefgh1', '#x=abcdefgh', '#design=abcdefg0']) expect(designFromHash(h), h).toBeNull()
  })
  it('reads a page and makes addresses absolute', async () => {
    const r = await fetchGallery(base, { sort: 'new', search: '', plugin: '', after: 0 }, undefined, async () => page([good], { total: 30, next: 24 }))
    expect(r).not.toHaveProperty('failed')
    if ('failed' in r) return
    expect(r.total).toBe(30); expect(r.next).toBe(24)
    expect(r.items[0]).toMatchObject({ id: 'abcdefgh', name: 'Vase', picture: `${base}gallery.php?picture=abcdefgh`, project: `${base}gallery.php?project=abcdefgh`, link: `${base}e/abcdefgh`, plugins: [{ id: 'org.example.twist', name: 'Twist' }] })
  })
  it('asks with the sort, the search, the plugin and the offset, and never with cookies', async () => {
    let url = '', init: RequestInit | undefined
    await fetchGallery(base, { sort: 'popular', search: ' vase ', plugin: 'org.example.twist', after: 24 }, undefined, async (u, i) => { url = String(u); init = i; return page([]) })
    const q = new URL(url).searchParams
    expect([q.get('sort'), q.get('search'), q.get('plugin'), q.get('after'), q.get('limit')]).toEqual(['popular', 'vase', 'org.example.twist', '24', '24'])
    expect(init?.credentials).toBe('omit'); expect(init?.referrerPolicy).toBe('no-referrer')
  })
  it('refuses what is not a gallery and leaves out entries that are not usable', async () => {
    const ask = (f: typeof fetch) => fetchGallery(base, { sort: 'new', search: '', plugin: '', after: 0 }, undefined, f)
    expect(await ask(async () => new Response('not json'))).toEqual({ failed: 'missing' })   // a site without a catalogue: quiet
    expect(await ask(async () => new Response('{}', { status: 404 }))).toEqual({ failed: 'missing' })
    expect(await ask(async () => new Response(JSON.stringify({ format: 'other', version: 1, items: [] })))).toEqual({ failed: 'missing' })
    expect(await ask(async () => new Response('x', { status: 500 }))).toEqual({ failed: 'down' })   // a server that is there but broken: worth saying
    expect(await ask(async () => { throw new TypeError('network') })).toEqual({ failed: 'down' })
    const r = await fetchGallery(base, { sort: 'new', search: '', plugin: '', after: 0 }, undefined, async () => page([
      good, { ...good, id: 'BAD' }, { ...good, name: '' }, { ...good, name: 'a\u0001b' }, { ...good, picture: 'javascript:alert(1)' }, { ...good, project: 'http://evil.example/x' }, { ...good, picture: 'https://u:p@evil.example/x.png' }, null, 'x',
    ]))
    expect('failed' in r ? [] : r.items.map(i => i.id)).toEqual(['abcdefgh'])
  })
})
