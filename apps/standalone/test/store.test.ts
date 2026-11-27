import { Buffer } from 'node:buffer'
import { chromium, webkit } from 'playwright-core'
import type { Browser, Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { loadProject } from '@ateliermesh/core'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The store's screens in the real app: the picker of a drawing setting, Import SVG, the Stored tab (Replace, Delete, the missing row) and the problems of a bad file.
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
const svgFile = (name: string, body = '<path d="M2 2h36v16H2z"/>') => ({ name, mimeType: 'image/svg+xml', buffer: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 40 20">${body}</svg>`) })

for (const [name, type] of [['chromium', chromium], ['webkit', webkit]] as const) {
  describe(`the project store screens in ${name}`, () => {
    let browser: Browser | null = null
    beforeAll(async () => {
      try { browser = await type.launch({ headless: true, ...(name === 'chromium' ? { args: GL } : {}) }) }
      catch (e) { console.warn(`${name} is not available here: ${String(e).split('\n')[0]}`) }
    })
    afterAll(async () => { await browser?.close() })
    const pages: Page[] = []
    afterEach(async () => { await Promise.all(pages.splice(0).map(p => p.close().catch(() => undefined))) })

    const start = async (): Promise<Page> => {
      const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } })
      pages.push(page)
      page.on('pageerror', e => { if (!/Importing a module script failed|due to access control checks/.test(String(e))) throw e })   // a page that is closed while it still loads is not a failure
      await page.goto(base)
      await page.getByRole('button', { name: 'Plate 60 x 30 x 4' }).click()
      await page.waitForFunction(() => !!(window as unknown as { __am?: { result: { ok: boolean } | null } }).__am?.result?.ok, null, { timeout: 60000 })
      await page.getByRole('button', { name: 'Add a step' }).click()
      await page.getByRole('menuitem', { name: /^SVG/ }).click()
      return page
    }
    const chooseFile = async (page: Page, button: ReturnType<Page['getByRole']>, file: ReturnType<typeof svgFile>): Promise<void> => {
      const [fc] = await Promise.all([page.waitForEvent('filechooser'), button.click()])
      await fc.setFiles(file)
    }
    const imported = async (page: Page, file = svgFile('logo.svg')): Promise<void> => {
      await chooseFile(page, page.getByRole('button', { name: /Choose a drawing/ }), file)   // nothing stored yet: the button goes straight to the file chooser
      const imp = page.getByRole('dialog', { name: 'Import SVG' })
      await imp.waitFor()
      await imp.getByRole('button', { name: 'Keep drawing' }).click()
    }

    it('imports a drawing from the picker, shows it in the Stored tab with its use, replaces it keeping the name, and deletes it with a question', async ctx => {
      if (!browser) return ctx.skip()
      const page = await start()
      // nothing stored yet: the picker's button opens the file chooser at once; the dialog shows the real size and the suggested name
      await chooseFile(page, page.getByRole('button', { name: /Choose a drawing/ }), svgFile('logo.svg'))
      const imp = page.getByRole('dialog', { name: 'Import SVG' })
      await imp.getByText(/36 × 16 mm/).waitFor()
      expect(await imp.getByLabel('Keep it as').inputValue()).toBe('logo')
      await imp.getByRole('button', { name: 'Keep drawing' }).click()
      // chosen at once: the setting names it and the step runs
      await page.getByRole('button', { name: /^logo\b/ }).waitFor()
      await page.waitForFunction(() => (window as unknown as { __am: { result: { ok: boolean } | null } }).__am.result?.ok === true, null, { timeout: 30000 })
      // the Stored tab
      await page.getByRole('tab', { name: /^Stored/ }).click()
      const row = page.locator('[data-store-name="logo"]')
      await row.waitFor()
      await row.getByText(/Used by/).first().waitFor()
      await row.locator('.am-storedhead').click()   // the row opens in place: Replace and Delete are inside
      await row.getByRole('button', { name: 'Go to step 1' }).waitFor()
      await page.getByTestId('store-budget').getByText(/1 of 20 items/).waitFor()
      // replace: the name stays, the steps follow
      await chooseFile(page, row.getByRole('button', { name: /Replace.* logo/ }), svgFile('other.svg', '<path d="M5 5h30v10H5z"/>'))
      const rep = page.getByRole('dialog', { name: /Replace “logo”/ })
      await rep.getByRole('button', { name: 'Keep drawing' }).click()
      await rep.waitFor({ state: 'detached' })
      expect(await page.locator('[data-store-name]:not([data-store-name="original"])').count()).toBe(1)
      // delete asks first, saying who uses it, then the step is left with a missing item that can be imported again under the same name
      await row.getByRole('button', { name: 'Delete logo' }).click()
      const del = page.getByRole('dialog', { name: /Delete “logo”/ })
      await del.getByText(/step 1 uses this drawing/i).waitFor()
      await del.getByRole('button', { name: 'Delete anyway' }).click()
      await page.getByRole('tab', { name: /^Stored, .*1 missing/ }).waitFor()   // the "!" on the tab, said in its name
      const missing = page.locator('[data-store-name="logo"].am-missing')
      await missing.getByText('Missing').waitFor()
      await chooseFile(page, missing.getByRole('button', { name: 'Import…' }), svgFile('again.svg'))
      const again = page.getByRole('dialog', { name: 'Import SVG' })
      expect(await again.getByLabel('Keep it as').getAttribute('readonly')).not.toBeNull()   // the name is the one the step uses: shown, not editable
      await again.getByRole('button', { name: 'Keep drawing' }).click()
      await page.locator('[data-store-name="logo"]:not(.am-missing)').waitFor()
      expect(await page.getByRole('img', { name: /missing/ }).count()).toBe(0)
    }, 180000)

    it('explains a file it cannot use, and a name that is already taken', async ctx => {
      if (!browser) return ctx.skip()
      const page = await start()
      await imported(page)
      await page.getByRole('button', { name: /^logo\b/ }).click()
      const dlg = page.locator('.am-pickerpop')
      await chooseFile(page, dlg.getByRole('button', { name: 'Import…' }), svgFile('bad.svg', '<script>alert(1)</script><path d="M0 0h10v10z"/>'))
      const imp = page.getByRole('dialog', { name: 'Import SVG' })
      await imp.getByText(/scripts or links to other files/).waitFor()
      // refused before it is read: no preview, no choices, no Keep; the way out is another file
      expect(await imp.getByRole('button', { name: 'Keep drawing' }).count()).toBe(0)
      expect(await imp.getByText('Fill', { exact: true }).count()).toBe(0)
      const [again] = await Promise.all([page.waitForEvent('filechooser'), imp.getByRole('button', { name: 'Choose another file' }).click()])
      await again.setFiles(svgFile('good.svg'))
      await page.getByRole('dialog', { name: 'Import SVG' }).getByRole('button', { name: 'Cancel' }).click()
      // a name already in the project: the way out is another name, or replacing the old one
      await page.getByRole('button', { name: /^logo\b/ }).click()
      await chooseFile(page, page.locator('.am-pickerpop').getByRole('button', { name: 'Import…' }), svgFile('logo.svg'))
      const second = page.getByRole('dialog', { name: 'Import SVG' })
      expect(await second.getByLabel('Keep it as').inputValue()).toBe('logo_2')   // never the same name by default
      await second.getByLabel('Keep it as').fill('logo')
      await second.getByText(/“logo” is already in this project/).waitFor()
      expect(await second.getByRole('button', { name: 'Keep drawing' }).isDisabled()).toBe(true)
      await second.getByRole('button', { name: 'Use “logo_2”' }).click()
      await second.getByRole('button', { name: 'Keep drawing' }).click()
      await page.getByRole('tab', { name: /^Stored/ }).click()
      expect(await page.locator('[data-store-name]:not([data-store-name="original"])').count()).toBe(2)
    }, 180000)

    it('the customer can change a drawing the shop made personalisable: their own SVG within the limits, a plain explanation otherwise, and a way back to the shop\'s drawing', async ctx => {
      if (!browser) return ctx.skip()
      const page = await start()
      await imported(page)
      await page.getByRole('button', { name: 'Settings' }).click()
      await page.getByRole('switch', { name: 'Show the Personalised design option' }).check()
      await page.getByRole('button', { name: 'Close' }).click()
      await page.getByRole('switch', { name: 'Personalised design' }).check()
      await page.getByLabel(/Drawing is personalisable/).check()
      await page.getByRole('button', { name: 'Preview as customer' }).click()
      await page.getByText(/Preview as customer: this is exactly what/).waitFor()
      const field = page.locator('.am-changedrawing')
      await field.getByText('The shop’s drawing').waitFor()
      await field.getByText(/An SVG file, at most 2000 shapes and 50\u202f000 points\./).waitFor()
      // a file that is not an SVG: said plainly, the shop's drawing stays
      await chooseFile(page, field.getByRole('button', { name: 'Change drawing' }), { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('x') })
      await field.getByText(/“photo.png” isn’t an SVG drawing/).waitFor()
      await field.getByText('The shop’s drawing').waitFor()
      // their own drawing: it is used, and the way back is offered
      await chooseFile(page, field.getByRole('button', { name: 'Change drawing' }), svgFile('mine.svg', '<path d="M3 3h20v10H3z"/>'))
      await field.getByText('Your drawing').waitFor()
      await field.getByRole('button', { name: 'Use the shop’s drawing again' }).click()
      await field.getByText('The shop’s drawing').waitFor()
      await page.getByRole('button', { name: 'Back to the editor' }).click()
      await page.getByRole('tab', { name: /^Stored/ }).click()
      expect(await page.locator('[data-store-name]:not([data-store-name="original"])').count()).toBe(1)   // the customer's drawing is gone again, the shop's is the only one
    }, 180000)

    it('the Store and Load steps: a name an imported item has is refused on the field, a stored result shows in the Stored tab and in the Load picker', async ctx => {
      if (!browser) return ctx.skip()
      const page = await start()
      await imported(page)
      await page.getByRole('button', { name: 'Add a step' }).click()
      await page.locator('.am-addpanel').waitFor()
      if ((await page.getByRole('menuitem', { name: 'Store', exact: true }).count()) === 0) await page.getByRole('menuitem', { name: /^More/ }).click()
      await page.getByRole('menuitem', { name: 'Store', exact: true }).click()
      const field = page.getByLabel('Store as')
      await field.fill('logo')
      await page.getByText(/“logo” is already the name of an imported item/).first().waitFor()
      await field.fill('saved')
      await page.getByText(/is already the name of an imported item/).waitFor({ state: 'detached' })   // the name is accepted (the drawing step above is not placed, so the run as a whole is not ok: not what this test is about)
      expect(await page.getByText(/is already the name of an imported item/).count()).toBe(0)
      await page.getByRole('tab', { name: /^Stored, 2 items/ }).waitFor()   // the imported drawing and what the Store step made: the tab counts both
      await page.getByRole('tab', { name: /^Stored/ }).click()
      const made = page.locator('[data-store-name="saved"]')
      await made.getByText(/Made by step 2/).first().waitFor()
      await made.locator('.am-storedhead').click()
      expect(await made.getByRole('button', { name: /Delete/ }).count()).toBe(0)   // a result the steps make again every run cannot be deleted or replaced
      // generated, so not saved: the design file keeps the drawing that was imported and nothing the Store step made
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      const [saved] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download .amproj file' }).click()])
      const back = await loadProject(new Uint8Array(fs.readFileSync((await saved.path())!)), { storeKinds: ['mesh', 'drawing'] })
      expect(Object.keys(back.store ?? {})).toEqual(['logo'])
      await page.keyboard.press('Escape')
      await page.getByRole('tab', { name: 'Steps' }).click()
      await page.getByRole('button', { name: 'Add a step' }).click()
      await page.locator('.am-addpanel').waitFor()
      if ((await page.getByRole('menuitem', { name: 'Load', exact: true }).count()) === 0) await page.getByRole('menuitem', { name: /^More/ }).click()
      await page.getByRole('menuitem', { name: 'Load', exact: true }).click()
      await page.locator('.am-picker').click()
      const dlg = page.locator('.am-pickerpop')
      await dlg.getByRole('option', { name: /logo/ }).waitFor()
      await dlg.getByRole('option', { name: /saved/ }).click()
      await page.getByRole('button', { name: /^saved\b/ }).waitFor()
    }, 180000)

    it('the original model is in the Stored tab (read only, not counted), and a Load step can bring it back', async ctx => {
      if (!browser) return ctx.skip()
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); pages.push(page)
      page.on('pageerror', e => { if (!/Importing a module script failed|due to access control checks/.test(String(e))) throw e })   // a page that is closed while it still loads is not a failure
      await page.goto(base)
      await page.getByRole('button', { name: 'Plate 60 x 30 x 4' }).click()
      await page.waitForFunction(() => !!(window as unknown as { __am?: { result: { ok: boolean } | null } }).__am?.result?.ok, null, { timeout: 60000 })
      await page.getByRole('tab', { name: /^Stored/ }).click()
      const row = page.locator('[data-store-name="original"]')
      await row.getByText(/The model this project started from/).waitFor()
      await row.locator('.am-storedhead').click()
      await row.getByText(/cannot be changed or deleted/).waitFor()
      expect(await row.getByRole('button', { name: /Delete|Replace/ }).count()).toBe(0)
      await page.getByRole('tab', { name: 'Steps' }).click()
      // a step that scales the model, then Load "original": the result is the plate again
      await page.getByRole('button', { name: 'Add a step' }).click()
      await page.locator('.am-addpanel').waitFor()
      if ((await page.getByRole('menuitem', { name: 'Load', exact: true }).count()) === 0) await page.getByRole('menuitem', { name: /^More/ }).click()
      await page.getByRole('menuitem', { name: 'Load', exact: true }).click()
      await page.locator('.am-picker').click()
      await page.locator('.am-pickerpop').getByRole('option', { name: /original/ }).click()
      await page.getByRole('button', { name: /^original\b/ }).waitFor()
      await page.waitForFunction(() => (window as unknown as { __am: { result: { ok: boolean; triangles: number } | null } }).__am.result?.ok === true, null, { timeout: 30000 })
    }, 180000)

    it('a step with a missing drawing offers the way out on its banner: choose another one, import it again, and open the Stored tab', async ctx => {
      if (!browser) return ctx.skip()
      const page = await start()
      await imported(page)
      await page.getByRole('tab', { name: /^Stored/ }).click()
      const row = page.locator('[data-store-name="logo"]')
      await row.locator('.am-storedhead').click()
      await row.getByRole('button', { name: 'Delete logo' }).click()
      await page.getByRole('dialog', { name: /Delete “logo”/ }).getByRole('button', { name: 'Delete anyway' }).click()
      await page.getByRole('tab', { name: 'Steps' }).click()
      await page.getByText(/stored item “logo” no longer exists/).first().waitFor()
      const banner = page.locator('.am-notes')
      await banner.getByRole('button', { name: 'Choose a drawing' }).waitFor()
      // Import SVG… opens the file chooser of the step's own picker, and the drawing is imported under a new name
      await chooseFile(page, banner.getByRole('button', { name: 'Import…' }), svgFile('fresh.svg'))
      await page.getByRole('dialog', { name: 'Import SVG' }).getByRole('button', { name: 'Keep drawing' }).click()
      await page.getByRole('button', { name: /^fresh\b/ }).waitFor()
    }, 180000)
  })
}
