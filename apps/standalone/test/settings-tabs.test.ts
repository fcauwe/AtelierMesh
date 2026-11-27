import { chromium, webkit } from 'playwright-core'
import type { Browser, Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The settings as tabs (General, Plugins, Catalogues), on the start page and in the editor; the arrow keys move between the tabs.
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

const GL = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']

for (const [name, type] of [['chromium', chromium], ['webkit', webkit]] as const) {
  describe(`the settings tabs in ${name}`, () => {
    let browser: Browser | null = null
    beforeAll(async () => {
      try { browser = await type.launch({ headless: true, ...(name === 'chromium' ? { args: GL } : {}) }) }
      catch (e) { console.warn(`${name} is not available here: ${String(e).split('\n')[0]}`) }
    })
    afterAll(async () => { await browser?.close() })
    const pages: Page[] = []
    afterEach(async () => { await Promise.all(pages.splice(0).map(p => p.close().catch(() => undefined))) })
    it('has three tabs on the start page and in the editor: General holds the settings, Plugins the plugin manager, Catalogues the catalogue with what it offers and its address', async ctx => {
      if (!browser) return ctx.skip()
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); pages.push(page)
      page.on('pageerror', e => { if (!/Importing a module script failed|due to access control checks/.test(String(e))) throw e })   // a page that is closed while it still loads is not a failure
      await page.goto(base)
      await page.getByRole('button', { name: 'Settings' }).click()
      const dlg = page.getByRole('dialog', { name: 'Settings' })
      expect(await dlg.getByRole('tab').allTextContents()).toEqual(['General', 'Plugins', 'Catalogues'])
      expect(await dlg.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true')
      await dlg.getByText('Show the Personalised design option').waitFor()   // General: the settings
      expect(await dlg.getByLabel('Plugin catalog address').count()).toBe(0)   // the address moved to Catalogues
      await dlg.getByRole('tab', { name: 'Catalogues' }).click()
      const card = dlg.locator('.am-cataloguecard')
      await card.getByText('Default', { exact: true }).waitFor()
      await card.getByText(/^Plugins/).first().waitFor()
      expect(await card.locator('s').textContent()).toBe('Examples')   // no examples yet: struck through
      expect(await card.getByLabel('Plugin catalog address').getAttribute('placeholder')).toBe('catalog/catalog.php')
      await dlg.getByRole('tab', { name: 'Catalogues' }).press('ArrowLeft')   // arrow keys move between the tabs
      await dlg.getByRole('tab', { name: 'Plugins', selected: true }).waitFor()
      await dlg.getByRole('button', { name: 'Add plugin' }).waitFor()   // Plugins: the plugin manager
      await dlg.getByRole('tab', { name: 'General' }).click()
      await dlg.getByText('Show the Personalised design option').waitFor()
      await dlg.getByRole('button', { name: 'Close' }).click()
      // in the editor: Add a step, Plugins… opens the settings on the Plugins tab
      await page.getByRole('button', { name: 'Plate 60 x 30 x 4' }).click()
      await page.waitForFunction(() => !!(window as unknown as { __am?: { result: { ok: boolean } | null } }).__am?.result?.ok, null, { timeout: 60000 })
      await page.getByRole('button', { name: 'Add a step' }).click()
      await page.getByRole('menuitem', { name: 'Plugins…' }).click()
      const ed = page.getByRole('dialog', { name: 'Settings' })
      await ed.getByRole('tab', { name: 'Plugins', selected: true }).waitFor()
      await ed.getByRole('tab', { name: 'Catalogues' }).click()
      await ed.locator('.am-cataloguecard').waitFor()
    }, 180000)
  })
}
