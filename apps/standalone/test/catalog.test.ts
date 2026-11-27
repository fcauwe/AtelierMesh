// The plugin catalog in the app, against a pretend catalog (the browser's requests are answered by the test): search, install with a pinned checksum,
// the usual approval, update marks, the unavailable state, the address setting. test/catalog-real.test.ts runs the same flow against real PHP.
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { chromium, webkit } from 'playwright-core'
import type { Browser, Page, Route } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPluginPackage } from '@ateliermesh/loader'

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(here, '../dist')
const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.svg': 'image/svg+xml' }
let server: Server, base = ''
let catalogRequests = 0
beforeAll(async () => {
  // a plain static server, like the other journeys: it has no PHP, so catalog/catalog.php is only a file here (the tests answer for it)
  server = createServer((req, res) => {
    const u = (req.url ?? '/').split('?')[0] as string
    if (u.endsWith('catalog.php')) catalogRequests++
    const p = path.join(dist, u === '/' ? 'index.html' : decodeURIComponent(u))
    if (!p.startsWith(dist) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' }).end(fs.readFileSync(p))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
})
afterAll(() => { server?.close() })

const GL = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
const NOOP = 'export default { async run(op, ctx) { return { mesh: ctx.mesh } } }'
const manifest = (id: string, name: string, version: string) => ({ manifest_version: 1 as const, id, name, version, license: 'Apache-2.0', description: `${name}: tidies a model, made for the catalog test.`, contact: { name: 'Test Maker', url: 'https://example.org/maker' }, operations: [{ id: 'tidy', title: `Tidy ${name}`, kind: 'modifier' as const, params: [] }] })
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

interface Pkg { id: string; name: string; version: string; bytes: Uint8Array }
const pkg = async (id: string, name: string, version: string): Promise<Pkg> => ({ id, name, version, bytes: await buildPluginPackage({ manifest: manifest(id, name, version) as never, main: NOOP }) })
const entry = (p: Pkg, over: Record<string, unknown> = {}, claimed?: Uint8Array) => ({ id: p.id, name: p.name, description: `${p.name}: tidies a model, made for the catalog test.`, license: 'Apache-2.0', contact: { name: 'Test Maker', url: 'https://example.org/maker' }, latest: p.version,
  versions: [{ version: p.version, url: `packages/${p.id}/${p.version}.amplugin`, sha256: sha(claimed ?? p.bytes), size: p.bytes.length, uploaded: '2026-11-09T10:00:00+00:00', signed: false }], ...over })
const doc = (plugins: unknown[]) => ({ format: 'ateliermesh-catalog', version: 1, generated: '2026-11-09T10:00:00+00:00', plugins })

/** Answer the catalog address and the package downloads of a pretend catalog. */
async function serveCatalog(page: Page, state: { catalog: unknown; files: Map<string, Uint8Array>; status?: number }): Promise<void> {
  await page.route('**/catalog/catalog.php*', (r: Route) => (state.status ? r.fulfill({ status: state.status, body: 'nope' }) : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state.catalog) })))
  await page.route('**/catalog/packages/**', (r: Route) => {
    const f = state.files.get(new URL(r.request().url()).pathname.replace(/^\/catalog\//, ''))
    return f ? r.fulfill({ status: 200, contentType: 'application/octet-stream', body: Buffer.from(f) }) : r.fulfill({ status: 404, body: '' })
  })
}
const readStore = (page: Page) => page.evaluate(() => new Promise<Array<{ id: string; version: string }>>(resolve => {
  const r = indexedDB.open('ateliermesh'); r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains('plugins')) { db.close(); resolve([]); return }; const g = db.transaction('plugins').objectStore('plugins').getAll(); g.onsuccess = () => { db.close(); resolve((g.result as Array<{ id: string; version: string }>).map(x => ({ id: x.id, version: x.version }))) } }
}))

for (const [name, type] of [['chromium', chromium], ['webkit', webkit]] as const) {
  describe(`plugin catalog in the standalone app (${name})`, () => {
    let browser: Browser | null = null
    beforeAll(async () => { try { browser = await type.launch({ headless: true, ...(name === 'chromium' ? { args: GL } : {}) }) } catch (e) { console.warn(`${name} is not available here: ${String(e).split('\n')[0]}`) } })
    afterAll(async () => { await browser?.close() })
    const ctxs: Array<{ close(): Promise<void> }> = []
    afterEach(async () => { await Promise.all(ctxs.splice(0).map(c => c.close().catch(() => undefined))) })
    const newPage = async (): Promise<Page> => {
      const ctx = await browser!.newContext({ viewport: { width: 1280, height: 900 } })
      ctxs.push(ctx)
      const page = await ctx.newPage()
      await page.addInitScript(() => { try { if (!localStorage.getItem('am.pluginView')) localStorage.setItem('am.pluginView', 'list') } catch { /* private window */ } })
      return page
    }
    const openManager = async (page: Page) => {
      await page.getByRole('button', { name: 'Settings' }).click()
      await page.getByRole('dialog', { name: 'Settings' }).getByRole('tab', { name: 'Plugins' }).click()
      await page.getByRole('dialog', { name: 'Settings' }).waitFor()
      return toAdd(page)
    }
    // the manager has two screens: the list of plugins, and "Add a plugin" (file, address, catalog, how to build one)
    const toAdd = async (page: Page) => {
      await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Add plugin' }).click()
      const add = page.getByRole('dialog', { name: 'Add a plugin' }); await add.waitFor(); return add
    }
    const toList = async (page: Page) => {
      await page.getByRole('dialog', { name: 'Add a plugin' }).getByRole('button', { name: 'Back to the plugins' }).click()
      const list = page.getByRole('dialog', { name: 'Settings' }); await list.waitFor(); return list
    }

    it('does not ask for the catalog until the plugin manager opens, and says so plainly when this server has none', async ctx => {
      if (!browser) return ctx.skip()
      const page = await newPage()
      const before = catalogRequests
      await page.goto(base)
      await page.getByRole('button', { name: 'Plate 60 x 30 x 4' }).waitFor()
      await page.waitForTimeout(1500)
      expect(catalogRequests).toBe(before)                                        // nothing in the background
      const dlg = await openManager(page)
      await dlg.getByText('The catalog is not available here.').waitFor({ timeout: 15000 })
      expect(catalogRequests).toBe(before + 1)
      await dlg.getByLabel('Plugin address (https)').waitFor()                    // the rest of the manager works
      expect(await dlg.getByRole('searchbox', { name: 'Search in the catalog' }).isDisabled()).toBe(true)
      await page.close()
    })

    it('searches the catalog, installs with the checksum pinned and the usual approval, and keeps the plugin after a reload', async ctx => {
      if (!browser) return ctx.skip()
      const a = await pkg('com.example.alpha', 'Alpha', '1.0.0'), b = await pkg('com.example.beta', 'Beta', '2.1.0')
      const state = { catalog: doc([entry(a, { downloads: 1240, replaces: ['org.old.alpha', 'Not An Id', 42] }), entry(b, { downloads: -5 })]), files: new Map([['packages/com.example.alpha/1.0.0.amplugin', a.bytes], ['packages/com.example.beta/2.1.0.amplugin', b.bytes]]) }
      const page = await newPage(); await serveCatalog(page, state)
      const errors: string[] = []; page.on('pageerror', e => errors.push(String(e)))
      await page.goto(base)
      const dlg = await openManager(page)
      await dlg.getByText('2 plugins from 127.0.0.1').waitFor({ timeout: 15000 })
      // the public download count: a whole number the catalog counted is shown; a negative or missing one is not
      await dlg.locator('[data-catalog-plugin="com.example.alpha"]').getByTestId('downloads').getByText(/1\s240 downloads/).waitFor()
      expect(await dlg.locator('[data-catalog-plugin="com.example.beta"] [data-testid="downloads"]').count()).toBe(0)
      // the plugin it replaces: a valid id is shown, what is not an id is dropped
      await dlg.locator('[data-catalog-plugin="com.example.alpha"]').getByTestId('replaces').getByText(/^Replaces org\.old\.alpha$/).waitFor()
      const search = dlg.getByRole('searchbox', { name: 'Search in the catalog' })
      await search.fill('beta'); expect(await dlg.locator('[data-catalog-plugin]').count()).toBe(1)
      await search.fill('')
      await dlg.locator('[data-catalog-plugin="com.example.alpha"]').getByRole('button', { name: 'Install Alpha' }).click()
      const ask = page.getByRole('dialog', { name: 'Add this plugin?' }); await ask.waitFor({ timeout: 20000 })
      for (const want of ['Alpha', 'Version 1.0.0', 'Apache-2.0', 'Not signed']) await ask.getByText(want, { exact: false }).first().waitFor()
      expect(await readStore(page)).toEqual([])                                   // nothing is added before the person says yes
      await ask.getByRole('button', { name: 'Add', exact: true }).click()
      await dlg.locator('[data-catalog-plugin="com.example.alpha"]').getByText('Installed 1.0.0').waitFor({ timeout: 20000 })
      await expect.poll(() => readStore(page), { timeout: 20000 }).toEqual([{ id: 'com.example.alpha', version: '1.0.0' }])   // written to the browser's store
      // cancel: nothing happens
      await dlg.locator('[data-catalog-plugin="com.example.beta"]').getByRole('button', { name: 'Install Beta' }).click()
      await page.getByRole('dialog', { name: 'Add this plugin?' }).getByRole('button', { name: 'Cancel' }).click()
      expect((await readStore(page)).map(x => x.id)).toEqual(['com.example.alpha'])
      await page.reload()
      await openManager(page)
      const dlg2 = await toList(page)
      await dlg2.locator('ul.am-pluginlist li', { hasText: 'Alpha' }).waitFor({ timeout: 30000 })
      expect(errors).toEqual([])
      await page.close()
    }, 120000)

    it('refuses a download whose checksum is not the one the catalog gave, and a file that is not the plugin the catalog named', async ctx => {
      if (!browser) return ctx.skip()
      const a = await pkg('com.example.alpha', 'Alpha', '1.0.0'), other = await pkg('com.example.beta', 'Beta', '1.0.0')
      const tampered = new Uint8Array(a.bytes); tampered[tampered.length >> 1] ^= 0xff
      // 1. the catalog describes a file, the server delivers a different one (same name)
      // 2. the catalog names Alpha but the delivered file (with the right checksum for itself) is Beta
      const state = { catalog: doc([entry(a, {}, a.bytes), entry({ ...a, id: 'com.example.gamma', name: 'Gamma' }, {}, other.bytes)]),
        files: new Map([['packages/com.example.alpha/1.0.0.amplugin', tampered], ['packages/com.example.gamma/1.0.0.amplugin', other.bytes]]) }
      const page = await newPage(); await serveCatalog(page, state)
      await page.goto(base)
      const dlg = await openManager(page)
      await dlg.getByText('2 plugins from 127.0.0.1').waitFor({ timeout: 15000 })
      await dlg.locator('[data-catalog-plugin="com.example.alpha"]').getByRole('button', { name: 'Install Alpha' }).click()
      await dlg.getByText('The downloaded file is not the one the catalog described', { exact: false }).waitFor({ timeout: 15000 })
      await dlg.locator('[data-catalog-plugin="com.example.gamma"]').getByRole('button', { name: 'Install Gamma' }).click()
      await dlg.getByText('is not com.example.gamma 1.0.0, so it was not installed', { exact: false }).waitFor({ timeout: 15000 })
      expect(await page.getByRole('dialog', { name: 'Add this plugin?' }).count()).toBe(0)
      expect(await readStore(page)).toEqual([])
      await page.close()
    }, 120000)

    it('marks an installed plugin that has a newer version in the catalog, and Update goes through the same approval', async ctx => {
      if (!browser) return ctx.skip()
      const v1 = await pkg('com.example.alpha', 'Alpha', '1.0.0'), v2 = await pkg('com.example.alpha', 'Alpha', '1.1.0'), same = await pkg('com.example.beta', 'Beta', '3.0.0')
      const state = { catalog: doc([entry(v2, { versions: [entry(v2).versions[0], entry(v1).versions[0]] }), entry(same)]),
        files: new Map([['packages/com.example.alpha/1.1.0.amplugin', v2.bytes], ['packages/com.example.alpha/1.0.0.amplugin', v1.bytes], ['packages/com.example.beta/3.0.0.amplugin', same.bytes]]) }
      const page = await newPage(); await serveCatalog(page, state)
      await page.goto(base)
      let add = await openManager(page)
      await add.locator('input[type=file]').setInputFiles({ name: 'a.amplugin', mimeType: 'application/zip', buffer: Buffer.from(v1.bytes) })
      await page.getByRole('dialog', { name: 'Add this plugin?' }).getByRole('button', { name: 'Add', exact: true }).click()
      let dlg = await toList(page)
      await dlg.locator('ul.am-pluginlist li', { hasText: 'Alpha' }).getByText(/Stored in this browser/).waitFor({ timeout: 20000 })
      add = await toAdd(page)
      await add.locator('input[type=file]').setInputFiles({ name: 'b.amplugin', mimeType: 'application/zip', buffer: Buffer.from(same.bytes) })
      await page.getByRole('dialog', { name: 'Add this plugin?' }).getByRole('button', { name: 'Add', exact: true }).click()
      dlg = await toList(page)
      await dlg.locator('ul.am-pluginlist li', { hasText: 'Beta' }).getByText(/Stored in this browser/).waitFor({ timeout: 20000 })
      // the catalog is read again when the manager is opened again after a minute; here the first reading already knows both
      await page.getByRole('button', { name: 'Close' }).click()
      add = await openManager(page)
      await add.locator('[data-catalog-plugin="com.example.beta"]').getByText('Installed 3.0.0').waitFor({ timeout: 15000 })
      dlg = await toList(page)
      const row = dlg.locator('ul.am-pluginlist li', { hasText: 'Alpha' })
      await row.getByText('Update available: 1.1.0').waitFor({ timeout: 15000 })
      expect(await dlg.locator('ul.am-pluginlist li', { hasText: 'Beta' }).getByText(/Update available/).count()).toBe(0)
      await row.getByRole('button', { name: 'Update to 1.1.0 Alpha' }).click()
      const ask = page.getByRole('dialog', { name: 'Update this plugin?' }); await ask.waitFor({ timeout: 20000 })
      await ask.getByText('1.0.0 → 1.1.0').waitFor()
      await ask.getByRole('button', { name: 'Update', exact: true }).click()
      await dlg.locator('ul.am-pluginlist li', { hasText: 'Alpha' }).getByText('Version 1.1.0').waitFor({ timeout: 20000 })
      expect(await dlg.getByText(/Update available/).count()).toBe(0)
      expect(await readStore(page)).toEqual(expect.arrayContaining([{ id: 'com.example.alpha', version: '1.1.0' }]))
      await page.close()
    }, 150000)

    it('a catalog that is not a catalog (a page, wrong format, an error) is "not available", and hostile text in it is only text', async ctx => {
      if (!browser) return ctx.skip()
      const a = await pkg('com.example.alpha', 'Alpha', '1.0.0')
      const hostile = { ...entry(a), name: '<img src=x onerror="window.__xss=1">Alpha', description: '<script>window.__xss=2</script> still just text', versions: [{ ...entry(a).versions[0], url: 'javascript:alert(1)' }] }
      const fine = { ...entry(await pkg('com.example.fine', 'Fine', '1.0.0')), name: '<b>Fine</b>', image: { url: 'https://evil.example/pixel.png', alt: 'tracking pixel' }, contact: { url: 'javascript:alert(1)', email: 'not an email', name: 'Maker' } }
      const state: { catalog: unknown; files: Map<string, Uint8Array>; status?: number } = { catalog: doc([hostile, fine, { id: 'not valid', name: 'x' }, 'text', null]), files: new Map<string, Uint8Array>() }
      const page = await newPage(); await serveCatalog(page, state)
      const requested: string[] = []
      page.on('request', r => { if (r.url().includes('evil.example')) requested.push(r.url()) })
      await page.goto(base)
      const dlg = await openManager(page)
      await dlg.getByText('1 plugins from 127.0.0.1').waitFor({ timeout: 15000 })     // the entry with a script address for its package is left out
      await dlg.getByText('<b>Fine</b>').waitFor()
      expect(await dlg.locator('[data-catalog-plugin] b, [data-catalog-plugin] img, [data-catalog-plugin] script').count()).toBe(0)
      expect(await dlg.locator('[data-catalog-plugin] a[href^="javascript"]').count()).toBe(0)
      expect(requested).toEqual([])                                               // a picture on another host is not loaded
      expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined()
      // a wrong format, or an answer that is not JSON
      state.catalog = { format: 'something-else', version: 1, plugins: [] }
      await (await toList(page)).getByRole('button', { name: 'Close' }).click()
      await page.reload()
      const dlg2 = await openManager(page)
      await dlg2.getByText('The catalog is not available here.').waitFor({ timeout: 15000 })
      state.catalog = doc([]); state.status = 500
      await dlg2.getByRole('button', { name: 'Try again' }).click()
      await dlg2.getByText('The catalog is not available here.').waitFor()
      state.status = 0
      await dlg2.getByRole('button', { name: 'Try again' }).click()
      await dlg2.getByText('0 plugins from 127.0.0.1').waitFor({ timeout: 15000 })
      await page.close()
    }, 120000)

    it('the catalog address can be changed in Settings; a path or https address is accepted, anything else is ignored', async ctx => {
      if (!browser) return ctx.skip()
      const a = await pkg('com.example.alpha', 'Alpha', '1.0.0')
      const state = { catalog: doc([entry(a)]), files: new Map([['packages/com.example.alpha/1.0.0.amplugin', a.bytes]]) }
      const page = await newPage(); await serveCatalog(page, state)
      let asked = ''
      await page.route('**/elsewhere/list.json', r => { asked = r.request().url(); return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(doc([entry(a)])) }) })
      await page.goto(base)
      await page.getByRole('button', { name: 'Settings' }).click()
      let st = page.getByRole('dialog', { name: 'Settings' })
      await st.getByRole('tab', { name: 'Catalogues' }).click()   // the address of the catalogue is on the Catalogues tab
      const field = st.getByLabel('Plugin catalog address')
      expect(await field.getAttribute('placeholder')).toBe('catalog/catalog.php')
      await field.fill('javascript:alert(1)'); await field.blur()
      expect(await page.evaluate(() => localStorage.getItem('am.catalogUrl'))).toBeNull()
      await field.fill('ftp://example.org/list'); await field.blur()
      expect(await page.evaluate(() => localStorage.getItem('am.catalogUrl'))).toBeNull()
      await field.fill('elsewhere/list.json'); await field.blur()
      expect(await page.evaluate(() => localStorage.getItem('am.catalogUrl'))).toBe('elsewhere/list.json')
      await st.getByRole('tab', { name: 'Plugins' }).click()
      await page.getByRole('dialog', { name: 'Settings' }).waitFor()
      const dlg = await toAdd(page)
      await dlg.getByText('1 plugins from 127.0.0.1').waitFor({ timeout: 15000 })
      expect(asked).toBe(`${base}elsewhere/list.json`)
      await (await toList(page)).getByRole('button', { name: 'Close' }).click()
      await page.reload()
      await page.getByRole('button', { name: 'Settings' }).click()
      st = page.getByRole('dialog', { name: 'Settings' })
      await st.getByRole('tab', { name: 'Catalogues' }).click()
      expect(await st.getByLabel('Plugin catalog address').inputValue()).toBe('elsewhere/list.json')   // remembered
      await page.close()
    }, 120000)
  })
}
