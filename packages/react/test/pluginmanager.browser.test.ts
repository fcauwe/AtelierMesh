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
  const r = await build({ entryPoints: [path.join(here, 'fixtures/plugin-manager-harness.tsx')], bundle: true, format: 'iife', write: false, logLevel: 'silent', platform: 'browser', jsx: 'automatic', loader: { '.woff2': 'dataurl' } })
  script = r.outputFiles[0]!.text
})
const opened: Array<{ close(): Promise<void> }> = []
const APPROVAL = { kind: 'update', name: 'One', version: '1.3.0', installedVersion: '1.2.0', description: 'A plugin whose description looks like <b>markup</b>.', license: 'GPL-3.0-only', contact: { name: 'Maker', url: 'https://example.org/one', email: 'one@example.org' }, signed: false, signerCheck: 'lost', permissions: [], origin: 'plugins.example.org', replace: true }

async function open(browser: Browser, opts: { dark?: boolean; approval?: object } = {}): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 }, colorScheme: opts.dark ? 'dark' : 'light', reducedMotion: 'reduce' })
  opened.push(ctx)
  const page = await ctx.newPage()
  page.on('pageerror', e => { throw e })
  await page.setContent('<!doctype html><html lang="en"><head><title>Plugins</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="root"></div></body></html>')
  await page.evaluate(a => { (window as unknown as { __approval?: object }).__approval = a }, opts.approval)
  await page.addStyleTag({ content: css })
  await page.addScriptTag({ content: script })
  await page.evaluate(() => (window as unknown as { __pm: { start(): void } }).__pm.start())
  return page
}
async function axe(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: axePath })
  return page.evaluate(async () => (await (window as unknown as { axe: { run: (c: Document, o: object) => Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ target: string[] }> }> }> } }).axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] })).violations.map(x => `${x.id}: ${x.help} -> ${x.nodes.map(n => n.target.join(' ')).join(', ')}`))
}

for (const [name, type] of [['chromium', chromium], ['webkit', webkit]] as const) {
  describe(`plugin manager rows and approval in ${name}`, () => {
    let browser: Browser | null = null
    beforeAll(async () => { try { browser = await type.launch({ headless: true }) } catch (e) { console.warn(`${name} is not available here: ${String(e).split('\n')[0]}`) } })
    afterAll(async () => { await browser?.close() })
    afterEach(async () => { await Promise.all(opened.splice(0).map(c => c.close().catch(() => undefined))) })

    it('shows description, licence chip and contact as text; links only when valid; never interprets markup', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser)
      const dlg = page.getByRole('dialog', { name: 'Plugins' })
      const one = dlg.locator('li', { hasText: 'One' }).first()
      // markup in a description or a name is shown as the text it is
      await one.getByText('<img src=x onerror="window.__xss=1"> A plugin whose description looks like markup.').waitFor()
      await one.getByText('<b>Bold Maker</b>').waitFor()
      expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined()
      expect(await dlg.locator('img, b').count()).toBe(0)
      await one.getByText('GPL-3.0-only').first().waitFor()
      const web = one.getByRole('link', { name: /Website/ })
      expect(await web.getAttribute('href')).toBe('https://example.org/one'); expect(await web.getAttribute('rel')).toBe('noopener noreferrer'); expect(await web.getAttribute('target')).toBe('_blank')
      expect(await one.getByRole('link', { name: 'one@example.org' }).getAttribute('href')).toBe('mailto:one@example.org')
      // stored, host only, buttons
      await one.getByText(/Stored in this browser \(12 KB, added /).waitFor()
      await one.getByText('Updates from plugins.example.org').waitFor()
      expect(await one.getByText('https://plugins.example.org/one-1.2.0.amplugin').count()).toBe(0)
      for (const b of ['Check for update One', 'Copy link One', 'Download One', 'Remove One']) await one.getByRole('button', { name: b }).waitFor()
      // no contact: no link; a bad address or email: no link
      expect(await dlg.locator('li', { hasText: 'Two' }).first().getByRole('link').count()).toBe(0)
      expect(await dlg.locator('li', { hasText: 'Bad contact' }).getByRole('link').count()).toBe(0)
      expect(await dlg.locator('a[href^="javascript"]').count()).toBe(0)
      // a plugin that failed its check stays listed with the reason, and can be removed or downloaded
      const failed = dlg.locator('li', { hasText: 'Failed one' })
      await failed.getByText(/failed a check: the stored file does not match its checksum/).waitFor()
      await failed.getByRole('button', { name: 'Download Failed one' }).click()
      await failed.getByRole('button', { name: 'Check for update Failed one' }).count().then(n => expect(n).toBe(0))
      // built in: metadata, no remove
      await dlg.locator('li', { hasText: 'Core' }).getByText('MIT').first().waitFor()
      // Remove asks first with the shared dialog
      await one.getByRole('button', { name: 'Remove One' }).click()
      await page.getByRole('dialog', { name: 'Remove this plugin?' }).getByRole('button', { name: 'Keep it' }).click()
      expect(await page.evaluate(() => (window as unknown as { __calls: string[] }).__calls)).toEqual(['download:ext.off'])
      await dlg.locator('li', { hasText: 'One' }).first().getByRole('button', { name: 'Remove One' }).click()
      await page.getByRole('dialog', { name: 'Remove this plugin?' }).getByRole('button', { name: 'Remove', exact: true }).click()
      expect(await page.evaluate(() => (window as unknown as { __calls: string[] }).__calls)).toEqual(['download:ext.off', 'remove:ext.one'])
    })

    for (const dark of [false, true]) {
      it(`has no accessibility violations: the manager and the approval, in ${dark ? 'dark' : 'light'} mode`, async ctx => {
        if (!browser) return ctx.skip()
        let page = await open(browser, { dark })
        await page.getByRole('dialog', { name: 'Plugins' }).waitFor()
        expect(await axe(page), 'manager').toEqual([])
        page = await open(browser, { dark, approval: APPROVAL })
        await page.getByRole('dialog', { name: 'Update this plugin?' }).waitFor()
        expect(await axe(page), 'approval').toEqual([])
      })
    }

    it('the approval dialog shows the versions, description, licence, contact and the signature warning, and answers Update or Cancel', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser, { approval: APPROVAL })
      const dlg = page.getByRole('dialog', { name: 'Update this plugin?' })
      await dlg.getByText('1.2.0 → 1.3.0').waitFor()
      await dlg.getByText('A plugin whose description looks like <b>markup</b>.').waitFor()
      expect(await dlg.locator('b').count()).toBe(0)
      await dlg.getByText('GPL-3.0-only').first().waitFor()
      await dlg.getByRole('link', { name: /Website/ }).waitFor()
      await dlg.getByText('Warning: the installed version is signed, this new one is not.').waitFor()
      await dlg.getByText('Not signed: nobody vouches for this file.').waitFor()
      await dlg.getByRole('button', { name: 'Cancel' }).click()
      expect(await page.evaluate(() => (window as unknown as { __calls: string[] }).__calls)).toEqual(['cancel'])
      const page2 = await open(browser, { approval: { ...APPROVAL, kind: 'install', installedVersion: undefined, replace: false, signed: true, signer: 'Anna', signerCheck: undefined } })
      const d2 = page2.getByRole('dialog', { name: 'Add this plugin?' })
      await d2.getByText('Signed by Anna').waitFor()
      await d2.getByRole('button', { name: 'Add', exact: true }).click()
      expect(await page2.evaluate(() => (window as unknown as { __calls: string[] }).__calls)).toEqual(['approve'])
    })
  })
}
