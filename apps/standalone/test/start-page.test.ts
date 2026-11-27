import { chromium, webkit } from 'playwright-core'
import type { Browser, Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The start page: on a phone what the person saved comes before the examples, and with nothing saved there is one quiet line instead of an empty card; on a wide screen the order is as it was.
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
  describe(`the start page in ${name}`, () => {
    let browser: Browser | null = null
    beforeAll(async () => {
      try { browser = await type.launch({ headless: true, ...(name === 'chromium' ? { args: GL } : {}) }) }
      catch (e) { console.warn(`${name} is not available here: ${String(e).split('\n')[0]}`) }
    })
    afterAll(async () => { await browser?.close() })
    const pages: Page[] = []
    afterEach(async () => { await Promise.all(pages.splice(0).map(p => p.close().catch(() => undefined))) })
    const top = async (page: Page, sel: string): Promise<{ x: number; y: number }> => { const b = await page.locator(sel).boundingBox(); return { x: b?.x ?? -1, y: b?.y ?? -1 } }

    it('phone: nothing saved gives one quiet line and no empty card; saved designs come before the examples; wide: the examples stay on the left', async ctx => {
      if (!browser) return ctx.skip()
      const phone = await browser.newPage({ viewport: { width: 390, height: 800 } }); pages.push(phone)
      await phone.goto(base)
      await phone.locator('.am-samples').waitFor()
      await phone.locator('.am-savedempty').waitFor({ state: 'visible' })
      expect(await phone.locator('.am-savedempty h2').isVisible()).toBe(false)   // no heading, no frame: one quiet line
      expect((await phone.locator('.am-savedempty').evaluate(e => getComputedStyle(e).borderTopWidth))).toBe('0px')
      // save something in this browser, then look again
      await phone.getByRole('button', { name: 'Plate 60 x 30 x 4' }).click()
      await phone.waitForFunction(() => !!(window as unknown as { __am?: { result: { ok: boolean } | null } }).__am?.result?.ok, null, { timeout: 60000 })
      await phone.getByRole('button', { name: 'Save', exact: true }).click()
      await phone.getByRole('button', { name: 'Save in this browser' }).click()
      await phone.waitForTimeout(1500)
      await phone.goto(base)
      await phone.locator('.am-savedcard').waitFor({ state: 'visible' })
      await phone.locator('.am-savedempty').waitFor({ state: 'detached' })
      const saved = await top(phone, '.am-savedcard'), samples = await top(phone, '[aria-label="Samples"]')
      expect(saved.y).toBeLessThan(samples.y)
      const wide = await browser.newPage({ viewport: { width: 1280, height: 900 } }); pages.push(wide)
      await wide.goto(base)
      await wide.locator('.am-savedcard').waitFor({ state: 'visible' })
      const s2 = await top(wide, '.am-savedcard'), e2 = await top(wide, '[aria-label="Samples"]')
      expect(e2.x).toBeLessThan(s2.x)   // side by side as before: the examples left, saved right
    }, 180000)
  })
}
