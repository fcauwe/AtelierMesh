import { chromium, webkit } from 'playwright-core'
import type { Browser, Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyColourMap, loadProject, write3mf } from '@ateliermesh/core'
import { boxMesh } from '@ateliermesh/core/testing'

// Colour slots in the real app: a design is one colour until several are switched on; then parts are mapped to slots, up to the number Settings allows, and the design file keeps them.
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
  describe(`colour slots in ${name}`, () => {
    let browser: Browser | null = null
    beforeAll(async () => {
      try { browser = await type.launch({ headless: true, ...(name === 'chromium' ? { args: GL } : {}) }) }
      catch (e) { console.warn(`${name} is not available here: ${String(e).split('\n')[0]}`) }
    })
    afterAll(async () => { await browser?.close() })
    const pages: Page[] = []
    afterEach(async () => { await Promise.all(pages.splice(0).map(p => p.close().catch(() => undefined))) })

    it('opening a 3MF painted in two colours fills the Colours tab with them, each with its own colour', async ctx => {
      if (!browser) return ctx.skip()
      const m = boxMesh(10, 10, 10)
      const labels = new Uint16Array(m.indices.length / 3); for (let i = 0; i < labels.length; i++) labels[i] = i % 2
      const two = applyColourMap({ ...m, segments: { labels, table: [{ id: 0, name: 'body' }, { id: 1, name: 'text' }] } }, { slots: [{ id: '1', name: 'Part', parts: ['body'] }, { id: '2', name: 'Text', parts: ['text'] }] }, { colours: { '1': { color: '#2563eb' }, '2': { color: '#ea580c' } } })
      const file = { name: 'painted.3mf', mimeType: 'model/3mf', buffer: Buffer.from(write3mf(two, { title: 'painted', palette: [{ segment: 'slot_2', extruder: 2, color: '#EA580C' }], target: 'prusa' }).bytes) }
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
      pages.push(page)
      page.on('pageerror', e => { if (!/Importing a module script failed|due to access control checks/.test(String(e))) throw e })   // a page that is closed while it still loads is not a failure
      await page.goto(base)
      await page.setInputFiles('.am-drop input[type=file]', file)
      await page.waitForFunction(() => !!(window as unknown as { __am?: { result: { ok: boolean } | null } }).__am?.result?.ok, null, { timeout: 60000 })
      await page.getByRole('tab', { name: /^Colours/ }).click()
      await page.getByTestId('colours-count').getByText('Uses 2 colours').waitFor()
      expect(await page.locator('[data-slot]').count()).toBe(2)
      expect(await page.locator('[data-slot="1"] input[type=color]').inputValue()).toBe('#2563eb')
      expect(await page.locator('[data-slot="2"] input[type=color]').inputValue()).toBe('#ea580c')
    }, 120000)

    it('is one colour at first; several colours map parts to slots, stop at the number in Settings, are kept in the design file, and can be switched off again', async ctx => {
      if (!browser) return ctx.skip()
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })
      pages.push(page)
      page.on('pageerror', e => { if (!/Importing a module script failed|due to access control checks/.test(String(e))) throw e })   // a page that is closed while it still loads is not a failure
      await page.goto(base)
      await page.getByRole('button', { name: /^Name tag(?! with)/ }).click()
      await page.waitForFunction(() => !!(window as unknown as { __am?: { result: { ok: boolean } | null } }).__am?.result?.ok, null, { timeout: 60000 })
      // one colour until the designer says otherwise
      await page.getByRole('tab', { name: /^Colours/ }).click()
      await page.getByText(/printed in one colour/).waitFor()
      await page.getByRole('button', { name: 'Use several colours' }).click()
      await page.getByTestId('colours-count').getByText('Uses 1 colour').waitFor()
      const first = page.locator('[data-slot="1"]')
      await first.getByText('Whole part').waitFor()
      // the text of the tag in its own colour: a second slot with the part that is not the plate
      await page.getByRole('button', { name: 'Add a colour' }).click()
      const second = page.locator('[data-slot="2"]')
      await second.waitFor()
      const options = await second.locator('select option').allTextContents()
      const part = options.find(o => !/^Add a part|^Whole part/.test(o) && !/\(/.test(o)) ?? options.find(o => !/^Add a part|^Whole part/.test(o))
      expect(part, JSON.stringify(options)).toBeTruthy()
      await second.locator('select').selectOption({ label: part! })
      await second.getByRole('button', { name: new RegExp(`Take .* out of Colour 2`) }).waitFor()
      // show mapped colours: a view setting, off by default, the model is still shown
      const show = page.getByLabel('Show mapped colours')
      expect(await show.isChecked()).toBe(false)
      await show.check()
      expect(await page.locator('.am-editor-view canvas').count()).toBe(1)
      // there is no filament list here, so the designer picks each colour: it is kept with the slot
      await second.getByLabel('Colour of Colour 2').fill('#123456')
      // no limit here: Settings has no "Most colours", and a sixth colour can be added
      await page.getByRole('button', { name: 'Settings' }).click()
      expect(await page.getByLabel('Most colours').count()).toBe(0)
      await page.getByRole('button', { name: 'Close' }).click()
      for (let n = 3; n <= 6; n++) await page.getByRole('button', { name: 'Add a colour' }).click()
      await page.getByTestId('colours-count').getByText('Uses 6 colours').waitFor()
      expect(await page.getByRole('button', { name: 'Add a colour' }).isDisabled()).toBe(false)
      for (let n = 6; n >= 3; n--) await page.locator(`[data-slot="${n}"]`).getByRole('button', { name: /^Remove/ }).click()
      // the design file keeps the slots
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      const [saved] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download .amproj file' }).click()])
      const back = await loadProject(new Uint8Array(fs.readFileSync((await saved.path())!)), { storeKinds: ['mesh', 'drawing'] })
      expect(back.colours?.slots.map(s => s.id)).toEqual(['1', '2'])
      expect(back.colours?.slots[1]?.parts).toEqual([part!])
      expect(back.colours?.slots[1]?.color).toBe('#123456')
      expect(back.colours?.slots[0]?.color).toBeUndefined()
      // back to one colour: asked first, then the design has none
      await page.getByRole('button', { name: 'Use one colour' }).click()
      await page.getByRole('dialog', { name: 'Use one colour?' }).getByRole('button', { name: 'Use one colour' }).click()
      await page.getByText(/printed in one colour/).waitFor()
    }, 180000)
  })
}
