import { Buffer } from 'node:buffer'
import { chromium, webkit } from 'playwright-core'
import type { Browser, Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { emptyStepList, saveProject } from '@ateliermesh/core'
import { buildPluginPackage } from '@ateliermesh/loader'
import { sphereMesh } from '@ateliermesh/core/testing'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The example gallery on the start page, against a catalogue answered by the test: cards, pages that come by scrolling and by the button, sort and search, opening an example, share, report, a shared link, and the built-in samples when there is no catalogue.
const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(here, '../dist')
const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.svg': 'image/svg+xml' }
let server: Server, base = ''
beforeAll(async () => {
  server = createServer((req, res) => {
    const u = (req.url ?? '/').split('?')[0] as string
    const p = path.join(dist, u === '/' ? 'index.html' : decodeURIComponent(u))
    if (!p.startsWith(dist) || !fs.existsSync(p)) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' }).end(fs.readFileSync(p))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
})
afterAll(() => { server?.close() })

const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const axe = async (page: Page): Promise<string[]> => {
  await page.addScriptTag({ path: axePath })
  const v = await page.evaluate(async () => (await (window as unknown as { axe: { run: (c?: object, o?: object) => Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ target: string[] }> }> }> } }).axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] })).violations)
  return v.map(x => `${x.id}: ${x.help} -> ${x.nodes.map(n => n.target.join(' ')).join(', ')}`)
}
const GL = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const ids = Array.from({ length: 30 }, (_, i) => `${'abcdefghijklmnopqrstuvwxyz'.slice(i % 20, (i % 20) + 4)}${String(i).padStart(2, '2').replace(/[0189]/g, '3')}${'a'}${'b'}`.slice(0, 8).padEnd(8, 'a')).map((x, i) => `${'abcdefgh'.slice(0, 6)}${'abcdefghijklmnopqrstuvwxyz234567'[Math.floor(i / 5)]}${'abcdefghijklmnopqrstuvwxyz234567'[i % 5 + 10]}`)
const item = (i: number) => ({ id: ids[i], name: i === 1 ? 'Voronoi-lampenkap met gedraaide sokkel voor E27-fitting' : `Design ${i + 1}`, ...(i % 3 === 0 ? { author: 'Anna' } : {}), plugins: i === 1 ? [{ id: 'org.example.voronoi', name: 'Voronoi shell' }] : [{ id: 'org.ateliermesh.core', name: 'Core' }], opens: i === 0 ? 1234 : i, size: 1000, created: '2026-11-21T10:00:00+00:00', picture: `gallery.php?picture=${ids[i]}`, project: `gallery.php?project=${ids[i]}`, link: `e/${ids[i]}`, ...(i === 2 ? { official: true } : {}) })
const project = (): Buffer => Buffer.from(saveProject({ name: 'From the gallery', base: sphereMesh(10, 3), list: emptyStepList(), rollback: null, assets: [] }))

for (const [name, type] of [['chromium', chromium], ['webkit', webkit]] as const) {
  describe(`the example gallery in ${name}`, () => {
    let browser: Browser | null = null
    beforeAll(async () => {
      try { browser = await type.launch({ headless: true, ...(name === 'chromium' ? { args: GL } : {}) }) }
      catch (e) { console.warn(`${name} is not available here: ${String(e).split('\n')[0]}`) }
    })
    afterAll(async () => { await browser?.close() })
    const pages: Page[] = []
    afterEach(async () => { await Promise.all(pages.splice(0).map(p => p.close().catch(() => undefined))) })

    /** A page whose catalogue answers like the real one: 30 designs in pages of 24. `seen` collects the requests. */
    const open = async (opts: { empty?: boolean; share?: { state: string; reason?: string; rate?: boolean }; loadingDelay?: number; down?: boolean | 'broken'; slow?: boolean; gone?: boolean; catalogPlugins?: boolean; failMore?: { on: boolean }; clipboard?: boolean; viewport?: { width: number; height: number } } = {}): Promise<{ page: Page; seen: string[]; posts: string[] }> => {
      const ctx = await browser!.newContext({ viewport: opts.viewport ?? { width: 1280, height: 900 }, ...(opts.clipboard && name === 'chromium' ? { permissions: ['clipboard-read', 'clipboard-write'] } : {}) })
      const page = await ctx.newPage(); pages.push(page)
      page.on('pageerror', e => { if (!/Importing a module script failed|due to access control checks/.test(String(e))) throw e })   // a page that is closed while it still loads is not a failure
      const seen: string[] = [], posts: string[] = []
      await page.route('**/catalog/gallery.php**', async r => {
        const u = new URL(r.request().url()); seen.push(u.search)
        if (opts.down) return r.fulfill({ status: opts.down === 'broken' ? 500 : 404, body: 'no' })
        if (opts.share && u.searchParams.has('status')) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: opts.share.state, ...(opts.share.reason ? { reason: opts.share.reason } : {}) }) })
        if (r.request().method() === 'POST') { posts.push(`${u.search} ${r.request().postData() ?? ''}`); return r.fulfill({ status: u.searchParams.has('report') ? 201 : 204, contentType: 'application/json', body: u.searchParams.has('report') ? '{"ok":true}' : '' }) }
        if (u.searchParams.has('picture')) return r.fulfill({ status: 200, contentType: 'image/png', body: PNG })
        if (u.searchParams.has('project')) { if (opts.gone) return r.fulfill({ status: 404, body: 'gone' }); if (opts.slow) await new Promise(res => setTimeout(res, 1500)); return r.fulfill({ status: 200, contentType: 'application/octet-stream', body: project() }) }
        const after = Number(u.searchParams.get('after') ?? 0)
        if (opts.failMore?.on && after > 0) return r.fulfill({ status: 500, body: 'x' })
        let all = opts.empty ? [] : Array.from({ length: 30 }, (_, i) => item(i))
        const q = (u.searchParams.get('search') ?? '').toLowerCase(); if (q) all = all.filter(x => x.name.toLowerCase().includes(q))
        const plug = u.searchParams.get('plugin'); if (plug) all = all.filter(x => x.plugins.some(p => p.id === plug))
        if (u.searchParams.get('sort') === 'popular') all = [...all].reverse()   // no sort given means the newest first, as the real server does
        const items = all.slice(after, after + 24)
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ format: 'ateliermesh-gallery', version: 1, total: all.length, next: after + 24 < all.length ? after + 24 : null, items }) })
      })
      if (opts.share) await page.route('**/catalog/submit.php', r => { const body = r.request().postDataBuffer()?.toString('latin1') ?? ''; posts.push(`submit ${body.replace(/[^\x20-\x7e\r\n]+/g, "")}`); return opts.share?.rate ? r.fulfill({ status: 429, contentType: 'application/json', body: '{"error":"rate"}' }) : r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'sharedaa', key: 'a'.repeat(32), state: 'pending' }) }) })
      if (opts.catalogPlugins) await page.route('**/catalog/catalog.php*', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ format: 'ateliermesh-catalog', version: 1, generated: '2026-11-21T00:00:00Z', plugins: [{ id: 'org.example.voronoi', name: 'Voronoi shell', description: 'x', license: 'MIT', latest: '1.0.0', versions: [{ version: '1.0.0', url: 'p/x.amplugin', sha256: 'a'.repeat(64), size: 100, signed: false }] }] }) }))
      await page.goto(opts.loadingDelay !== undefined ? `${base}?loadingDelay=${opts.loadingDelay}` : base)
      return { page, seen, posts }
    }

    it('shows the catalogue as cards, pages on by scrolling and by the button, and ends with an invitation', async ctx => {
      if (!browser) return ctx.skip()
      const { page, seen } = await open({ viewport: { width: 1280, height: 600 } })   // short, so the end of the first page is out of sight and nothing is loaded before the scroll
      const grid = page.locator('.am-ggrid .am-gcard:not(.am-gskel *)')
      await page.getByRole('heading', { name: 'Examples' }).waitFor()
      expect(await page.locator('[aria-label="Samples"]').count()).toBe(0)   // the catalogue is there: no built-in samples
      await page.locator('.am-gcard h3').first().waitFor()
      expect(await page.locator('li:not(.am-gskel) > .am-gcard').count()).toBe(24)
      await page.getByText('24 of 30 examples').waitFor()
      const card = page.locator('article', { hasText: 'Voronoi-lampenkap' })
      await card.getByText('needs Voronoi shell').waitFor()   // a plugin this browser does not have: a calm dashed chip
      await page.locator('article', { hasText: 'Design 1' }).first().getByText('1.2k opened').waitFor()
      await page.locator('article', { hasText: 'Design 3' }).getByText('AtelierMesh', { exact: true }).waitFor()   // the official pill
      void grid
      // scrolling to the end loads the rest by itself
      await page.locator('.am-gfoot').scrollIntoViewIfNeeded()
      await page.getByText(/That.s all 30 examples/).waitFor({ timeout: 20000 })
      expect(await page.locator('li:not(.am-gskel) > .am-gcard').count()).toBe(30)
      expect(seen.some(s => s.includes('after=24'))).toBe(true)
      await page.getByRole('button', { name: 'Back to the top' }).waitFor()
    }, 120000)

    it('sorts, searches and filters by plugin, and says so when nothing matches', async ctx => {
      if (!browser) return ctx.skip()
      const { page, seen } = await open()
      await page.locator('li:not(.am-gskel) > .am-gcard').first().waitFor()
      await page.getByRole('button', { name: 'Popular' }).click()
      await page.waitForFunction(() => document.querySelector('li:not(.am-gskel) > .am-gcard h3')?.textContent === 'Design 30')
      expect(seen.some(s => s.includes('sort=popular'))).toBe(true)
      await page.getByLabel('Search examples').fill('voronoi')
      await page.waitForFunction(() => document.querySelectorAll('li:not(.am-gskel) > .am-gcard').length === 1)
      await page.getByLabel('Search examples').fill('zzzz')
      await page.getByText(/No example matches/).waitFor()
      await page.getByRole('button', { name: 'Clear the search' }).first().click()
      await page.locator('li:not(.am-gskel) > .am-gcard').first().waitFor()
      await page.getByLabel('Plugin').selectOption('org.ateliermesh.core')   // the plugins this browser has
      await page.getByText('24 of 29 examples').waitFor()   // 29 of the 30 use it, the first page shows 24
    }, 120000)

    it('opens an example in the editor and counts the open once; a shared link opens it too', async ctx => {
      if (!browser) return ctx.skip()
      const { page, posts } = await open()
      await page.locator('article', { hasText: 'Design 5' }).getByRole('link', { name: 'Design 5' }).click()
      await page.getByText('From the gallery').first().waitFor({ timeout: 60000 })   // the project's name is the editor's title
      expect(posts.filter(p => p.includes('open='))).toHaveLength(1)
      // a link: #design=<id> goes straight in
      const { page: p2 } = await open().then(async o => { await o.page.goto(`${base}#design=${ids[3]}`); return o })
      await p2.getByText('From the gallery').first().waitFor({ timeout: 60000 })
      expect(p2.url()).not.toContain('#design')
    }, 180000)

    it('copies the link of an example, and reports one with a fixed reason', async ctx => {
      if (!browser) return ctx.skip()
      const { page, posts } = await open({ clipboard: true })
      const card = page.locator('article', { hasText: 'Design 7' })
      await card.getByRole('button', { name: /^More for Design 7/ }).click()
      await card.getByRole('menuitem', { name: 'Copy link' }).click()
      await page.getByText(/Link copied|\/e\//).first().waitFor()   // where the browser refuses the clipboard the link itself is shown
      if (name === 'chromium') expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(`e/${ids[6]}`)
      await card.getByRole('button', { name: /^More for Design 7/ }).click()
      await card.getByRole('menuitem', { name: 'Report…' }).click()
      const dlg = page.getByRole('dialog', { name: 'Report this example' })
      expect(await dlg.getByRole('button', { name: 'Send report' }).isDisabled()).toBe(true)   // a reason first
      await dlg.getByLabel('It’s offensive or inappropriate').check()
      await dlg.getByRole('button', { name: 'Send report' }).click()
      await page.getByRole('dialog', { name: 'Thanks for telling us' }).waitFor()
      expect(posts.some(p => p.includes(`report=${ids[6]}`) && p.includes('reason=offensive'))).toBe(true)
    }, 120000)

    it('keeps the cards when a later page fails, and offers Try again', async ctx => {
      if (!browser) return ctx.skip()
      const fail = { on: true }
      const { page } = await open({ failMore: fail })
      await page.locator('li:not(.am-gskel) > .am-gcard').first().waitFor()
      await page.getByRole('button', { name: /^Show \d+ more/ }).click()
      await page.getByText('Couldn’t load more examples.').waitFor()   // the next page fails: the cards stay
      expect(await page.locator('li:not(.am-gskel) > .am-gcard').count()).toBe(24)
      fail.on = false
      await page.getByRole('button', { name: 'Try again' }).click()
      await page.waitForFunction(() => document.querySelectorAll('li:not(.am-gskel) > .am-gcard').length === 30)
    }, 120000)

    it('without a catalogue the built-in samples show as they always did', async ctx => {
      if (!browser) return ctx.skip()
      const { page } = await open({ down: true })
      await page.getByRole('button', { name: 'Plate 60 x 30 x 4' }).waitFor()
      expect(await page.getByRole('heading', { name: 'Examples' }).count()).toBe(0)
    }, 120000)

    it('asks before downloading an example that needs a plugin this browser lacks: Cancel does nothing, Open anyway opens it, the catalogue is named when it has the plugin', async ctx => {
      if (!browser) return ctx.skip()
      const { page, posts } = await open({ catalogPlugins: true })
      const card = page.locator('article', { hasText: 'Voronoi-lampenkap' })
      await card.getByRole('link', { name: /Voronoi-lampenkap/ }).click()
      const dlg = page.getByRole('dialog', { name: 'This example needs a plugin' })
      await dlg.getByText('Voronoi shell').waitFor()
      await dlg.getByText(/From the .* catalogue/).waitFor()   // the catalogue has it
      await dlg.getByRole('button', { name: 'Cancel' }).click()
      await dlg.waitFor({ state: 'detached' })
      expect(posts.filter(p => p.includes('open='))).toHaveLength(0)   // nothing was fetched or counted
      await card.getByRole('link', { name: /Voronoi-lampenkap/ }).click()
      await page.getByRole('dialog', { name: 'This example needs a plugin' }).getByRole('button', { name: 'Open anyway' }).click()
      await page.getByText('From the gallery').first().waitFor({ timeout: 60000 })
      expect(posts.filter(p => p.includes('open='))).toHaveLength(1)
    }, 120000)

    it('the plugin filter has the plugins of the catalogue that are not installed', async ctx => {
      if (!browser) return ctx.skip()
      const { page } = await open({ catalogPlugins: true })
      await page.locator('li:not(.am-gskel) > .am-gcard').first().waitFor()
      await page.locator('#am-gplugin optgroup[label="In the catalogue"] option', { hasText: 'Voronoi shell' }).waitFor({ state: 'attached', timeout: 20000 })
    }, 120000)

    it('while an example downloads, its own page shows its picture, name and the line about the copy', async ctx => {
      if (!browser) return ctx.skip()
      const { page } = await open({ slow: true, loadingDelay: 0 })
      await page.locator('article', { hasText: 'Design 5' }).getByRole('link', { name: 'Design 5' }).click()
      const intro = page.locator('.am-loadintro')
      await intro.getByText('Opening Design 5').waitFor()
      await intro.getByText('You get your own copy. Changes stay with you.').waitFor()
      expect(await intro.locator('img').getAttribute('src')).toContain('picture=')
      await page.getByText('From the gallery').first().waitFor({ timeout: 60000 })
    }, 120000)

    it('says so, quietly, when the catalogue is broken (not when the site simply has none), and a link to a removed example lands on the start page with a note', async ctx => {
      if (!browser) return ctx.skip()
      const { page } = await open({ down: 'broken' })
      await page.getByText(/example catalogue can.t be reached/).waitFor()
      await page.getByRole('button', { name: 'Plate 60 x 30 x 4' }).waitFor()   // the built-in samples are there
      await page.getByRole('button', { name: 'Try again' }).click()
      await page.getByText(/example catalogue can.t be reached/).waitFor()
      const quiet = await open({ down: true })
      await quiet.page.getByRole('button', { name: 'Plate 60 x 30 x 4' }).waitFor()
      expect(await quiet.page.getByText(/example catalogue can.t be reached/).count()).toBe(0)
      const gone = await open({ gone: true })
      await gone.page.goto(`${base}#design=${ids[2]}`)
      await gone.page.getByText('Example removed').waitFor({ timeout: 30000 })
      await gone.page.getByText(/removed, by its maker/).waitFor()
    }, 120000)

    it('passes axe on the start page with the gallery, light and dark, in English, Dutch and French', async ctx => {
      if (!browser) return ctx.skip()
      const { page } = await open()
      await page.locator('li:not(.am-gskel) > .am-gcard').first().waitFor()
      for (const lang of ['en', 'nl', 'fr']) {
        await page.getByRole('combobox', { name: /Language|Taal|Langue/ }).selectOption(lang)
        for (const scheme of ['light', 'dark'] as const) { await page.emulateMedia({ colorScheme: scheme }); expect(await axe(page), `${lang} ${scheme}`).toEqual([]) }
      }
    }, 120000)

    it('adds a catalogue in the settings (looked at first, asked about, kept), shows its designs in the same gallery with its name, and removes it again', async ctx => {
      if (!browser) return ctx.skip()
      const { page } = await open()
      const cors = { 'access-control-allow-origin': '*' }
      const other = Array.from({ length: 3 }, (_, i) => ({ ...item(i), id: `zzzzzzz${'abc'[i]}`, name: `Club design ${i + 1}`, created: `2026-12-0${i + 1}T10:00:00+00:00`, picture: `gallery.php?picture=zzzzzzz${'abc'[i]}`, project: `gallery.php?project=zzzzzzz${'abc'[i]}` }))
      await page.route('https://other.example.org/**', async r => {
        const u = new URL(r.request().url())
        if (u.pathname.endsWith('/index.php')) return r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ format: 'ateliermesh-catalogue', version: 1, name: 'Voronoi club', offers: { plugins: { url: 'catalog.php', count: 1 }, designs: { url: 'gallery.php', count: 3 } } }) })
        if (u.pathname.endsWith('/gallery.php')) { if (u.searchParams.has('picture')) return r.fulfill({ status: 200, contentType: 'image/png', headers: cors, body: PNG }); return r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ format: 'ateliermesh-gallery', version: 1, total: 3, next: null, items: other }) }) }
        return r.fulfill({ status: 404, headers: cors, body: 'no' })
      })
      await page.locator('li:not(.am-gskel) > .am-gcard').first().waitFor()
      await page.getByText('24 of 30 examples').waitFor()
      await page.getByRole('button', { name: 'Settings' }).click()
      const st = page.getByRole('dialog', { name: 'Settings' })
      await st.getByRole('tab', { name: 'Catalogues' }).click()
      await st.getByRole('button', { name: 'Add a catalogue' }).click()
      await st.getByLabel('Address', { exact: true }).fill('http://insecure.example.org/'); await st.getByRole('button', { name: 'Check address' }).click()
      await st.getByText(/not a usable address/).waitFor()   // https only
      await st.getByLabel('Name', { exact: true }).fill('Voronoi club'); await st.getByLabel('Address', { exact: true }).fill('https://other.example.org/mesh/'); await st.getByRole('button', { name: 'Check address' }).click()
      const ask = page.getByRole('alertdialog', { name: 'What is this catalogue?' })
      await ask.getByText('https://other.example.org/mesh/').waitFor()
      await ask.getByText(/not check what this catalogue offers|doesn.t check what this catalogue offers/).waitFor()
      expect(await ask.getByLabel('Plugins').isChecked()).toBe(true)
      expect(await ask.getByLabel('Examples').isChecked()).toBe(true)
      await ask.getByRole('button', { name: 'Cancel' }).click()   // nothing is added by looking
      expect(await st.getByRole('region', { name: 'Voronoi club' }).count()).toBe(0)
      await st.getByRole('button', { name: 'Check address' }).click()
      await page.getByRole('alertdialog', { name: 'What is this catalogue?' }).getByRole('button', { name: 'Add catalogue' }).click()
      const card = st.getByRole('region', { name: 'Voronoi club' })
      await card.getByText('Examples · 3').waitFor(); await card.getByText('Plugins · 1').waitFor()
      await card.getByRole('button', { name: /Remove Voronoi club/ }).waitFor()
      await st.getByRole('button', { name: 'Close' }).click()
      // its designs are in the same gallery, named; the count is of both
      await page.getByText(/24 of 33 examples/).waitFor({ timeout: 20000 })
      await page.locator('article', { hasText: 'Club design 3' }).getByText('Voronoi club', { exact: true }).waitFor()
      expect(await page.locator('article', { hasText: 'Design 5' }).first().getByText('Voronoi club').count()).toBe(0)   // the default's cards carry no second name... only when asked
      // kept in this browser
      await page.reload()
      await page.locator('article', { hasText: 'Club design 3' }).waitFor()
      await page.getByRole('button', { name: 'Settings' }).click()
      await page.getByRole('dialog', { name: 'Settings' }).getByRole('tab', { name: 'Catalogues' }).click()
      await page.getByRole('region', { name: 'Voronoi club' }).getByRole('button', { name: /Remove Voronoi club/ }).click()
      await page.getByRole('region', { name: 'Voronoi club' }).waitFor({ state: 'detached' })
      await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Close' }).click()
      await page.getByText('24 of 30 examples').waitFor({ timeout: 20000 })
    }, 180000)

    it('a plugin an example needs is looked for in every catalogue, in the order of the list, and the question names the one that has it', async ctx => {
      if (!browser) return ctx.skip()
      const { page } = await open()
      await page.addInitScript(() => { localStorage.setItem('am.catalogues', JSON.stringify([{ id: 'club', name: 'Voronoi club', base: 'https://other.example.org/mesh/', plugins: true, designs: false, offers: { plugins: 1 } }])) })
      await page.route('https://other.example.org/**', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ format: 'ateliermesh-catalog', version: 1, plugins: [{ id: 'org.example.voronoi', name: 'Voronoi shell', description: 'x', license: 'MIT', latest: '1.0.0', versions: [{ version: '1.0.0', url: 'p/x.amplugin', sha256: 'a'.repeat(64), size: 100, signed: false }] }] }) }))
      await page.reload()
      await page.locator('article', { hasText: 'Voronoi-lampenkap' }).getByRole('link', { name: /Voronoi-lampenkap/ }).click()
      const dlg = page.getByRole('dialog', { name: 'This example needs a plugin' })
      await dlg.getByText('From the other.example.org catalogue').waitFor()   // not in this site's catalogue, found in the added one
    }, 120000)

    it('shares a design as an example: the form with the picture, what people get and the consent, then the state and taking it back', async ctx => {
      if (!browser) return ctx.skip()
      const { page, posts } = await open({ share: { state: 'pending' } })
      await page.locator('li:not(.am-gskel) > .am-gcard').first().waitFor()
      expect(await page.locator('.am-privacy').textContent()).toContain('unless you explicitly share an example')
      await page.locator('article', { hasText: 'Design 5' }).getByRole('link', { name: 'Design 5' }).click()   // a design to work on: one opened from the gallery
      await page.getByText('From the gallery').first().waitFor({ timeout: 60000 })
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await page.getByRole('button', { name: 'Share as an example' }).click()
      const dlg = page.getByRole('dialog', { name: 'Share as an example' })
      expect(await dlg.getByLabel('Name', { exact: true }).inputValue()).toBe('From the gallery')   // the form starts with the design's name
      await dlg.locator('.am-sharepic-box img').waitFor({ timeout: 60000 })   // the picture is drawn here
      await dlg.getByRole('button', { name: 'Front' }).click(); await dlg.locator('.am-sharepic-box img').waitFor({ timeout: 60000 })
      await dlg.getByText(/Your model: .*\.stl/).waitFor(); await dlg.getByText('Nothing else from this browser is sent.', { exact: false }).waitFor()
      const send = dlg.getByRole('button', { name: 'Share example' })
      expect(await send.isDisabled()).toBe(true)   // the consent first
      await dlg.getByLabel('One line about it', { exact: false }).fill('A plate to put text on'); await dlg.getByLabel('Your name', { exact: false }).fill('Anna')
      await dlg.getByLabel(/I made this, or I may share it/).check()
      expect(await send.isDisabled()).toBe(false)
      await send.click()
      await dlg.getByText('Thanks: it shows up after a quick check').waitFor()
      await dlg.getByText('Waiting for a check').waitFor()
      const sent = posts.find(p => p.startsWith('submit'))!
      expect(sent).toContain('name="name"'); expect(sent).toContain('From the gallery'); expect(sent).toContain('A plate to put text on'); expect(sent).toContain('Anna'); expect(sent).toContain('name="consent"'); expect(sent).toContain('filename="picture.png"'); expect(sent).toContain('filename="design.amproj"')
      await dlg.getByRole('button', { name: 'Done' }).click()
      // the start page lists it: waiting, then shared once the catalogue says so; it can be taken back
      const accepted = await open({ share: { state: 'accepted' } })
      await accepted.page.addInitScript(() => { localStorage.setItem('am.shared', JSON.stringify([{ id: 'sharedaa', key: 'a'.repeat(32), base: location.origin + '/catalog/', name: 'Plate 60 x 30 x 4', created: '2026-11-22T10:00:00Z', state: 'pending' }])) })
      await accepted.page.reload()
      const mine = accepted.page.getByRole('region', { name: 'Shared by you' })
      await mine.getByText('Shared', { exact: true }).waitFor()
      await mine.getByRole('button', { name: /Copy link: Plate/ }).waitFor()
      await mine.getByRole('button', { name: /Remove my example: Plate/ }).click()
      const ask = accepted.page.getByRole('alertdialog', { name: /Remove .Plate 60 x 30 x 4. from the examples/ })
      await ask.getByRole('button', { name: 'Remove example' }).click()
      await mine.waitFor({ state: 'detached' })
      expect(accepted.posts.some(p => p.includes('remove=sharedaa') && p.includes('key=' + 'a'.repeat(32)))).toBe(true)
    }, 240000)

    it('says why a design could not be sent', async ctx => {
      if (!browser) return ctx.skip()
      const { page } = await open({ share: { state: 'pending', rate: true } })
      await page.locator('li:not(.am-gskel) > .am-gcard').first().waitFor()
      await page.locator('article', { hasText: 'Design 5' }).getByRole('link', { name: 'Design 5' }).click()   // a design to work on: one opened from the gallery
      await page.getByText('From the gallery').first().waitFor({ timeout: 60000 })
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await page.getByRole('button', { name: 'Share as an example' }).click()
      const dlg = page.getByRole('dialog', { name: 'Share as an example' })
      await dlg.locator('.am-sharepic-box img').waitFor({ timeout: 60000 })
      await dlg.getByLabel(/I made this, or I may share it/).check()
      await dlg.getByRole('button', { name: 'Share example' }).click()
      await dlg.getByText(/several examples just now/).waitFor()
      expect(await dlg.getByRole('button', { name: 'Share example' }).isEnabled()).toBe(true)   // the form stays, nothing is lost
    }, 180000)

    it('sends an installed plugin to the catalogue from the plugin manager, after asking', async ctx => {
      if (!browser) return ctx.skip()
      const { page, posts } = await open({ share: { state: 'pending' } })
      await page.locator('li:not(.am-gskel) > .am-gcard').first().waitFor()
      const manifest = { manifest_version: 1 as const, id: 'ext.mine', name: 'Mine', version: '1.0.0', license: 'Apache-2.0', description: 'A plugin of my own, for the test.', contact: { name: 'Me', url: 'https://example.org/me', email: 'me@example.org' }, operations: [{ id: 'tidy', title: 'Tidy Mine', kind: 'modifier' as const, params: [] }] }
      const bytes = await buildPluginPackage({ manifest: manifest as never, main: 'export default { async run(op, ctx) { return { mesh: ctx.mesh } } }' })
      await page.getByRole('button', { name: 'Settings' }).click()
      const st = page.getByRole('dialog', { name: 'Settings' })
      await st.getByRole('tab', { name: 'Plugins' }).click()
      await st.getByRole('button', { name: 'Add plugin' }).click()
      await page.getByRole('dialog').locator('.am-filebtn input[type=file]').setInputFiles({ name: 'mine.amplugin', mimeType: 'application/zip', buffer: Buffer.from(bytes) })
      await page.getByRole('button', { name: 'Add', exact: true }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Back to the plugins' }).click()
      let asked = ''
      page.once('dialog', d => { asked = d.message(); void d.accept() })
      await page.getByRole('button', { name: 'Details Mine' }).click()
      await page.getByRole('button', { name: 'Share with the catalogue Mine' }).click()
      await page.getByText(/Sent: .Mine. is listed after an admin has checked it/).waitFor({ timeout: 20000 })
      expect(asked).toContain('An admin checks it before it is listed')
      expect(posts.some(p => p.startsWith('submit') && p.includes('name="package"'))).toBe(true)
    }, 180000)

    it('a catalogue that has a gallery but no design yet shows the built-in samples, and the first design can still be shared', async ctx => {
      if (!browser) return ctx.skip()
      const { page } = await open({ empty: true, share: { state: 'pending' } })
      await page.getByRole('button', { name: 'Plate 60 x 30 x 4' }).waitFor()   // the samples, not an empty gallery
      expect(await page.getByRole('heading', { name: 'Examples' }).count()).toBe(0)
      expect(await page.getByText(/example catalogue can.t be reached/).count()).toBe(0)   // nothing is wrong, so nothing is said
      await page.getByRole('button', { name: 'Plate 60 x 30 x 4' }).click()
      await page.waitForFunction(() => !!(window as unknown as { __am?: { result: { ok: boolean } | null } }).__am?.result?.ok, null, { timeout: 60000 })
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await page.getByRole('button', { name: 'Share as an example' }).waitFor()   // sharing is offered: it is how the gallery gets its first design
    }, 120000)

    it('on a phone the controls stay in a slim bar with a Filter button', async ctx => {
      if (!browser) return ctx.skip()
      const { page } = await open({ viewport: { width: 390, height: 800 } })
      await page.locator('li:not(.am-gskel) > .am-gcard').first().waitFor()
      const filter = page.getByRole('button', { name: 'Filter' })
      await filter.waitFor()
      expect(await page.getByLabel('Plugin').isVisible()).toBe(false)
      await filter.click(); expect(await page.getByLabel('Plugin').isVisible()).toBe(true)
      expect(await page.locator('li:not(.am-gskel) > .am-gcard').first().evaluate(e => e.getBoundingClientRect().width)).toBeGreaterThan(300)   // one column, pictures lead
    }, 120000)
  })
}
