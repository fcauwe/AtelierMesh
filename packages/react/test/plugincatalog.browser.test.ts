import { build } from 'esbuild'
import { chromium, webkit } from 'playwright-core'
import type { Browser, Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const here = path.dirname(fileURLToPath(import.meta.url))
const css = ['theme.css', 'overlay.css', 'editor.css'].map(f => fs.readFileSync(path.join(here, '../src', f), 'utf8')).join('\n')
let script = ''
beforeAll(async () => {
  const r = await build({ entryPoints: [path.join(here, 'fixtures/plugin-catalog-harness.tsx')], bundle: true, format: 'iife', write: false, logLevel: 'silent', platform: 'browser', jsx: 'automatic', loader: { '.json': 'json' } })
  script = r.outputFiles[0]!.text
})
const opened: Array<{ close(): Promise<void> }> = []
type W = { __calls: string[]; __set: (s: object) => void; __xss?: number }

async function open(browser: Browser, opts: { dark?: boolean; width?: number } = {}): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: opts.width ?? 900, height: 1000 }, colorScheme: opts.dark ? 'dark' : 'light', reducedMotion: 'reduce' })
  opened.push(ctx)
  const page = await ctx.newPage()
  page.on('pageerror', e => { throw e })
  await page.setContent('<!doctype html><html lang="en"><head><title>Plugins</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="root"></div></body></html>')
  await page.addStyleTag({ content: css })
  await page.addScriptTag({ content: script })
  await page.evaluate(() => (window as unknown as { __pm: { start(): void } }).__pm.start())
  await page.getByRole('dialog', { name: 'Plugins' }).waitFor()
  await page.getByRole('button', { name: 'Add plugin' }).click()   // the catalog is on the add screen
  await page.getByRole('dialog', { name: 'Add a plugin' }).waitFor()
  return page
}
async function axe(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: axePath })
  return page.evaluate(async () => (await (window as unknown as { axe: { run: (c: Document, o: object) => Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ target: string[] }> }> }> } }).axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] })).violations.map(v => `${v.id}: ${v.help} (${v.nodes.map(n => n.target.join(' ')).join(', ')})`))
}
const calls = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as W).__calls)

for (const [name, type] of [['chromium', chromium], ['webkit', webkit]] as const) {
  describe(`plugin catalog in the manager (${name})`, () => {
    let browser: Browser | null = null
    beforeAll(async () => { try { browser = await type.launch({ headless: true }) } catch (e) { console.warn(`${name} is not available here: ${String(e).split('\n')[0]}`) } })
    afterAll(async () => { await browser?.close() })
    afterEach(async () => { await Promise.all(opened.splice(0).map(c => c.close().catch(() => undefined))) })

    it('asks the host to load the catalog once when the manager opens, and lists everything; search filters by name, description, id and licence', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser)
      const dlg = page.getByRole('dialog', { name: 'Add a plugin' })
      await dlg.getByRole('heading', { name: 'Plugin catalog' }).waitFor()
      expect(await calls(page)).toEqual(['open'])
      await dlg.getByText('4 plugins from plugins.example.org').waitFor()
      const search = dlg.getByRole('searchbox', { name: 'Search in the catalog' })
      expect(await dlg.locator('[data-catalog-plugin]').count()).toBe(4)
      // the public download count: shown when there is one, singular for one, nothing for none or unknown
      await dlg.locator('[data-catalog-plugin="com.example.mirror"]').getByTestId('downloads').getByText(/1\s240 downloads/).waitFor()
      await dlg.locator('[data-catalog-plugin="com.example.twist"]').getByTestId('downloads').getByText(/· 1 download$/).waitFor()
      expect(await dlg.locator('[data-catalog-plugin="com.example.hollow"] [data-testid="downloads"]').count()).toBe(0)
      // a plugin says which old id it replaces
      await dlg.locator('[data-catalog-plugin="com.example.mirror"]').getByTestId('replaces').getByText('Replaces org.old.mirror').waitFor()
      expect(await dlg.locator('[data-catalog-plugin="com.example.twist"] [data-testid="replaces"]').count()).toBe(0)
      // the list is on the page, not in a frame of its own with a scrollbar
      expect(await dlg.locator('.am-catalog-list').evaluate(el => { const s = getComputedStyle(el); return [s.overflowY, s.maxHeight] })).toEqual(['visible', 'none'])
      await search.fill('twist'); expect(await dlg.locator('[data-catalog-plugin]').count()).toBe(1); await dlg.getByText('1 match').waitFor()
      await search.fill('apache'); await dlg.locator('[data-catalog-plugin="com.example.hollow"]').waitFor(); expect(await dlg.locator('[data-catalog-plugin]').count()).toBe(1)
      await search.fill('HALVES'); await dlg.locator('[data-catalog-plugin="com.example.mirror"]').waitFor()
      await search.fill('example.twist'); await dlg.locator('[data-catalog-plugin="com.example.twist"]').waitFor()
      await search.fill('nothing like this'); await dlg.getByText('No plugin matches your search.').waitFor(); expect(await dlg.locator('[data-catalog-plugin]').count()).toBe(0)
      await search.fill(''); expect(await dlg.locator('[data-catalog-plugin]').count()).toBe(4)
    })

    it('shows install, update and installed states and calls back; text from the catalog is never markup', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser)
      const dlg = page.getByRole('dialog', { name: 'Add a plugin' })
      const mirror = dlg.locator('[data-catalog-plugin="com.example.mirror"]')
      await mirror.getByRole('button', { name: 'Update to 1.2.0 Mirror' }).click()
      await mirror.getByRole('link', { name: /Website/ }).waitFor()
      expect(await mirror.locator('img').getAttribute('alt')).toBe('A mirrored vase')
      await dlg.locator('[data-catalog-plugin="com.example.hollow"]').getByRole('button', { name: 'Install Hollow <b>out</b>' }).click()
      await dlg.locator('[data-catalog-plugin="com.example.twist"]').getByText('Installed 2.0.0').waitFor()
      expect(await dlg.locator('[data-catalog-plugin="com.example.twist"]').getByRole('button').count()).toBe(0)
      await dlg.locator('[data-catalog-plugin="core"]').getByText('Built in').waitFor()
      expect(await calls(page)).toEqual(['open', 'install:com.example.mirror', 'install:com.example.hollow'])
      expect(await page.evaluate(() => (window as unknown as W).__xss)).toBeUndefined()
      expect(await dlg.locator('b').count()).toBe(0)
      // back on the list, the installed row says an update is available, and has its own Update button
      await dlg.getByRole('button', { name: 'Back to the plugins' }).click()
      const list = page.getByRole('dialog', { name: 'Plugins' })
      const row = list.locator('ul.am-pluginlist li', { hasText: 'Mirror' })
      await row.getByText('Update available: 1.2.0').waitFor()
      await row.getByRole('button', { name: 'Update to 1.2.0 Mirror' }).click()
      expect((await calls(page)).slice(-1)).toEqual(['install:com.example.mirror'])
      expect(await list.locator('ul.am-pluginlist li', { hasText: 'Twist' }).getByText(/Update available/).count()).toBe(0)
    })

    it('while one plugin downloads, the others cannot be started and the button says so', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser)
      await page.evaluate(() => (window as unknown as W).__set({ busy: 'com.example.hollow' }))
      const dlg = page.getByRole('dialog', { name: 'Add a plugin' })
      await dlg.locator('[data-catalog-plugin="com.example.hollow"]').getByRole('button', { name: /Downloading/ }).waitFor()
      expect(await dlg.locator('[data-catalog-plugin="com.example.mirror"]').getByRole('button').isDisabled()).toBe(true)
    })

    it('says "Checking the catalog…" while it loads and "not available here" with Try again when it cannot be had', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser)
      const dlg = page.getByRole('dialog', { name: 'Add a plugin' })
      await page.evaluate(() => (window as unknown as W).__set({ status: 'loading' }))
      await dlg.getByText('Checking the catalog…').waitFor()
      expect(await dlg.getByRole('searchbox', { name: 'Search in the catalog' }).isDisabled()).toBe(true)
      await page.evaluate(() => (window as unknown as W).__set({ status: 'unavailable' }))
      await dlg.getByText('The catalog is not available here.').waitFor()
      await dlg.getByRole('button', { name: 'Try again' }).click()
      expect((await calls(page)).slice(-1)).toEqual(['retry'])
      expect(await dlg.locator('[data-catalog-plugin]').count()).toBe(0)
      // the rest of the manager still works: the installed plugins and the file and address fields
      await dlg.getByLabel('Plugin address (https)').waitFor()
      await dlg.getByRole('button', { name: 'Back to the plugins' }).click()
      await page.getByRole('dialog', { name: 'Plugins' }).getByText('Twist').first().waitFor()
    })

    it('narrow screens: no horizontal scroll', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser, { width: 360 })
      await page.getByRole('dialog', { name: 'Add a plugin' }).waitFor()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      expect(await page.evaluate(() => { const d = document.querySelector('[role="dialog"]') as HTMLElement; return d.scrollWidth <= d.clientWidth + 1 })).toBe(true)
    })

    for (const dark of [false, true]) {
      it(`has no accessibility violations with the catalog, in ${dark ? 'dark' : 'light'} mode`, async ctx => {
        if (!browser) return ctx.skip()
        const page = await open(browser, { dark })
        await page.getByRole('dialog', { name: 'Add a plugin' }).getByRole('searchbox', { name: 'Search in the catalog' }).waitFor()
        expect(await axe(page), 'ready').toEqual([])
        await page.evaluate(() => (window as unknown as W).__set({ status: 'unavailable' }))
        await page.getByText('The catalog is not available here.').waitFor()
        expect(await axe(page), 'unavailable').toEqual([])
      })
    }
  })
}
