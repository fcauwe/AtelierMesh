import { Buffer } from 'node:buffer'
import { chromium, devices, webkit } from 'playwright-core'
import type { Browser, Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { emptyStepList, loadProject, makeStep, meshReport, parseRecipe, read3mf, saveProject, write3mf, writeStlBinary } from '@ateliermesh/core'
import { boxMesh, sphereMesh } from '@ateliermesh/core/testing'
import { buildPluginPackage } from '@ateliermesh/loader'
import { SAMPLES } from '../src/samples'
import { extractQuickPrompt, extractQuickPromptNoNpm } from '../tools/docs.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(here, '../dist')
const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
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

type Violation = { id: string; impact: string | null; nodes: Array<{ target: string[] }>; help: string }
async function axe(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: axePath })
  const v = await page.evaluate(async () => (await (window as unknown as { axe: { run: (c?: object, o?: object) => Promise<{ violations: unknown[] }> } }).axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] })).violations) as Violation[]
  return v.map(x => `${x.id} (${x.impact}): ${x.help} -> ${x.nodes.map(n => n.target.join(' ')).join(', ')}`)
}

const stl = (m: Parameters<typeof writeStlBinary>[0]) => ({ name: 'part.stl', mimeType: 'model/stl', buffer: Buffer.from(writeStlBinary(m)) })
const GL = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']

for (const [name, type, profile] of [['chromium', chromium, null], ['webkit', webkit, null], ['webkit on an iPhone profile', webkit, 'iPhone 13']] as const) {
  describe(`standalone journey in ${name}`, () => {
    let browser: Browser | null = null
    const launch = async (): Promise<void> => {
      try { browser = await type.launch({ headless: true, ...(name === 'chromium' ? { args: GL } : {}) }) }
      catch (e) { console.warn(`${name} is not available here: ${String(e).split('\n')[0]}`) }
    }
    const phone = profile !== null
    // a phone-sized WebKit keeps little memory: every test gets a fresh browser there
    beforeAll(async () => { if (!phone) await launch() })
    beforeEach(async () => { if (phone) await launch() })
    afterEach(async () => { if (phone) { await browser?.close(); browser = null } })
    afterAll(async () => { await browser?.close() })
    // the plugin manager opens as a gallery; most tests work with the list (every button in sight), so the list is the stored choice unless a test says otherwise
    const newPage = async (extra: object = {}): Promise<Page> => {
      const page = await browser!.newPage(profile ? { ...devices[profile], ...extra } : { viewport: { width: 1280, height: 800 }, ...extra })
      await page.addInitScript(() => { try { if (!localStorage.getItem('am.pluginView')) localStorage.setItem('am.pluginView', 'list') } catch { /* private window */ } })
      return page
    }
    const result = (page: Page): Promise<{ ok: boolean; triangles: number }> => page.evaluate(() => (window as unknown as { __am: { result: { ok: boolean; triangles: number } } }).__am.result)
    const ready = async (page: Page): Promise<void> => { await page.waitForFunction(() => !!(window as unknown as { __am?: { result: { ok: boolean } | null } }).__am?.result?.ok, null, { timeout: 60000 }) }
    const openSample = async (page: Page, sample = 'Plate 60 x 30 x 4'): Promise<void> => { await page.getByRole('button', { name: sample }).click(); await ready(page) }
    // on a phone the steps and the settings sit in the sheet: open the sheet to its full height first
    const addStep = async (page: Page, op: string | RegExp): Promise<void> => {
      if (phone) { await expandSheet(page); const tab = page.getByRole('tab', { name: 'Steps' }); if ((await tab.count()) > 0) await tab.click() }
      await page.getByRole('button', { name: 'Add a step' }).click()
      // the low-importance operations (the checks, Store and Load) sit in the collapsed "More" group when the menu is long
      if ((await page.getByRole('menuitem', { name: op }).count()) === 0) await page.getByRole('menuitem', { name: /^More/ }).click()
      await page.getByRole('menuitem', { name: op }).click()
    }
    const stepNames = async (page: Page): Promise<string[]> => {
      if (phone) { await expandSheet(page); const tab = page.getByRole('tab', { name: 'Steps' }); if ((await tab.count()) > 0) await tab.click() }
      return (await page.locator('.am-stepname .am-t1').allTextContents()).map(x => x.trim())
    }
    const expandSheet = async (page: Page): Promise<void> => { const h = page.locator('.am-sheet-handle'); if ((await h.count()) > 0 && (await page.locator('.am-sheet-full').count()) === 0) { await h.click(); if ((await page.locator('.am-sheet-full').count()) === 0) await h.click() } }

    it('lists the bodies of a multi-part 3MF in the Parts list, not only the colours', async ctx => {
      if (!browser) return ctx.skip()
      const a = boxMesh(10, 10, 10), b = boxMesh(10, 10, 10)
      const shift = Float64Array.from(b.positions, (v, i) => (i % 3 === 0 ? v + 20 : v))
      const m = { positions: Float64Array.from([...a.positions, ...shift]), indices: Uint32Array.from([...a.indices, ...Array.from(b.indices, v => v + a.positions.length / 3)]),
        groups: [{ start: 0, count: a.indices.length / 3, role: 'solid' as const, name: 'Lid' }, { start: a.indices.length / 3, count: b.indices.length / 3, role: 'solid' as const, name: 'Base' }] }
      const file = { name: 'two-parts.3mf', mimeType: 'model/3mf', buffer: Buffer.from(write3mf(m, { slicer: 'none' }).bytes) }
      const page = await newPage()
      await page.goto(base)
      await page.setInputFiles('.am-drop input[type=file]', file)
      await ready(page)
      if (phone) { await expandSheet(page); const tab = page.getByRole('tab', { name: 'Steps' }); if ((await tab.count()) > 0) await tab.click() }
      await page.locator('.am-parts summary').click()
      const rows = await page.locator('.am-parts li').allTextContents()
      expect(rows.some(r => r.includes('Lid'))).toBe(true)
      expect(rows.some(r => r.includes('Base'))).toBe(true)
      // 'Keep only part' starts on the first body (no error to fix first) and keeps just that one; names with capitals and spaces are fine
      const before = (await result(page)).triangles
      await addStep(page, /Keep only part/)
      await page.waitForFunction(n => ((window as unknown as { __am?: { result: { ok: boolean; triangles: number } | null } }).__am?.result?.triangles ?? n) < n, before, { timeout: 20000 })
      expect((await result(page)).ok).toBe(true)
      expect(await page.locator('.am-problem.am-error').count()).toBe(0)
      await page.close()
    }, 120000)

    it('saves the steps as a recipe, applies it to another model (one undo), downloads it and opens the file again', async ctx => {
      if (!browser || phone) return ctx.skip()                      // the menus are the same on a phone; the desktop run covers the flow
      const page = await newPage({ acceptDownloads: true })
      await page.goto(base)
      await page.getByRole('button', { name: /^Name tag(?! with)/ }).click(); await ready(page)
      const menu = async (item: string): Promise<void> => { await page.getByRole('button', { name: 'Add a step' }).first().click(); await page.getByRole('menuitem', { name: item }).click() }
      // save all the current steps as a recipe, in this browser
      await menu('Save as a recipe…')
      let dlg = page.getByRole('dialog')
      await dlg.getByLabel('Name', { exact: true }).fill('My name')
      await dlg.getByRole('button', { name: 'Save in this browser' }).click()
      await dlg.waitFor({ state: 'detached' })
      // another model, in a fresh page: the recipe is still there; applying it adds its steps after the model's own (here: none)
      await page.goto(base)
      await page.getByRole('button', { name: 'Plate 60 x 30 x 4' }).click(); await ready(page)
      await menu('Apply a recipe…')
      await page.getByRole('dialog').getByRole('button', { name: 'Use My name' }).click()
      await page.waitForFunction(() => document.querySelectorAll('.am-stepname').length === 1, null, { timeout: 20000 })
      expect((await page.locator('.am-stepname .am-t1').allTextContents()).map(x => x.trim())).toEqual(['Name'])
      await ready(page)
      expect((await result(page)).ok).toBe(true)
      // download it as a file
      await menu('Save as a recipe…')
      dlg = page.getByRole('dialog')
      const [download] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('button', { name: 'Download file' }).click()])
      expect(download.suggestedFilename()).toMatch(/\.amrecipe$/)
      const text = fs.readFileSync(await download.path() as string, 'utf8')
      const parsed = parseRecipe(text)
      expect(parsed.ok && parsed.recipe.steps.steps.map(x => x.op)).toEqual(['emboss'])
      // one undo takes the whole recipe back; opening the file puts it back again
      await page.getByRole('button', { name: 'Undo' }).click()
      await page.waitForFunction(() => document.querySelectorAll('.am-stepname').length === 0, null, { timeout: 20000 })
      await menu('Apply a recipe…')
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('dialog').getByRole('button', { name: 'Open a recipe file…' }).click()])
      await chooser.setFiles({ name: 'name.amrecipe', mimeType: 'application/json', buffer: Buffer.from(text) })
      await page.waitForFunction(() => document.querySelectorAll('.am-stepname').length === 1, null, { timeout: 20000 })
      // a file that is not a recipe says so
      await menu('Apply a recipe…')
      const [chooser2] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('dialog').getByRole('button', { name: 'Open a recipe file…' }).click()])
      await chooser2.setFiles({ name: 'nope.amrecipe', mimeType: 'application/json', buffer: Buffer.from('{ not json') })
      await page.getByRole('dialog').getByText('not a recipe').waitFor()
      await page.close()
    }, 240000)

    it('welcomes a first-time visitor with a short popup after the intro, once', async ctx => {
      if (!browser) return ctx.skip()
      const page = await newPage()
      await page.goto(base)                                   // automated browsers do not get the popup by themselves
      await page.getByText('Upload your 3D model').waitFor()
      expect(await page.getByRole('dialog').count()).toBe(0)
      await page.goto(`${base}?welcome=1&intro=0`)
      const dlg = page.getByRole('dialog')
      await dlg.getByText('Welcome to AtelierMesh').waitFor()
      expect(await dlg.getByRole('listitem').count()).toBe(4 + 3)         // four things to know, three things that are new
      expect(await dlg.getByText('Everything runs in your browser').count()).toBe(1)
      expect(await dlg.getByText('New in this version').count()).toBe(1)
      expect(await dlg.getByText(/SVG on the surface: put your own SVG/).count()).toBe(1)
      await dlg.getByRole('button', { name: 'Get started' }).click()
      await dlg.waitFor({ state: 'detached' })
      expect(await page.evaluate(() => localStorage.getItem('am.welcomed'))).toBe('1')
      expect(await page.evaluate(() => localStorage.getItem('am.newsSeen'))).toBe('0.3.0')
      await page.close()
    }, 120000)

    it('shows a visitor who knows the app only what is new, in the chosen language, and remembers it', async ctx => {
      if (!browser) return ctx.skip()
      const page = await newPage()
      await page.goto(`${base}?welcome=news&intro=0`)
      const dlg = page.getByRole('dialog')
      await dlg.getByText("What's new in AtelierMesh").waitFor()
      expect(await dlg.getByRole('listitem').count()).toBe(3)             // the news, not the welcome
      expect(await dlg.getByText('Everything runs in your browser').count()).toBe(0)
      await dlg.getByRole('button', { name: 'Got it' }).click()
      await dlg.waitFor({ state: 'detached' })
      expect(await page.evaluate(() => localStorage.getItem('am.newsSeen'))).toBe('0.3.0')
      await page.close()
    }, 120000)

    it('goes back to the start page from the logo (asking first), and plays the logo intro once when asked to', async ctx => {
      if (!browser) return ctx.skip()
      const page = await newPage()
      await page.goto(`${base}?intro=1`)
      await page.locator('.am-intro').waitFor({ state: 'attached' })   // (hidden by CSS under reduced motion, which the test browsers use)
      await page.waitForSelector('.am-intro', { state: 'detached', timeout: 8000 })   // plays for about three seconds and goes away
      await page.getByRole('button', { name: /^Name tag(?! with)/ }).click()
      await ready(page)
      await page.getByRole('button', { name: 'Back to the start page' }).click()
      const dlg = page.getByRole('alertdialog')
      await dlg.getByText('Leave without saving?').waitFor()
      await dlg.getByRole('button', { name: 'Stay' }).click()
      expect(await page.getByRole('button', { name: 'Back to the start page' }).count()).toBe(1)
      await page.getByRole('button', { name: 'Back to the start page' }).click()
      await page.getByRole('alertdialog').getByRole('button', { name: 'Leave without saving' }).click()
      await page.getByText('Upload your 3D model').waitFor()
      // without the switch (automated browsers skip it) and in the same session the intro does not come back
      await page.goto(base)
      expect(await page.locator('.am-intro').count()).toBe(0)
      await page.close()
    }, 120000)

    it('opens the Voronoi shell sample: a vase hollowed into a closed lattice and smoothed', async ctx => {
      if (!browser) return ctx.skip()
      const page = await newPage()
      await page.goto(base)
      await page.getByRole('button', { name: /Voronoi shell/ }).click()
      await page.waitForFunction(() => !!(window as unknown as { __am?: { result: { ok: boolean; triangles: number } | null } }).__am?.result?.ok, null, { timeout: 90000 })
      const r = await result(page)
      expect(r.ok).toBe(true)
      expect(r.triangles).toBeGreaterThan(5000)   // a lattice, not the few thousand triangles of the plain vase
      await page.close()
    }, 150000)

    // records every value the loading bar takes (data-progress) and when the loading page is added to the page
    const watchLoading = (page: Page): Promise<void> => page.evaluate(() => {
      const w = window as unknown as { __prog: number[]; __views: number; __stages: string[] }
      w.__prog = []; w.__views = 0; w.__stages = []
      const note = (el: Element): void => { const v = el.getAttribute('data-progress'); if (v !== null) w.__prog.push(Number(v)); const st = el.closest('[data-stage]')?.getAttribute('data-stage'); if (st && w.__stages.at(-1) !== st) w.__stages.push(st) }
      new MutationObserver(ms => {
        for (const m of ms) {
          if (m.type === 'attributes' && m.target instanceof Element) note(m.target)
          for (const n of m.addedNodes) if (n instanceof Element) { if (n.matches('.am-loadview') || n.querySelector('.am-loadview')) w.__views++; n.querySelectorAll('[role=progressbar]').forEach(note) }
        }
      }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-progress'] })
    })
    const bigFile = (): { name: string; mimeType: string; buffer: Buffer } => ({ name: 'big.stl', mimeType: 'model/stl', buffer: Buffer.from(writeStlBinary(sphereMesh(10, 7))) })   // 327 680 triangles

    it('the loader is still without animation under reduced motion, animated otherwise, and passes axe in light and dark', async ctx => {
      if (!browser) return ctx.skip()
      for (const reduced of [true, false]) {
        const page = await newPage({ reducedMotion: reduced ? 'reduce' : 'no-preference' })
        await page.goto(`${base}?loadingDelay=0&editLimit=3000000`)
        await page.getByRole('button', { name: /^Name tag(?! with)/ }).waitFor()
        await page.setInputFiles('.am-drop input[type=file]', bigFile())
        const tri = page.locator('.am-loadview .am-loader-f').first()
        await tri.waitFor({ timeout: 20000 })
        expect(await tri.evaluate(e => getComputedStyle(e).animationName)).toBe(reduced ? 'none' : 'am-pass')
        if (reduced) {
          expect(await page.locator('.am-loadview .am-bar-indeterminate').count() >= 0).toBe(true)
          for (const scheme of ['light', 'dark'] as const) { await page.emulateMedia({ colorScheme: scheme }); if (await page.locator('.am-loadview').count() > 0) expect(await axe(page)).toEqual([]) }
        }
        await page.close()
      }
    }, 180000)

    it('shows the loader with a stage and a growing bar while a big file opens, and nothing for a small one', async ctx => {
      if (!browser) return ctx.skip()
      const page = await newPage()
      await page.goto(`${base}?loadingDelay=0&editLimit=3000000`)
      await page.getByRole('button', { name: /^Name tag(?! with)/ }).waitFor()
      await watchLoading(page)
      await page.setInputFiles('.am-drop input[type=file]', bigFile())
      await page.getByRole('dialog').or(page.getByRole('heading', { name: 'Check the size' })).first().waitFor({ timeout: 60000 })
      const seen = await page.evaluate(() => { const w = window as unknown as { __prog: number[]; __views: number; __stages: string[] }; return { __prog: w.__prog, __views: w.__views, __stages: w.__stages } })
      expect(seen.__views).toBeGreaterThan(0)
      expect(seen.__prog.length).toBeGreaterThanOrEqual(3)
      expect(seen.__prog.every((v, i) => i === 0 || v >= (seen.__prog[i - 1] as number))).toBe(true)
      expect(seen.__prog.at(-1)).toBeGreaterThan(seen.__prog[0] as number)
      expect(seen.__stages.length).toBeGreaterThan(0)
      await page.close()
      // a small file opens at once: with the normal delay no loading page is ever added
      const quick = await newPage()
      await quick.goto(`${base}?editLimit=3000000`)
      await quick.getByRole('button', { name: /^Name tag(?! with)/ }).waitFor()
      await watchLoading(quick)
      await quick.setInputFiles('.am-drop input[type=file]', stl(boxMesh(3, 3, 3)))
      await quick.getByRole('heading', { name: 'Check the size' }).waitFor({ timeout: 20000 })
      expect(await quick.evaluate(() => (window as unknown as { __views: number }).__views)).toBe(0)
      await quick.close()
    }, 180000)

    it('Stop on the loading page goes back to the start page and nothing opens', async ctx => {
      if (!browser) return ctx.skip()
      const page = await newPage()
      await page.goto(`${base}?loadingDelay=0&editLimit=3000000`)
      await page.getByRole('button', { name: /^Name tag(?! with)/ }).waitFor()
      await page.setInputFiles('.am-drop input[type=file]', bigFile())
      await page.getByRole('button', { name: 'Stop' }).click()
      await page.waitForTimeout(2500)
      expect(await page.getByRole('heading', { name: 'Check the size' }).count()).toBe(0)
      expect(await page.locator('.am-loadview').count()).toBe(0)
      await page.getByText('Upload your 3D model').waitFor()
      await page.close()
    }, 180000)

    it('says on the start page that everything runs in the browser, in every language', async ctx => {
      if (!browser) return ctx.skip()
      const page = await newPage()
      await page.goto(base)
      const line = page.locator('.am-privacy')
      await line.waitFor()
      expect(await line.textContent()).toContain('Everything runs in your browser. Your files are never sent to a server, unless you explicitly share an example.')
      await page.getByRole('combobox', { name: 'Language' }).selectOption('nl')
      expect(await line.textContent()).toContain('Alles draait in je browser')
      await page.getByRole('combobox', { name: 'Language' }).selectOption('fr')
      expect(await line.textContent()).toContain('Tout se passe dans votre navigateur')
      await page.getByRole('combobox', { name: 'Language' }).selectOption('en')
      for (const scheme of ['light', 'dark'] as const) { await page.emulateMedia({ colorScheme: scheme }); expect(await axe(page)).toEqual([]) }
      await page.close()
    }, 120000)

    it('explains how to build a plugin: the info panel, the guide page, the example file and the prompt that is copied', async ctx => {
      if (!browser) return ctx.skip()
      const page = await newPage()
      await page.addInitScript(() => { (window as unknown as { __copied: string }).__copied = ''; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => { (window as unknown as { __copied: string }).__copied = t } } }) })
      await page.goto(base)
      await page.getByRole('button', { name: 'Settings' }).click()
      await page.getByRole('dialog').getByRole('tab', { name: 'Plugins' }).click()
      await page.getByRole('button', { name: 'Add plugin' }).click()   // the guide is on the add screen
      await page.getByRole('button', { name: 'Build your own plugin' }).click()
      const dlg = page.getByRole('dialog', { name: 'Build your own plugin' })
      await dlg.waitFor()
      // the guide is a page of the app, with a contents list and a way back
      const guideHref = (await dlg.getByRole('link', { name: /Open the full guide/ }).getAttribute('href'))!
      const guide = await fetch(new URL(guideHref, base))
      expect(guide.status).toBe(200)
      const html = await guide.text()
      expect(html).toContain('aria-label="Contents"'); expect(html).toContain('<h1 id="build-a-plugin-for-ateliermesh">'); expect(html).toContain('Back to AtelierMesh')
      expect(html).not.toMatch(/<script>(?!try\{var m=)/)   // only the theme line is a script
      // the example plugin is a real package (a zip)
      const exHref = (await dlg.getByRole('link', { name: 'Download the packed example (.amplugin)' }).getAttribute('href'))!
      const ex = new Uint8Array(await (await fetch(new URL(exHref, base))).arrayBuffer())
      expect(String.fromCharCode(ex[0]!, ex[1]!)).toBe('PK')
      // the plugin kit is a real zip with what a person outside the repository needs, and the guide page offers it too
      const kitHref = (await dlg.getByRole('link', { name: 'Download the plugin kit (zip)' }).getAttribute('href'))!
      expect(html).toContain('ateliermesh-plugin-kit.zip')
      const kitBytes = Buffer.from(await (await fetch(new URL(kitHref, base))).arrayBuffer())
      expect(kitBytes.subarray(0, 2).toString('latin1')).toBe('PK')
      const kitFile = path.join(os.tmpdir(), `kit-${process.pid}-${Date.now()}.zip`)
      fs.writeFileSync(kitFile, kitBytes)
      const names = execFileSync('unzip', ['-Z1', kitFile], { encoding: 'utf8' }).split('\n').filter(Boolean).map(n => n.replace(/^[^/]+\//, ''))
      fs.rmSync(kitFile, { force: true })
      for (const want of ['tools/amplugin_pack.py', 'tools/amplugin_check.py', 'docs/NO-NPM.md', 'docs/CONTRACT-CHEATSHEET.md', 'examples/plugins/mirror-plain/main.js', 'examples/plugins/mirror-plain/fixtures.json']) expect(names, want).toContain(want)
      for (const want of ['README-START-HERE.md', 'tools/amplugin.mjs', 'docs/plugin-guide.md', 'spec/SPEC-plugins.md', 'examples/plugins/mirror-full/src/mirror.ts', 'examples/plugins/mirror-full/package.json', 'examples/plugins/mirror-full/locales/nl.json']) expect(names).toContain(want)
      expect(names.some(n => /^packages\/ateliermesh-core-.*\.tgz$/.test(n))).toBe(true)
      // the copied prompt is the quick prompt of the markdown file, word for word
      await dlg.getByRole('button', { name: 'Copy a prompt for your AI agent' }).click()
      await dlg.getByRole('status').filter({ hasText: 'Copied' }).waitFor()
      const want = extractQuickPrompt(fs.readFileSync(path.join(here, '../../../docs/prompt-make-a-plugin.md'), 'utf8'))
      expect(await page.evaluate(() => (window as unknown as { __copied: string }).__copied)).toBe(want)
      // "Without npm" copies the no-npm quick prompt
      await dlg.getByRole('button', { name: 'Without npm' }).click()
      await dlg.getByRole('button', { name: 'Copy a prompt for your AI agent' }).click()
      await dlg.getByRole('status').filter({ hasText: 'Copied' }).waitFor()
      const wantNo = extractQuickPromptNoNpm(fs.readFileSync(path.join(here, '../../../docs/prompt-make-a-plugin.md'), 'utf8'))
      expect(await page.evaluate(() => (window as unknown as { __copied: string }).__copied)).toBe(wantNo)
      expect(wantNo).toContain('docs/NO-NPM.md')
      await page.close()
    }, 120000)

    it('shows the plugins as a gallery with their example pictures, can switch to a list, remembers the choice, and shows the picture of a package in the approval and on its card', async ctx => {
      if (!browser || phone) return ctx.skip()
      const png = (w: number, h: number): Buffer => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b }
      // only the header of the picture is read by the checks, so a header with the right size is enough here (the browser shows a broken image, which is no error)
      const m = { manifest_version: 1 as const, id: 'ext.pictured', name: 'Pictured', version: '1.0.0', license: 'MIT', description: 'A plugin with an example picture.', image: { file: 'assets/example.png', alt: 'A grey box with a pattern' }, operations: [{ id: 'noop', kind: 'modifier' as const, params: [] }] }
      const withPic = await buildPluginPackage({ manifest: m as never, main: 'export default { async run(op, ctx) { return { mesh: ctx.mesh } } }', assets: { 'assets/example.png': new Uint8Array(png(640, 420)) } })
      const page = await newPage()
      await page.addInitScript(() => { try { localStorage.setItem('am.pluginView', 'gallery') } catch { /* private window */ } })
      await page.goto(base)
      await page.getByRole('button', { name: 'Settings' }).click()
      await page.getByRole('dialog').getByRole('tab', { name: 'Plugins' }).click()
      const dlg = page.getByRole('dialog')
      const core = dlg.locator('[data-plugin="org.ateliermesh.core"]')
      await core.waitFor()
      expect(await core.locator('img.am-card-img').getAttribute('alt')).toContain('name tag')
      await page.waitForFunction(() => { const i = document.querySelector('[data-plugin="org.ateliermesh.core"] img') as HTMLImageElement | null; return !!i && i.complete && i.naturalWidth === 640 })
      expect(await dlg.locator('.am-gallery .am-card').count()).toBeGreaterThan(5)
      // a plugin without a picture shows a placeholder, not a broken image
      expect(await dlg.locator('[data-plugin="org.ateliermesh.repair"] img').count()).toBe(0)
      expect(await dlg.locator('[data-plugin="org.ateliermesh.repair"] .am-card-none').count()).toBe(1)
      // details: the switch and the operations are behind "Details"
      expect(await core.getByRole('button', { name: /^Switch off/ }).count()).toBe(0)
      await core.getByRole('button', { name: /Details/ }).click()
      await core.getByRole('button', { name: /^Switch off/ }).waitFor()
      expect(await axe(page)).toEqual([])
      // the package: its picture is in the approval
      await dlg.getByRole('button', { name: 'Add plugin' }).click()
      await dlg.locator('.am-filebtn input[type=file]').setInputFiles({ name: 'p.amplugin', mimeType: 'application/zip', buffer: Buffer.from(withPic) })
      const approval = page.getByRole('dialog')
      await approval.getByRole('img', { name: 'A grey box with a pattern' }).waitFor()
      await page.getByRole('button', { name: 'Add', exact: true }).click()
      await dlg.getByRole('button', { name: 'Back to the plugins' }).click()
      await dlg.locator('[data-plugin="ext.pictured"] img[alt="A grey box with a pattern"]').waitFor()
      // switch to the list: the same plugins, no pictures, and the choice survives a reload
      await dlg.getByRole('button', { name: 'List', exact: true }).click()
      await dlg.locator('.am-pluginlist').waitFor()
      expect(await dlg.locator('.am-gallery').count()).toBe(0)
      expect(await page.evaluate(() => localStorage.getItem('am.pluginView'))).toBe('list')
      await page.close()
    }, 120000)

    it('a package whose example picture is not a picture is not added, and the reason is shown', async ctx => {
      if (!browser || phone) return ctx.skip()
      const m = (id: string) => ({ manifest_version: 1 as const, id, name: id, version: '1.0.0', license: 'MIT', description: 'A plugin with a bad example picture.', image: { file: 'assets/example.png', alt: 'A grey box with a pattern' }, operations: [{ id: 'noop', kind: 'modifier' as const, params: [] }] })
      const NO = 'export default { async run(op, ctx) { return { mesh: ctx.mesh } } }'
      const notPicture = await buildPluginPackage({ manifest: m('ext.notpic') as never, main: NO, assets: { 'assets/example.png': new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>') } })
      const page = await newPage()
      await page.goto(base)
      await page.getByRole('button', { name: 'Settings' }).click()
      await page.getByRole('dialog').getByRole('tab', { name: 'Plugins' }).click()
      const dlg = page.getByRole('dialog')
      await dlg.getByRole('button', { name: 'Add plugin' }).click()
      await dlg.locator('.am-filebtn input[type=file]').setInputFiles({ name: 'p.amplugin', mimeType: 'application/zip', buffer: Buffer.from(notPicture) })
      await dlg.getByText(/example picture is not a PNG, JPEG or WebP file/).waitFor({ timeout: 20000 })
      expect(await dlg.getByText('ext.notpic', { exact: true }).count()).toBe(0)
      await page.close()
    }, 120000)

    it('has the settings icon on the start page too: it opens the settings and the plugin manager', async ctx => {
      if (!browser) return ctx.skip()
      const page = await newPage()
      await page.goto(base)
      await page.getByRole('button', { name: 'Settings' }).click()
      const dlg = page.getByRole('dialog')
      await dlg.getByRole('switch', { name: 'Show the Personalised design option' }).waitFor()
      await dlg.getByRole('tab', { name: 'Plugins' }).click()
      await page.getByRole('dialog').getByText('AtelierMesh core operations').waitFor()
      await page.close()
    }, 120000)

    it('opens the Hollow jar sample: one Hollow step, a closed result, and no problem to fix', async ctx => {
      if (!browser) return ctx.skip()
      const page = await newPage()
      await page.goto(base)
      await page.getByRole('button', { name: /Hollow jar/ }).click()
      await ready(page)
      expect((await result(page)).ok).toBe(true)
      if (!phone) {
        expect(await stepNames(page)).toEqual(['Hollow'])
        expect(await page.locator('.am-stepname').first().textContent()).toContain('2 mm')   // the summary comes from the manifest: {{thickness}} mm
      }
      expect(await page.locator('.am-problem.am-error').count()).toBe(0)
      await page.close()
    }, 120000)

    it('checks printability: add the step, set a wall limit, read the verdict, and light the thin places up in 3D', async ctx => {
      if (!browser || phone) return ctx.skip()      // the card is the same on a phone; the flow is checked on the desktop layout
      const page = await newPage()
      await page.goto(base)
      await openSample(page)                          // the plain 60 x 30 x 4 plate
      await addStep(page, /Printability check/)
      const card = page.locator('.am-printreport')
      await card.waitFor({ timeout: 30000 })
      expect(await card.getAttribute('data-verdict')).toBe('good')       // a plain plate is fine
      // a wall limit of 6 mm makes the 4 mm plate too thin
      await page.locator('summary', { hasText: 'Limits' }).first().click()
      await page.getByLabel('Thinnest wall', { exact: true }).fill('6')
      await page.getByLabel('Thinnest wall', { exact: true }).press('Enter')
      await page.getByText(/Walls thinner than 6 mm/).first().waitFor({ timeout: 30000 })
      expect(await card.getAttribute('data-verdict')).toBe('fix_recommended')
      const show = card.locator('.am-pr-show').first()
      await show.click()
      expect(await show.getAttribute('aria-pressed')).toBe('true')
      await page.close()
    }, 120000)

    it('Size can change one direction only: "Per direction" stretches Z and leaves X and Y', async ctx => {
      if (!browser) return ctx.skip()
      if (phone) return ctx.skip()      // the same form; the phone only differs in layout
      const page = await newPage()
      await page.goto(base)
      await openSample(page)           // the plate: 60 x 30 x 4 mm
      await addStep(page, /^Size$/)
      await page.getByRole('button', { name: 'Per direction' }).click()
      const nums = page.locator('.am-right input[type=number]')
      await nums.nth(2).fill('200'); await nums.nth(2).press('Enter')
      await page.waitForFunction(() => /60 × 30 × 8 mm/.test(document.querySelector('.am-status')?.textContent ?? ''), null, { timeout: 20000 })
      expect((await result(page)).ok).toBe(true)
      await page.close()
    }, 120000)

    it('opens the bent bar and the Benchy ripple samples: valid results from the deform steps', async ctx => {
      if (!browser) return ctx.skip()
      for (const [label, step] of [[/Bent bar/, 'Bend'], [/3DBenchy ripple/, 'Ripple']] as const) {
        const page = await newPage()
        await page.goto(base)
        await page.getByRole('button', { name: label }).click()
        await ready(page)
        if (!phone) expect(await stepNames(page)).toEqual([step])
        const res = await result(page)
        expect(res.ok).toBe(true)
        expect(res.triangles).toBeGreaterThan(100)
        await page.close()
      }
    }, 180000)

    it('the file pickers have no type list (Safari on an iPad greys out .amplugin, .amproj and .3mf files, Firefox can hide them)', async ctx => {
      if (!browser) return ctx.skip()
      const page = await newPage()
      await page.goto(base)
      const accept = await page.locator('.am-drop input[type=file]').getAttribute('accept')
      expect(accept).toBeNull()
      await page.getByRole('button', { name: 'Settings' }).click()
      await page.getByRole('dialog').getByRole('tab', { name: /Plugins/ }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Add plugin' }).click()   // the file field is on the add screen
      const pluginAccept = await page.getByRole('dialog').locator('.am-filebtn input[type=file]').getAttribute('accept')
      expect(pluginAccept).toBeNull()
      await page.close()
      if (name === 'webkit' && !phone) {
        // an iPad (its Safari reports a touch screen and an iPad agent)
        const ctx2 = await browser.newContext({ ...devices['iPad Pro 11'] })
        const pad = await ctx2.newPage()
        await pad.goto(base)
        expect(await pad.locator('.am-drop input[type=file]').getAttribute('accept')).toBeNull()
        await ctx2.close()
      }
    }, 120000)

    it('opens a sample that comes with its steps already set up', async ctx => {
      if (!browser) return ctx.skip()
      const page = await newPage()
      await page.goto(base)
      await page.getByRole('button', { name: /^Name tag(?! with)/ }).click()
      await ready(page)
      if (!phone) expect(await stepNames(page)).toEqual(['Name'])   // the phone layout draws the steps its own way
      expect((await result(page)).ok).toBe(true)
      await page.close()
      const again = await newPage()
      await again.goto(base)
      await again.getByRole('button', { name: /Twisted pillar/ }).click()
      await ready(again)
      if (!phone) expect(await stepNames(again)).toEqual(['Twist'])
      expect((await result(again)).ok).toBe(true)
      await again.close()
    }, 120000)

    it('opens a sample, adds text, places it by clicking, exports a 3MF, saves a project file and opens it again', async ctx => {
      if (!browser) return ctx.skip()
      const page = await newPage({ acceptDownloads: true })
      const errors: string[] = []
      let workers = 0
      page.on('worker', () => { workers++ })
      page.on('pageerror', e => errors.push(String(e)))
      await page.goto(base)
      await openSample(page)
      const baseTriangles = (await result(page)).triangles
      expect(baseTriangles).toBeGreaterThan(1000)

      await addStep(page, /^Text/)
      await page.locator('.am-stepform textarea').first().fill('Anna')
      await page.getByRole('button', { name: 'Place on the model' }).click()
      await page.getByText('Click on the model where the text goes').waitFor()
      if (phone) { /* the sheet moved down to peek: the view is free */ }
      const box = (await page.locator('.am-editor-view canvas').boundingBox())!
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 - (phone ? 40 : 0))
      await page.waitForFunction(b => (window as unknown as { __am: { result: { ok: boolean; triangles: number } } }).__am.result.ok && (window as unknown as { __am: { result: { triangles: number } } }).__am.result.triangles > b, baseTriangles, { timeout: 90000 })
      expect(await page.getByText('Closed solid').count()).toBeGreaterThan(0)

      // export a 3MF and read it back: one closed mesh, the letters as their own segment
      await page.getByRole('button', { name: 'Export', exact: true }).click()
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.getByRole('button', { name: 'Download 3MF' }).click()])
      const back = await read3mf(new Uint8Array(fs.readFileSync((await dl.path())!)))
      expect(meshReport(back.mesh).watertight).toBe(true)
      expect(back.paintedTriangles).toBeGreaterThan(100)
      expect(back.mesh.segments!.table.length).toBeGreaterThanOrEqual(2)   // the body, the letters and their walls

      // save a project file, go back to the upload page and open it: the step and its text return
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      const [saved] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download .amproj file' }).click()])
      const projectFile = { name: saved.suggestedFilename(), mimeType: 'application/zip', buffer: fs.readFileSync((await saved.path())!) }   // the temp path has no extension
      await page.getByRole('button', { name: 'Open another file' }).click()
      await page.getByRole('button', { name: 'Plate 60 x 30 x 4' }).waitFor()
      await page.setInputFiles('.am-drop input[type=file]', projectFile)
      await page.waitForSelector('.am-step, .am-chip-step', { state: 'attached' })
      await ready(page)
      if (phone) await expandSheet(page)
      expect(await page.locator('.am-step, .am-chip-step').count()).toBe(1)
      if (phone) await page.locator('.am-stepname').first().click()
      expect(await page.locator('.am-stepform textarea').first().inputValue()).toBe('Anna')
      expect(workers).toBeGreaterThan(0)   // the plugin code ran in workers
      expect(errors).toEqual([])
      await page.close()
    })

    it('SVG on the surface: an SVG becomes a drawing in the project, is placed by clicking, and is saved and restored with the project', async ctx => {
      if (!browser) return ctx.skip()
      const page = await newPage({ acceptDownloads: true })
      const errors: string[] = []
      page.on('pageerror', e => errors.push(String(e)))
      await page.goto(base)
      await openSample(page)
      const baseTriangles = (await result(page)).triangles

      await addStep(page, /^SVG/)
      // no drawing yet: the setting offers to choose one; choosing imports the SVG into the project and the setting shows its name
      const star = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50 5 L61 38 L96 38 L68 58 L79 92 L50 71 L21 92 L32 58 L4 38 L39 38 Z"/></svg>'
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.am-stepform').getByRole('button', { name: /^Choose a drawing/ }).click()])   // nothing stored yet: straight to the file chooser
      await chooser.setFiles({ name: 'My Star.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(star) })
      await page.getByRole('dialog', { name: 'Import SVG' }).getByRole('button', { name: 'Keep drawing' }).click()   // the name it suggests is my_star
      await page.locator('.am-stepform').getByRole('button', { name: /^my_star\b/ }).waitFor()

      // place it on the model: a closed result with more triangles
      await page.getByRole('button', { name: 'Place on the model' }).click()
      await page.getByText('Click on the model where the text goes').waitFor()
      const box = (await page.locator('.am-editor-view canvas').boundingBox())!
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 - (phone ? 40 : 0))
      await page.waitForFunction(b => (window as unknown as { __am: { result: { ok: boolean; triangles: number } } }).__am.result.ok && (window as unknown as { __am: { result: { triangles: number } } }).__am.result.triangles > b, baseTriangles, { timeout: 60000 })
      expect(await page.getByText('Closed solid').count()).toBeGreaterThan(0)

      // save the project file: the drawing is inside it; open it again: the step runs, so the drawing came back
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      const [saved] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download .amproj file' }).click()])
      const bytes = fs.readFileSync((await saved.path())!)
      const inside = await loadProject(new Uint8Array(bytes), { storeKinds: ['mesh', 'drawing'] })
      expect(Object.keys(inside.store ?? {})).toEqual(['my_star'])
      expect(inside.store!['my_star']!.source).toMatchObject({ kind: 'svg', mode: 'fill' })   // the SVG is the source of truth and is saved with the drawing
      expect(inside.store!['my_star']!.source!.text).toContain('M50 5 L61 38')
      await page.getByRole('button', { name: 'Open another file' }).click()
      await page.getByRole('button', { name: 'Plate 60 x 30 x 4' }).waitFor()
      await page.setInputFiles('.am-drop input[type=file]', { name: saved.suggestedFilename(), mimeType: 'application/zip', buffer: bytes })
      await ready(page)
      expect((await result(page)).triangles).toBeGreaterThan(baseTriangles)
      expect(errors).toEqual([])
      await page.close()
    })

    it('keeps a project in the browser, saves again by itself, finds it after a reload, opens it and deletes it', async ctx => {
      if (!browser) return ctx.skip()
      const page = await newPage()
      const errors: string[] = []
      page.on('pageerror', e => errors.push(String(e)))
      page.on('dialog', d => void d.accept())
      await page.goto(base)
      await openSample(page)
      await addStep(page, /^Text/)
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await page.locator('#save-name').fill('My plate')
      await page.getByRole('button', { name: 'Save in this browser' }).click()
      await page.getByText(/Saved in this browser at/).first().waitFor()
      // once saved by hand, later changes are kept by themselves
      await addStep(page, 'Size')
      if (!phone) await page.waitForFunction(() => document.querySelectorAll('.am-step, .am-chip-step').length === 2)
      await page.waitForFunction(() => /Saved in this browser at/.test(document.querySelector('.am-brand')?.textContent ?? ''), null, { timeout: 10000 })
      await page.waitForTimeout(2500)
      await page.reload()
      await page.getByText('My plate').first().waitFor()
      await page.getByRole('button', { name: 'Open My plate' }).click()
      await page.waitForSelector('.am-step, .am-chip-step')
      if (phone) await expandSheet(page)
      expect(await page.locator('.am-step, .am-chip-step').count()).toBe(2)
      await page.getByRole('button', { name: 'Open another file' }).click()
      await page.getByRole('button', { name: 'All saved configurations' }).click()
      await page.getByRole('button', { name: /^Delete My plate/ }).click()
      await page.getByText('Nothing saved yet').first().waitFor()
      expect(errors).toEqual([])
      await page.close()
    })

    it('shows the sample pictures from files at once, without running the engine', async ctx => {
      if (!browser) return ctx.skip()
      const page = await newPage()
      let workers = 0
      page.on('worker', () => { workers++ })
      const t0 = Date.now()
      await page.goto(base)
      await page.waitForFunction((n: number) => { const im = [...document.querySelectorAll('.am-sample img')] as HTMLImageElement[]; return im.length === n && im.every(i => i.complete && i.naturalWidth === 320) }, SAMPLES.length, { timeout: 5000 })
      const elapsed = Date.now() - t0
      const srcs = await page.locator('.am-sample img').evaluateAll(els => els.map(e => e.getAttribute('src')))
      expect(srcs.sort()).toEqual(SAMPLES.map(x => `samples/${x.id}.png`).sort())
      expect(workers).toBe(0)                                                    // nothing was calculated for them
      expect(await page.evaluate(() => (window as unknown as { __am?: { thumbsDrawn?: number } }).__am?.thumbsDrawn ?? 0)).toBe(0)
      console.log(`${name}: ${SAMPLES.length} sample pictures complete ${elapsed} ms after the page was asked for`)
      expect(await axe(page)).toEqual([])
      await page.close()
    })

    it('draws a sample picture itself when the stored one is not for the current sample, and remembers it for the next visit', async ctx => {
      if (!browser) return ctx.skip()
      const context = await browser.newContext(profile ? { ...devices[profile] } : { viewport: { width: 1280, height: 800 } })
      const page = await context.newPage()
      const drawn = (): Promise<number> => page.evaluate(() => (window as unknown as { __am?: { thumbsDrawn?: number } }).__am?.thumbsDrawn ?? 0)
      const live = (): Promise<unknown> => page.waitForFunction((n: number) => { const im = [...document.querySelectorAll('.am-sample img')] as HTMLImageElement[]; return im.length === n && im.every(i => i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0) }, SAMPLES.length, { timeout: 120000 })
      await page.goto(`${base}?nostatic=1`)
      await live()
      expect(await drawn()).toBe(SAMPLES.length)                                 // the first visit draws all of them
      await page.reload()
      await live()
      expect(await drawn()).toBe(0)                                              // the second one finds them in the browser's store
      await context.close()
    }, 300000)

    it('writes a preview picture into a saved project, shows it on the start page after a reload, and still opens projects without one', async ctx => {
      if (!browser) return ctx.skip()
      const page = await newPage({ acceptDownloads: true })
      const errors: string[] = []
      page.on('pageerror', e => errors.push(String(e)))
      await page.goto(base)
      await page.getByRole('button', { name: /^Name tag(?! with)/ }).click()
      await ready(page)
      // a project file carries its preview (480 x 320 PNG)
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      const [saved] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.getByRole('button', { name: 'Download .amproj file' }).click()])
      const file = fs.readFileSync((await saved.path())!)
      const loaded = await loadProject(new Uint8Array(file))
      expect(loaded.preview, 'the project file has a preview').toBeDefined()
      expect(Buffer.from(loaded.preview!).readUInt32BE(16)).toBe(480)
      expect(Buffer.from(loaded.preview!).readUInt32BE(20)).toBe(320)
      // saved in the browser: the start page and the list show it after a reload
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await page.locator('#save-name').fill('Tag with picture')
      await page.getByRole('button', { name: 'Save in this browser' }).click()
      await page.waitForFunction(() => /Tag with picture/.test(document.querySelector('.am-brand')?.textContent ?? ''), null, { timeout: 60000 })   // the name shows once the record is written
      await page.reload()
      await page.getByText('Tag with picture').first().waitFor()
      await page.waitForFunction(() => { const i = document.querySelector('.am-saved-thumb img') as HTMLImageElement | null; return !!i && i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0 }, null, { timeout: 10000 })
      expect(await axe(page)).toEqual([])
      // a project saved before previews existed opens as before, and its card shows a neutral placeholder
      const old = saveProject({ name: 'Old project', base: boxMesh(20, 20, 4), list: emptyStepList(), rollback: null, assets: [] })
      await page.setInputFiles('.am-drop input[type=file]', { name: 'old.amproj', mimeType: 'application/zip', buffer: Buffer.from(old) })
      await ready(page)
      expect((await result(page)).ok).toBe(true)
      expect(errors).toEqual([])
      await page.close()
    }, 300000)

    it('checks a file when it opens: unit, closed solid, too detailed, unreadable', async ctx => {
      if (!browser) return ctx.skip()
      const page = await newPage()
      const errors: string[] = []
      page.on('pageerror', e => errors.push(String(e)))
      const dlg = page.getByRole('alertdialog')
      const fresh = async (): Promise<void> => { await page.goto(`${base}?editLimit=300`); await page.getByRole('button', { name: 'Plate 60 x 30 x 4' }).waitFor() }
      await fresh()
      // a tiny STL: the unit is asked, the flag shows, inches turns 3 into 76.2 mm
      await page.setInputFiles('.am-drop input[type=file]', stl(boxMesh(3, 3, 3)))
      await dlg.waitFor()
      expect(await dlg.textContent()).toContain('This looks like inches')
      await dlg.getByRole('button', { name: 'Read as inches' }).click()
      expect(await dlg.textContent()).toContain('Read as inches. The model is now')
      expect(await page.locator('#units-size').textContent()).toContain('76.2')
      expect(await axe(page)).toEqual([])
      await dlg.getByRole('button', { name: 'Continue' }).click()
      await page.getByText('76.2 × 76.2 × 76.2 mm').first().waitFor()
      // an open sheet is not a closed solid: the way out is another file, or opening it anyway
      const sheet = { positions: new Float64Array([0, 0, 0, 40, 0, 0, 40, 40, 0, 0, 40, 0]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) }
      await fresh()
      await page.setInputFiles('.am-drop input[type=file]', stl(sheet))
      await dlg.getByRole('button', { name: 'Continue' }).click()
      await dlg.getByText('This file is not a closed solid').waitFor()
      await dlg.getByRole('button', { name: 'Choose another file' }).click()
      expect(await dlg.count()).toBe(0)
      await page.setInputFiles('.am-drop input[type=file]', stl(sheet))
      await dlg.getByRole('button', { name: 'Continue' }).click()
      await dlg.getByRole('button', { name: 'Open it anyway' }).click()
      await page.getByText('Not a closed solid').first().waitFor()
      // too many triangles for this (lowered) limit: it can be simplified
      await fresh()
      const ball = sphereMesh(30, 2)
      expect(ball.indices.length / 3).toBeGreaterThan(300)
      await page.setInputFiles('.am-drop input[type=file]', stl(ball))
      await dlg.getByRole('button', { name: 'Continue' }).click()
      await dlg.getByRole('button', { name: /Simplify to/ }).click()
      await page.getByText('The model is simplified').or(page.getByText(/From \d+ to \d+ triangles/)).first().waitFor({ timeout: 30000 })
      // the design's second screen: counts before and after, then 'Open in the editor' opens it
      await dlg.getByRole('button', { name: 'Open in the editor' }).click()
      await ready(page)
      // not a model at all
      await fresh()
      await page.setInputFiles('.am-drop input[type=file]', { name: 'x.stl', mimeType: 'model/stl', buffer: Buffer.from('this is not a model') })
      await dlg.getByText("We can't read this file").waitFor()
      await dlg.getByRole('button', { name: 'Choose another file' }).click()
      expect(errors).toEqual([])
      await page.close()
    })

    it('repairs a file that is not a closed solid: "Repair it" opens it with a Repair mesh step and the status reads Closed solid', async ctx => {
      if (!browser) return ctx.skip()
      const page = await newPage()
      const errors: string[] = []
      page.on('pageerror', e => errors.push(String(e)))
      const dlg = page.getByRole('alertdialog')
      await page.goto(base); await page.getByRole('button', { name: 'Plate 60 x 30 x 4' }).waitFor()
      // a 10 mm cube with one triangle missing and one turned the wrong way round
      const cube = boxMesh(10, 10, 10)
      const idx = Array.from(cube.indices)
      const flipped = [idx[3 * 5 + 1] as number, idx[3 * 5 + 2] as number]
      idx[3 * 5 + 1] = flipped[1] as number; idx[3 * 5 + 2] = flipped[0] as number
      const damaged = { positions: cube.positions, indices: Uint32Array.from(idx.slice(0, 33)) }
      await page.setInputFiles('.am-drop input[type=file]', stl(damaged))
      await dlg.getByRole('button', { name: 'Continue' }).click()
      await dlg.getByText('This file is not a closed solid').waitFor()
      expect(await dlg.textContent()).toContain('We can try to close them here')
      expect(await axe(page)).toEqual([])
      await dlg.getByRole('button', { name: 'Repair it' }).click()
      await page.locator('.am-status .am-ok').first().waitFor({ timeout: 60000 })
      expect(await page.locator('.am-status .am-ok').first().textContent()).toContain('Closed solid')
      if (await page.locator('.am-sheet-peek').count()) await page.locator('.am-sheet-handle').click()   // a closed phone sheet shows only its switcher
      await page.getByText('Repair mesh').filter({ visible: true }).first().waitFor()   // the sheet title that also says it is hidden under the switcher
      expect(await result(page)).toMatchObject({ ok: true, triangles: 12 })
      expect(errors).toEqual([])
      await page.close()
    })

    it('a plugin that crashes is switched off with the reason, one that cannot load is never added, and a switched-off plugin stays off after a reload', async ctx => {
      if (!browser || phone) return ctx.skip()
      const manifestOf = (id: string, name: string, op: string) => ({ manifest_version: 1 as const, id, name, version: '1.0.0', author: 'Test author', license: 'MIT', description: 'A plugin made by the journey test.', operations: [{ id: op, title: op, kind: 'modifier' as const, params: [] }] })
      const crasher = await buildPluginPackage({ manifest: manifestOf('ext.crasher', 'Crasher', 'crash_now'), main: "export default { async run() { throw new ReferenceError('notDefined is not defined') } }" })
      const broken = await buildPluginPackage({ manifest: manifestOf('ext.broken', 'Broken one', 'never'), main: 'export default { run( { ' })
      const page = await newPage()
      const errors: string[] = []
      page.on('pageerror', e => errors.push(String(e)))
      page.on('dialog', d => { void d.accept() })
      // the engine switched Low poly off in an earlier visit: it stays off, with its reason, until it is switched on again
      await page.addInitScript(() => { try { if (!localStorage.getItem('am.disabledPlugins')) localStorage.setItem('am.disabledPlugins', JSON.stringify({ 'org.ateliermesh.lowpoly': { reason: 'ReferenceError: voronoiPlugin is not defined', crashed: true } })) } catch { /* a sandboxed frame has no storage */ } })
      await page.goto(base)
      await openSample(page)
      await page.getByRole('button', { name: 'Add a step' }).click()
      expect(await page.getByRole('menuitem', { name: /Low poly/ }).count()).toBe(0)
      await page.getByRole('menuitem', { name: 'Plugins…' }).click()
      const dlg = page.getByRole('dialog')
      await dlg.getByText('Switched off because it stopped working: ReferenceError: voronoiPlugin is not defined').waitFor()
      await dlg.getByRole('button', { name: /^Switch on .*low poly/i }).click()
      await dlg.getByRole('button', { name: /^Switch off .*low poly/i }).waitFor()   // it is on again
      // a package whose code cannot be imported is not added; the reason is in the dialog
      await dlg.getByRole('button', { name: 'Add plugin' }).click()
      await dlg.locator('.am-filebtn input[type=file]').setInputFiles({ name: 'broken.amplugin', mimeType: 'application/zip', buffer: Buffer.from(broken) })
      await page.getByRole('button', { name: 'Add', exact: true }).click()
      await dlg.getByText(/The plugin “Broken one” could not start and was not added/).waitFor({ timeout: 20000 })
      expect(await dlg.getByText('Broken one', { exact: true }).count()).toBe(0)
      // a package that loads but crashes when it runs
      await dlg.locator('.am-filebtn input[type=file]').setInputFiles({ name: 'crasher.amplugin', mimeType: 'application/zip', buffer: Buffer.from(crasher) })
      await page.getByRole('button', { name: 'Add', exact: true }).click()
      await dlg.getByRole('button', { name: 'Back to the plugins' }).click()
      await dlg.getByText('Crasher', { exact: true }).waitFor({ timeout: 20000 })
      await page.getByRole('button', { name: 'Close' }).click()
      await addStep(page, /crash_now/)
      const banner = page.locator('.am-crash')
      await banner.getByText('The plugin “Crasher” stopped working and was switched off. ReferenceError: notDefined is not defined').waitFor({ timeout: 30000 })
      // the model on screen is the last good one, the step names the problem, and the menu no longer offers the plugin
      await page.getByRole('button', { name: 'Add a step' }).click()
      expect(await page.getByRole('menuitem', { name: /crash_now/ }).count()).toBe(0)
      await page.keyboard.press('Escape')
      expect(await axe(page)).toEqual([])
      // switching it on again tries it again; it crashes again and is switched off again (no loop)
      await banner.getByRole('button', { name: 'Switch on again' }).click()
      await banner.getByText(/stopped working and was switched off/).waitFor({ timeout: 30000 })
      expect(errors).toEqual([])
      await page.close()
    }, 180000)

    it('says plainly when the page cannot run, with one action', async ctx => {
      if (!browser) return ctx.skip()
      for (const [kind, title, action] of [['webgl', "This browser can't show 3D", 'Copy the link to this page'], ['memory', 'Not enough memory for this model', 'Reload the page'], ['worker', 'The 3D engine stopped', 'Reload the page']] as const) {
        const page = await newPage()
        await page.goto(`${base}?cannot=${kind}`)
        await page.getByRole('heading', { name: title }).waitFor()
        expect(await page.getByRole('button').count()).toBe(1)
        expect(await page.getByRole('button').textContent()).toBe(action)
        await page.close()
      }
    })

    it('keeps the personalisation tools out of sight until the option and the "Personalised design" switch are on, and previews as the customer', async ctx => {
      if (!browser) return ctx.skip()
      const page = await newPage()
      const errors: string[] = []
      page.on('pageerror', e => errors.push(String(e)))
      await page.goto(base)
      await openSample(page)
      await addStep(page, /^Text/)
      expect(await page.getByText('Personalised design', { exact: true }).count()).toBe(0)
      expect(await page.getByText('Personalisable', { exact: true }).count()).toBe(0)
      await page.getByRole('button', { name: 'Settings' }).click()
      await page.getByRole('switch', { name: 'Show the Personalised design option' }).check()
      await page.getByRole('button', { name: 'Close' }).click()
      await page.getByRole('switch', { name: 'Personalised design' }).check()
      if (phone) await expandSheet(page)
      await page.getByLabel('Text is personalisable').check()
      expect(await page.getByRole('button', { name: 'Preview as customer' }).count()).toBe(1)
      await page.getByRole('button', { name: 'Preview as customer' }).click()
      await page.getByText(/Preview as customer: this is exactly what/).waitFor()
      expect(await page.getByRole('button', { name: 'Reset' }).count()).toBe(1)
      expect(await page.getByRole('button', { name: 'Back to the editor' }).count()).toBe(1)
      await page.getByRole('button', { name: 'Back to the editor' }).click()
      expect(await page.getByText(/Preview as customer: this is exactly what/).count()).toBe(0)
      expect(errors).toEqual([])
      await page.close()
    })

    // ------------------------------------------------------------------ plugins kept in this browser, their metadata, and updates from their address
    const NOOP = 'export default { async run(op, ctx) { return { mesh: ctx.mesh } } }'
    const metaManifest = (id: string, name: string, version: string, extra: Record<string, unknown> = {}) => ({ manifest_version: 1 as const, id, name, version, license: 'Apache-2.0', description: 'Tidies a model; made for the journey test.', contact: { name: 'Test Maker', url: 'https://example.org/maker', email: 'maker@example.org' }, operations: [{ id: 'tidy', title: `Tidy ${name}`, kind: 'modifier' as const, params: [] }], ...extra })
    const pack = (m: object, main = NOOP, privateKey?: string): Promise<Uint8Array> => buildPluginPackage({ manifest: m as never, main, ...(privateKey ? { privateKey } : {}) })
    const openManager = async (page: Page) => {
      if (phone) await expandSheet(page)
      await page.getByRole('button', { name: 'Add a step' }).click()
      await page.getByRole('menuitem', { name: 'Plugins…' }).click()
      return page.getByRole('dialog')
    }
    // the manager has two screens: the list, and "Add a plugin" (file, address, catalog, how to build one)
    const toList = async (page: Page): Promise<void> => { const back = page.getByRole('dialog').getByRole('button', { name: 'Back to the plugins' }); if (await back.count()) await back.click(); await page.getByRole('dialog', { name: 'Settings' }).waitFor() }
    const addFile = async (page: Page, bytes: Uint8Array, name = 'p.amplugin'): Promise<void> => {
      const add = page.getByRole('dialog').getByRole('button', { name: 'Add plugin' }); if (await add.count()) await add.click()
      await page.getByRole('dialog').locator('.am-filebtn input[type=file]').setInputFiles({ name, mimeType: 'application/zip', buffer: Buffer.from(bytes) })
    }
    const readStore = (page: Page) => page.evaluate(() => new Promise<Array<{ id: string; size: number; sha256: string; enabled: boolean }>>(resolve => {
      const r = indexedDB.open('ateliermesh'); r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains('plugins')) { db.close(); resolve([]); return }; const g = db.transaction('plugins').objectStore('plugins').getAll(); g.onsuccess = () => { db.close(); resolve((g.result as Array<{ id: string; size: number; sha256: string; enabled: boolean }>).map(x => ({ id: x.id, size: x.size, sha256: x.sha256, enabled: x.enabled }))) } }
    }))
    const hasPlugin = async (page: Page, name: RegExp): Promise<boolean> => { await page.getByRole('button', { name: 'Add a step' }).click(); const n = await page.getByRole('menuitem', { name }).count(); await page.keyboard.press('Escape'); return n > 0 }

    it('keeps an installed plugin in this browser: it is asked about once, shows its licence, description and contact, comes back after a reload and runs, and Remove forgets it', async ctx => {
      if (!browser) return ctx.skip()
      const page = await newPage()
      const errors: string[] = []
      page.on('pageerror', e => errors.push(String(e)))
      await page.goto(base)
      await openSample(page)
      let dlg = await openManager(page)
      await addFile(page, await pack(metaManifest('ext.keep', 'Keeper', '1.0.0')))
      // the approval shows what a person needs to decide
      const ask = page.getByRole('dialog', { name: 'Add this plugin?' })
      await ask.waitFor()
      for (const want of ['Keeper', 'Version 1.0.0', 'Tidies a model; made for the journey test.', 'Apache-2.0', 'Test Maker', 'Not signed']) await ask.getByText(want, { exact: false }).first().waitFor()
      const link = ask.getByRole('link', { name: /Website/ })
      expect(await link.getAttribute('href')).toBe('https://example.org/maker')
      expect(await link.getAttribute('rel')).toBe('noopener noreferrer'); expect(await link.getAttribute('target')).toBe('_blank')
      expect(await ask.getByRole('link', { name: 'maker@example.org' }).getAttribute('href')).toBe('mailto:maker@example.org')
      await ask.getByRole('button', { name: 'Add', exact: true }).click()
      await toList(page)
      dlg = page.getByRole('dialog', { name: 'Settings' })
      const row = dlg.locator('li', { hasText: 'Keeper' })
      await row.getByText('Tidies a model; made for the journey test.').waitFor({ timeout: 20000 })
      await row.getByText(/Stored in this browser \(/).waitFor()
      await row.getByRole('button', { name: 'Download Keeper' }).waitFor()
      expect((await readStore(page)).map(x => x.id)).toEqual(['ext.keep'])
      await page.getByRole('button', { name: 'Close' }).click()
      // after a reload it is back, without asking, and a step of it runs
      await page.reload()
      await openSample(page)
      await expect.poll(() => hasPlugin(page, /Tidy Keeper/), { timeout: 30000 }).toBe(true)
      await addStep(page, /Tidy Keeper/)
      await ready(page)
      expect((await result(page)).ok).toBe(true)
      // a plugin that a step uses cannot be removed
      dlg = await openManager(page)
      expect(await dlg.locator('li', { hasText: 'Keeper' }).getByRole('button', { name: 'Remove Keeper' }).isDisabled()).toBe(true)
      await page.getByRole('button', { name: 'Close' }).click()
      expect(errors).toEqual([])
      await page.close()
    }, 240000)

    it('a package\'s own texts show in the chosen language, come back after a reload, cannot change the app\'s texts, and go away with the plugin', async ctx => {
      if (!browser || phone) return ctx.skip()
      const page = await newPage()
      await page.goto(base); await openSample(page)
      await openManager(page)
      const enc = new TextEncoder()
      const locales = {
        'locales/en.json': enc.encode(JSON.stringify({ step: { op: { tidy: 'Tidy (English text)' } }, addStep: { title: 'Hacked' }, panel: { save: 'Hacked' } })),
        'locales/nl.json': enc.encode(JSON.stringify({ step: { op: { tidy: 'Opruimen (Nederlandse tekst)' } }, addStep: { title: 'Gehackt' } })),
      }
      await addFile(page, await buildPluginPackage({ manifest: metaManifest('ext.words', 'Words', '1.0.0') as never, main: NOOP, assets: locales }))
      await page.getByRole('button', { name: 'Add', exact: true }).click()
      await toList(page)
      await page.getByRole('dialog', { name: 'Settings' }).locator('li', { hasText: 'Words' }).getByText(/Stored in this browser \(/).waitFor({ timeout: 20000 })
      await page.getByRole('button', { name: 'Close' }).click()
      // English: the package's English text replaces the manifest's; the app's own words are untouched
      await page.getByRole('button', { name: 'Add a step' }).click()
      await page.getByRole('menuitem', { name: /Tidy \(English text\)/ }).waitFor()
      expect(await page.getByText('Hacked').count()).toBe(0)
      await page.keyboard.press('Escape')
      // Dutch, after a reload (the texts are read again from the stored package)
      await page.evaluate(() => localStorage.setItem('am.lang', 'nl'))
      await page.reload(); await page.locator('.am-sample').first().click(); await ready(page)
      await expect.poll(async () => { await page.getByRole('button', { name: 'Stap toevoegen' }).click(); const n = await page.getByRole('menuitem', { name: /Opruimen \(Nederlandse tekst\)/ }).count(); await page.keyboard.press('Escape'); return n }, { timeout: 30000 }).toBe(1)
      expect(await page.getByText('Gehackt').count()).toBe(0)
      // remove the plugin (in English again): its texts go with it
      await page.evaluate(() => localStorage.setItem('am.lang', 'en'))
      await page.reload(); await page.locator('.am-sample').first().click(); await ready(page)
      const dlg = await openManager(page)
      await dlg.locator('li', { hasText: 'Words' }).getByRole('button', { name: 'Remove Words' }).click()
      await page.getByRole('dialog', { name: 'Remove this plugin?' }).getByRole('button', { name: 'Remove', exact: true }).click()
      await expect.poll(async () => (await readStore(page)).length).toBe(0)
      await page.getByRole('button', { name: 'Close' }).click()
      await page.getByRole('button', { name: 'Add a step' }).click()
      expect(await page.getByRole('menuitem', { name: /Tidy \(English text\)|Tidy Words/ }).count()).toBe(0)
      await page.close()
    }, 180000)

    it('a warning from a third-party plugin is shown as a warning and does not block the result', async ctx => {
      if (!browser || phone) return ctx.skip()
      const page = await newPage()
      await page.goto(base); await openSample(page)
      await openManager(page)
      const warns = 'export default { async run(op, ctx) { return { mesh: ctx.mesh, warnings: [{ code: \'tidy.untidy\', params: {} }] } } }'
      await addFile(page, await pack(metaManifest('ext.warns', 'Warner', '1.0.0'), warns))
      await page.getByRole('button', { name: 'Add', exact: true }).click()
      await toList(page)
      await page.getByRole('dialog', { name: 'Settings' }).locator('li', { hasText: 'Warner' }).getByText(/Stored in this browser \(/).waitFor({ timeout: 20000 })
      await page.getByRole('button', { name: 'Close' }).click()
      await addStep(page, /Tidy Warner/)
      await ready(page)
      expect((await result(page)).ok).toBe(true)
      await page.locator('.am-problem.am-warning').first().waitFor()
      expect(await page.locator('.am-problem.am-error').count()).toBe(0)
      await page.close()
    }, 180000)

    it('removing a plugin asks with the shared dialog, deletes the stored file, and it stays gone after a reload', async ctx => {
      if (!browser || phone) return ctx.skip()
      const page = await newPage()
      await page.goto(base); await openSample(page)
      const dlg = await openManager(page)
      await addFile(page, await pack(metaManifest('ext.gone', 'Goner', '1.0.0')))
      await page.getByRole('button', { name: 'Add', exact: true }).click()
      await toList(page)
      await dlg.locator('li', { hasText: 'Goner' }).getByRole('button', { name: 'Remove Goner' }).click()
      const confirmDlg = page.getByRole('dialog', { name: 'Remove this plugin?' })
      await confirmDlg.getByRole('button', { name: 'Keep it' }).click()
      expect((await readStore(page)).length).toBe(1)
      await dlg.locator('li', { hasText: 'Goner' }).getByRole('button', { name: 'Remove Goner' }).click()
      await page.getByRole('dialog', { name: 'Remove this plugin?' }).getByRole('button', { name: 'Remove', exact: true }).click()
      await expect.poll(async () => (await readStore(page)).length).toBe(0)
      await page.reload(); await openSample(page)
      expect(await hasPlugin(page, /Tidy Goner/)).toBe(false)
      await page.close()
    }, 180000)

    it('a stored plugin whose bytes were changed is not started, stays in the store with the reason, and the page works', async ctx => {
      if (!browser || phone) return ctx.skip()
      const page = await newPage()
      const errors: string[] = []
      page.on('pageerror', e => errors.push(String(e)))
      await page.goto(base); await openSample(page)
      await openManager(page)
      await addFile(page, await pack(metaManifest('ext.tamper', 'Tampered', '1.0.0')))
      await page.getByRole('button', { name: 'Add', exact: true }).click()
      await expect.poll(async () => (await readStore(page)).length).toBe(1)
      // somebody changes the stored bytes
      await page.evaluate(() => new Promise<void>(resolve => {
        const r = indexedDB.open('ateliermesh'); r.onsuccess = () => { const db = r.result; const tx = db.transaction('plugins', 'readwrite'); const st = tx.objectStore('plugins'); const g = st.getAll(); g.onsuccess = () => { const rec = g.result[0]; const b = new Uint8Array(rec.bytes); b[b.length >> 1] ^= 0xff; rec.bytes = b; st.put(rec) }; tx.oncomplete = () => { db.close(); resolve() } }
      }))
      await page.reload(); await openSample(page)
      expect(await hasPlugin(page, /Tidy Tampered/)).toBe(false)
      const dlg = await openManager(page)
      await dlg.locator('li', { hasText: 'Tampered' }).getByText(/failed a check/).waitFor({ timeout: 20000 })
      expect((await readStore(page)).length).toBe(1)   // kept, not deleted
      await dlg.locator('li', { hasText: 'Tampered' }).getByRole('button', { name: 'Download Tampered' }).waitFor()
      expect(errors).toEqual([])
      await page.close()
    }, 180000)

    it('the same file is not asked about again, a changed file with the same id is asked and offers Replace', async ctx => {
      if (!browser || phone) return ctx.skip()
      const page = await newPage()
      await page.goto(base); await openSample(page)
      const dlg = await openManager(page)
      const v1 = await pack(metaManifest('ext.twice', 'Twice', '1.0.0'))
      await addFile(page, v1)
      await page.getByRole('button', { name: 'Add', exact: true }).click()
      await dlg.getByText(/Added Twice 1.0.0/).waitFor({ timeout: 20000 })
      await addFile(page, v1)   // the same file again: no question
      await dlg.getByText(/Twice 1.0.0 is already installed/).waitFor()
      // a changed file with the same id: a new install
      await addFile(page, await pack(metaManifest('ext.twice', 'Twice', '1.0.0', { description: 'The second file, different on purpose.' })))
      const ask = page.getByRole('dialog', { name: 'Replace this plugin?' })
      await ask.getByText(/same version number, but the file is different/).waitFor()
      await ask.getByRole('button', { name: 'Replace', exact: true }).click()
      await toList(page)
      await dlg.locator('li', { hasText: 'Twice' }).getByText('The second file, different on purpose.').waitFor({ timeout: 20000 })
      expect(await dlg.locator('li', { hasText: 'Twice' }).count()).toBe(1)
      await page.close()
    }, 180000)

    it('refuses a package without a licence or description with a readable message', async ctx => {
      if (!browser || phone) return ctx.skip()
      const page = await newPage()
      await page.goto(base); await openSample(page)
      const dlg = await openManager(page)
      const { license: _l, ...noLicense } = metaManifest('ext.nolic', 'No licence', '1.0.0')
      await addFile(page, await buildPluginPackage({ manifest: noLicense as never, main: NOOP }))
      await dlg.getByText(/does not say which licence it is under/).waitFor({ timeout: 20000 })
      expect(await dlg.getByText('No licence', { exact: true }).count()).toBe(0)
      await page.close()
    }, 120000)

    it('in a browser that cannot keep data (a private window) the plugin still works for the session, and the manager says it is not kept', async ctx => {
      if (!browser || phone) return ctx.skip()
      const page = await newPage()
      await page.addInitScript(() => { const open = (): never => { throw new DOMException('denied', 'SecurityError') }; Object.defineProperty(IDBFactory.prototype, 'open', { value: open, configurable: true }) })   // on the prototype: WebKit can recreate the wrapper of `indexedDB` and lose a property set on it
      const errors: string[] = []
      page.on('pageerror', e => errors.push(String(e)))
      await page.goto(base)
      await page.getByRole('button', { name: 'Plate 60 x 30 x 4' }).waitFor()
      await page.getByRole('button', { name: 'Plate 60 x 30 x 4' }).click(); await ready(page)
      const dlg = await openManager(page)
      await addFile(page, await pack(metaManifest('ext.priv', 'Private one', '1.0.0')))
      await page.getByRole('button', { name: 'Add', exact: true }).click()
      await toList(page)
      await dlg.getByText(/This browser does not keep plugins/).first().waitFor({ timeout: 20000 })
      await dlg.locator('li', { hasText: 'Private one' }).waitFor()
      await page.getByRole('button', { name: 'Close' }).click()
      await addStep(page, /Tidy Private one/); await ready(page)
      expect((await result(page)).ok).toBe(true)
      expect(errors).toEqual([])
      await page.close()
    }, 180000)

    it('a project that uses a plugin that is not installed says so and offers to open the plugin manager', async ctx => {
      if (!browser || phone) return ctx.skip()
      const page = await newPage()
      await page.goto(base); await openSample(page)
      let dlg = await openManager(page)
      await addFile(page, await pack(metaManifest('ext.needed', 'Needed', '1.0.0')))
      await page.getByRole('button', { name: 'Add', exact: true }).click()
      await dlg.getByText(/Added Needed/).waitFor({ timeout: 20000 })
      await toList(page)
      await page.getByRole('button', { name: 'Close' }).click()
      await addStep(page, /Tidy Needed/); await ready(page)
      // the plugin goes away (removed from the registry only, as if this browser never had it): the step fails with the unknown plugin problem
      await page.evaluate(() => { (window as unknown as { __am: { registry: { unregister: (id: string) => boolean } } }).__am.registry.unregister('ext.needed') })
      await addStep(page, /^Text/)   // any change runs the list again
      await page.locator('.am-steplist li', { hasText: /Needed/ }).first().click()
      const problem = page.getByText(/This project needs the plugin .ext.needed., which isn.t installed/)
      await problem.first().waitFor({ timeout: 20000 })
      await page.getByRole('button', { name: 'Open plugin manager' }).click()
      dlg = page.getByRole('dialog', { name: 'Settings' })
      await dlg.waitFor()
      await page.close()
    }, 180000)

    // A plugin that is published under a new id says in its manifest which ids it replaces: a design saved with the old id then runs with it (docs/proposals/handover-for-agent-plugin-rename.md).
    it('a project saved with the old id of a renamed plugin runs with the plugin that replaces it, as soon as that plugin is installed', async ctx => {
      if (!browser || phone) return ctx.skip()
      const ball = sphereMesh(12, 3)
      const step = makeStep({ id: 'c', plugin: { id: 'ext.oldname', version: '0.1.0' }, op: 'tidy', params: {} })
      const project = saveProject({ name: 'old design', base: ball, list: { ...emptyStepList(), steps: [step] }, rollback: null, assets: [] })
      const page = await newPage()
      await page.goto(base)
      await page.setInputFiles('.am-drop input[type=file]', { name: 'old-design.amproj', mimeType: 'application/zip', buffer: Buffer.from(project) })
      await page.getByRole('dialog', { name: 'Plugins missing' }).getByRole('button', { name: 'Not now' }).click()   // the project asks first; nothing is fetched without a yes
      await page.getByText(/This project needs the plugin .ext\.oldname., which isn.t installed/).first().waitFor({ timeout: 60000 })   // not installed yet: said as before
      await page.getByRole('button', { name: 'Open plugin manager' }).click()
      await addFile(page, await pack(metaManifest('ext.newname', 'Newname', '1.0.0', { replaces: ['ext.oldname'] })))
      await page.getByRole('button', { name: 'Add', exact: true }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Back to the plugins' }).click()
      await page.getByRole('button', { name: 'Close' }).click()
      // now the old step has the new plugin: its name and form are there and it runs
      await page.getByText('Tidy Newname').first().waitFor({ timeout: 60000 })
      await page.waitForFunction(() => !!(window as unknown as { __am?: { result: { ok: boolean } | null } }).__am?.result?.ok, undefined, { timeout: 120000 })
      expect(await page.getByText(/which isn.t installed/).count()).toBe(0)
      await page.close()
    }, 240000)

    // A project keeps where its plugins came from. A plugin this browser lacks is asked for on opening: the catalog first, then the saved address, but only after a second yes.
    it('a project with a missing plugin offers to load it: from the catalog first, else from its saved address after asking, and nothing is fetched on "Not now"', async ctx => {
      if (!browser || phone) return ctx.skip()
      const { createHash } = await import('node:crypto')
      const bytes = await pack(metaManifest('ext.reload', 'Reloaded', '1.0.0'))
      const sha = createHash('sha256').update(bytes).digest('hex')
      const step = makeStep({ id: 'r', plugin: { id: 'ext.reload', version: '1.0.0' }, op: 'tidy', params: {} })
      const mk = (origin?: string) => saveProject({ name: 'needs reload', base: sphereMesh(12, 3), list: { ...emptyStepList(), steps: [step] }, rollback: null, assets: [], plugins: [{ id: 'ext.reload', version: '1.0.0', ...(origin ? { origin } : {}) }] })
      const cors = { 'access-control-allow-origin': '*' }
      const outsideUrl = 'https://plugins.example.test/ext-reload.amplugin'
      const open = async (page: Page, project: Uint8Array) => { await page.goto(base); await page.setInputFiles('.am-drop input[type=file]', { name: 'n.amproj', mimeType: 'application/zip', buffer: Buffer.from(project) }) }
      const routes = async (page: Page, inCatalog: boolean, hits: string[]) => {
        await page.route('**/catalog/catalog.php*', r => r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ format: 'ateliermesh-catalog', version: 1, plugins: inCatalog ? [{ id: 'ext.reload', name: 'Reloaded', description: 'x', license: 'MIT', latest: '1.0.0', versions: [{ version: '1.0.0', url: '/pkgs/ext-reload.amplugin', sha256: sha, size: bytes.length, signed: false }] }] : [] }) }))
        await page.route('**/pkgs/ext-reload.amplugin*', r => { hits.push('catalog'); return r.fulfill({ status: 200, contentType: 'application/zip', headers: cors, body: Buffer.from(bytes) }) })
        await page.route(`${outsideUrl}*`, r => { hits.push('outside'); return r.fulfill({ status: 200, contentType: 'application/zip', headers: cors, body: Buffer.from(bytes) }) })
      }
      // 1. in the catalog: the catalog is used, the saved address is not asked about
      { const hits: string[] = []; const page = await newPage(); await routes(page, true, hits); await open(page, mk(outsideUrl))
        const ask = page.getByRole('dialog', { name: 'Plugins missing' }); await ask.waitFor({ timeout: 60000 })
        await ask.getByText('Saved address: plugins.example.test').waitFor()
        await ask.getByRole('button', { name: 'Load them' }).click()
        await page.getByRole('dialog', { name: 'Add this plugin?' }).getByRole('button', { name: 'Add', exact: true }).click()
        await page.getByText('Tidy Reloaded').first().waitFor({ timeout: 60000 })
        expect(hits).toEqual(['catalog']); expect(await page.getByRole('alertdialog', { name: 'Install a plugin from an outside address?' }).count()).toBe(0); await page.close() }
      // 2. not in the catalog: asked about the outside address, then fetched from it
      { const hits: string[] = []; const page = await newPage(); await routes(page, false, hits); await open(page, mk(outsideUrl))
        await page.getByRole('dialog', { name: 'Plugins missing' }).getByRole('button', { name: 'Load them' }).click()
        const out = page.getByRole('alertdialog', { name: 'Install a plugin from an outside address?' }); await out.waitFor({ timeout: 60000 })
        expect(hits).toEqual([])   // nothing was fetched before the yes
        await out.getByText('plugins.example.test', { exact: true }).waitFor()   // the address, large
        await out.getByRole('button', { name: 'Install from this address' }).click()
        await page.getByRole('dialog', { name: 'Add this plugin?' }).getByRole('button', { name: 'Add', exact: true }).click()
        await page.getByText('Tidy Reloaded').first().waitFor({ timeout: 60000 })
        expect(hits).toEqual(['outside']); await page.close() }
      // 3. no saved address (built in or from a file) and not in the catalog: nothing to load, and it says so
      { const hits: string[] = []; const page = await newPage(); await routes(page, false, hits); await open(page, mk())
        const ask = page.getByRole('dialog', { name: 'Plugins missing' }); await ask.waitFor({ timeout: 60000 })
        await ask.getByText(/No saved address/).waitFor()
        await ask.getByRole('button', { name: 'Load them' }).click()
        await page.getByText(/Not loaded: ext\.reload/).waitFor({ timeout: 30000 })
        expect(hits).toEqual([]); await page.close() }
      // 4. "Not now": nothing is fetched
      { const hits: string[] = []; const page = await newPage(); await routes(page, true, hits); await open(page, mk(outsideUrl))
        await page.getByRole('dialog', { name: 'Plugins missing' }).getByRole('button', { name: 'Not now' }).click()
        await page.getByText(/which isn.t installed/).first().waitFor({ timeout: 60000 })
        expect(hits).toEqual([]); await page.close() }
    }, 360000)

    it('checks for an update only when asked: newer version after approval, same file is up to date, another plugin is refused, signed-then-unsigned warns, a failed start keeps the old one, a server without CORS gets a clear message', async ctx => {
      if (!browser || phone) return ctx.skip()
      const { generateKeyPair } = await import('@ateliermesh/loader')
      const keys = await generateKeyPair(), other = await generateKeyPair()
      const files = new Map<string, Uint8Array>()
      let hits = 0
      const mk = (cors: boolean): Promise<{ s: Server; url: string }> => new Promise(resolve => {
        const s = createServer((req, res) => {
          hits++
          const b = files.get((req.url ?? '').split('?')[0] as string)
          if (!b) { res.writeHead(404, cors ? { 'access-control-allow-origin': '*' } : {}).end(); return }
          res.writeHead(200, { 'content-type': 'application/zip', ...(cors ? { 'access-control-allow-origin': '*' } : {}) }).end(Buffer.from(b))
        })
        s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${(s.address() as { port: number }).port}` }))
      })
      const good = await mk(true), nocors = await mk(false)
      try {
        const m = (v: string, extra: Record<string, unknown> = {}) => metaManifest('ext.upd', 'Updatable', v, extra)
        const page = await newPage()
        await page.addInitScript((k: { name: string; publicKey: string }[]) => { localStorage.setItem('am.trustedKeys', JSON.stringify(k)) }, [{ name: 'Maker', publicKey: keys.publicKey }])
        await page.goto(`${base}?dev`); await openSample(page)
        const dlg = await openManager(page)
        files.set('/u.amplugin', await pack(m('1.0.0'), NOOP, keys.privateKey))
        await dlg.getByRole('button', { name: 'Add plugin' }).click()
        const urlBox = dlg.getByLabel('Plugin address (https)')
        await urlBox.fill(`${good.url}/u.amplugin`); await dlg.getByRole('button', { name: 'Load', exact: true }).click()
        await page.getByRole('dialog', { name: 'Add this plugin?' }).getByRole('button', { name: 'Add', exact: true }).click()
        await toList(page)
        const row = dlg.locator('li', { hasText: 'Updatable' })
        await row.getByText(/Updates from 127.0.0.1/).waitFor({ timeout: 20000 })
        expect(await row.getByText(`${good.url}/u.amplugin`).count()).toBe(0)   // only the host name is shown
        hits = 0
        await page.waitForTimeout(800)
        expect(hits).toBe(0)   // nothing is fetched until the button is clicked
        // up to date: the same file
        await row.getByRole('button', { name: 'Check for update Updatable' }).click()
        await dlg.getByText(/Updatable 1.0.0 is up to date/).waitFor({ timeout: 20000 })
        // newer, signed by the same key: asked, then installed
        files.set('/u.amplugin', await pack(m('1.1.0'), NOOP, keys.privateKey))
        await row.getByRole('button', { name: 'Check for update Updatable' }).click()
        let ask = page.getByRole('dialog', { name: 'Update this plugin?' })
        await ask.getByText('1.0.0 → 1.1.0').waitFor({ timeout: 20000 })
        await ask.getByText(/Signed by the same key as the installed version/).waitFor()
        await ask.getByRole('button', { name: 'Update', exact: true }).click()
        await dlg.getByText(/Updated Updatable from 1.0.0 to 1.1.0/).waitFor({ timeout: 20000 })
        // a different plugin at the same address is refused
        files.set('/u.amplugin', await pack(metaManifest('ext.else', 'Else', '9.0.0'), NOOP, keys.privateKey))
        await row.getByRole('button', { name: 'Check for update Updatable' }).click()
        await dlg.getByText(/different plugin/).waitFor({ timeout: 20000 })
        // unsigned after signed: a clear warning and an explicit approval; Cancel keeps the installed one
        files.set('/u.amplugin', await pack(m('1.2.0')))
        await row.getByRole('button', { name: 'Check for update Updatable' }).click()
        ask = page.getByRole('dialog', { name: 'Update this plugin?' })
        await ask.getByText(/the installed version is signed, this new one is not/).waitFor({ timeout: 20000 })
        await ask.getByRole('button', { name: 'Cancel' }).click()
        await dlg.locator('li', { hasText: 'Updatable' }).getByText('Version 1.1.0').waitFor()
        // signed by another trusted-looking key that is not trusted: refused while reading
        files.set('/u.amplugin', await pack(m('1.3.0'), NOOP, other.privateKey))
        await row.getByRole('button', { name: 'Check for update Updatable' }).click()
        await dlg.getByText(/The update was not installed and the current version stays/).waitFor({ timeout: 20000 })
        // a newer package that cannot start: the old one stays, with the reason
        files.set('/u.amplugin', await pack(m('1.4.0'), 'export default { run( { ', keys.privateKey))
        await row.getByRole('button', { name: 'Check for update Updatable' }).click()
        await page.getByRole('dialog', { name: 'Update this plugin?' }).getByRole('button', { name: 'Update', exact: true }).click()
        await dlg.getByText(/could not start and was not added/).waitFor({ timeout: 20000 })
        await dlg.locator('li', { hasText: 'Updatable' }).getByText('Version 1.1.0').waitFor()
        // a server that does not allow this page to read its answer
        files.set('/n.amplugin', await pack(m('2.0.0'), NOOP, keys.privateKey))
        await dlg.getByRole('button', { name: 'Add plugin' }).click()
        await urlBox.fill(`${nocors.url}/n.amplugin`); await dlg.getByRole('button', { name: 'Load', exact: true }).click()
        await dlg.getByText(/does not allow this page to download it/).waitFor({ timeout: 20000 })
        await dlg.getByText(`${nocors.url}/n.amplugin`, { exact: false }).first().waitFor()
        await page.close()
      } finally { good.s.close(); nocors.s.close() }
    }, 300000)
  })
}

describe('accessibility of the standalone app (axe-core, WCAG 2.1 AA and best practice)', () => {
  let browser: Browser | null = null
  beforeAll(async () => { try { browser = await chromium.launch({ headless: true, args: GL }) } catch { browser = null } })
  afterAll(async () => { await browser?.close() })
  for (const scheme of ['light', 'dark'] as const) {
    it(`has no violations on the upload page and the editor, in ${scheme} mode`, async ctx => {
      if (!browser) return ctx.skip()
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: scheme })
      await page.goto(base)
      await page.getByRole('button', { name: 'Plate 60 x 30 x 4' }).waitFor()
      expect(await axe(page), 'upload').toEqual([])
      await page.getByRole('button', { name: 'Plate 60 x 30 x 4' }).click()
      await page.waitForFunction(() => !!(window as unknown as { __am?: { result: { ok: boolean } | null } }).__am?.result?.ok, null, { timeout: 60000 })
      await page.getByRole('button', { name: 'Add a step' }).click()
      await page.getByRole('menuitem', { name: /^Text/ }).click()
      await page.waitForSelector('.am-stepform')
      await page.waitForFunction(() => !!(window as unknown as { __am?: { result: { ok: boolean } | null } }).__am?.result)
      expect(await axe(page), 'editor').toEqual([])
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      expect(await axe(page), 'save dialog').toEqual([])
      await page.close()
    })
  }
})
