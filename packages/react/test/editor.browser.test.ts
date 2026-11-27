import { build } from 'esbuild'
import { chromium, devices, firefox, webkit } from 'playwright-core'
import type { Browser, Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { addStep, emptyStepList, makeRecipe, makeStep, serializeRecipe } from '@ateliermesh/core'
import { CORE_PLUGIN_ID, CORE_PLUGIN_VERSION } from '@ateliermesh/plugins'

const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const here = path.dirname(fileURLToPath(import.meta.url))
const css = ['theme.css', 'overlay.css', 'editor.css'].map(f => fs.readFileSync(path.join(here, '../src', f), 'utf8')).join('\n')
const FONT = fileURLToPath(new URL('../../../assets/atelier/frontend/public/fonts/roboto-v51-latin-regular.woff2', import.meta.url))
let script = ''
beforeAll(async () => {
  const r = await build({ entryPoints: [path.join(here, 'fixtures/editor-harness.tsx')], bundle: true, format: 'iife', write: false, logLevel: 'silent', platform: 'browser', jsx: 'automatic', loader: { '.json': 'json' }, define: { 'process.env.NODE_ENV': '"development"' } })
  script = r.outputFiles[0]!.text
})

interface S { saves: Array<{ where: string; name: string; ops: string[] }>; steps: string[]; left: number; saved: number; reasons: string[]; plugin: string[]; showPers: boolean; pers: boolean; personalisable: string[][] }
const d = fs.existsSync(FONT) ? describe : describe.skip
const state = (page: Page): Promise<S> => page.evaluate(() => (window as unknown as { __e: { state(): S } }).__e.state())
const opened: Array<{ close(): Promise<void> }> = []
async function open(browser: Browser, opts: { phone?: boolean; mode?: string; dirty?: boolean; delay?: number; motion?: boolean; dark?: boolean; build?: { guideUrl?: string; promptText?: string; exampleUrl?: string; kitUrl?: string }; embed?: Record<string, unknown>; width?: number } = {}): Promise<Page> {
  const motion = { reducedMotion: opts.motion ? 'no-preference' as const : 'reduce' as const, colorScheme: opts.dark ? 'dark' as const : 'light' as const }
  const ctx = await browser.newContext(opts.phone ? { ...devices['iPhone 13'], ...motion } : { viewport: { width: opts.width ?? 1200, height: 800 }, ...motion })
  opened.push(ctx)   // closed after the test: WebKit crashed ('page crashed') when twenty pages stayed open in one browser
  const page = await ctx.newPage()
  page.on('pageerror', e => { throw e })
  await page.setContent('<!doctype html><html lang="en"><head><title>Editor</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="root"></div></body></html>')
  await page.evaluate(([b64, mode, dirty, delay, build, embed]) => { const w = window as unknown as { __font: string; __opts: Record<string, unknown> }; w.__font = b64 as string; w.__opts = { mode, dirty, delay, build, ...(embed as object) } }, [fs.readFileSync(FONT).toString('base64'), opts.mode ?? 'standalone', !!opts.dirty, opts.delay ?? 0, opts.build ?? null, opts.embed ?? {}])
  await page.addStyleTag({ content: css })
  await page.addScriptTag({ content: script })
  await page.evaluate(() => (window as unknown as { __e: { start(): void } }).__e.start())
  await page.locator('.am-addmenu').first().waitFor({ state: 'attached' })   // a closed phone sheet with the switcher hides its body, so wait for the menu to be there, not visible
  return page
}
async function axe(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: axePath })
  return page.evaluate(async () => (await (window as unknown as { axe: { run: (c: Document, o: object) => Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ target: string[] }> }> }> } }).axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] })).violations.map(v => `${v.id}: ${v.help} -> ${v.nodes.map(n => n.target.join(' ')).join(', ')}`))
}

for (const [name, type] of [['chromium', chromium], ['webkit', webkit]] as const) {
  d(`editor page in ${name}`, () => {
    let browser: Browser | null = null
    beforeAll(async () => {
      try { browser = await type.launch({ headless: true, ...(name === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } : {}) }) }
      catch (e) { console.warn(`${name} is not available here: ${String(e).split('\n')[0]}`) }
    })
    afterAll(async () => { await browser?.close() })
    afterEach(async () => { await Promise.all(opened.splice(0).map(c => c.close().catch(() => undefined))) })

    it('adds, orders and removes steps, shows tips and part warnings, and runs the engine', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser)
      await page.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
      expect(await axe(page)).toEqual([])
      // Add a step: the menu lists the operations; Size is added after the text
      await page.getByRole('button', { name: 'Add a step' }).click()
      expect(await page.getByRole('menuitem').count()).toBeGreaterThan(4)
      // the plugins say where an operation belongs: checks are kept apart from shape and from the surface operations
      const groups = (await page.locator('.am-menu-group').allTextContents()).map(g => g.trim())
      expect(groups).toEqual(['Prepare', 'Shape', 'Art style', 'On the surface'])   // with more than twelve operations the checks are folded into "More"; the recipe and plugin rows sit at the bottom
      // the menu fits the window and scrolls: the last entry can be reached
      const box = await page.locator('.am-menu').boundingBox(), vh = page.viewportSize()!.height
      expect(box!.y + box!.height).toBeLessThanOrEqual(vh)
      expect(box!.x).toBeGreaterThanOrEqual(0)                                  // not out of the window on the left (the column is narrow and at the left edge)
      expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
      await page.getByRole('menuitem', { name: 'Plugins…' }).scrollIntoViewIfNeeded()
      const items = (await page.getByRole('menuitem').allTextContents()).map(x => x.trim())
      expect(items.slice(-3)).toEqual(['Apply a recipe…', 'Save as a recipe…', 'Plugins…'])
      await page.getByRole('menuitem', { name: /^More/ }).click()   // the low-importance operations: the checks
      expect((await page.locator('.am-menu-group', { hasText: 'Checks' }).locator('xpath=following-sibling::button').allTextContents()).slice(0, 2).map(x => x.trim())).toEqual(['Overhang check', 'Auto-orient'])
      await page.getByRole('menuitem', { name: 'Size', exact: true }).click()
      expect((await state(page)).steps).toEqual(['s1:emboss', 's2:resize'])
      // a Size step after a text step scales the letters: a tip with one button that moves it above
      await page.getByText('scales their letters too').waitFor()
      await page.getByRole('button', { name: 'Keep letter heights exact' }).first().click()
      expect((await state(page)).steps).toEqual(['s2:resize', 's1:emboss'])
      // the move buttons work (keyboard and phone), and say what happened
      await page.locator('.am-stepname').nth(0).click()
      await page.getByRole('button', { name: 'Step options' }).click()
      await page.getByRole('menuitem', { name: 'Move down' }).click()
      expect((await state(page)).steps).toEqual(['s1:emboss', 's2:resize'])
      expect(await page.getByRole('status').filter({ hasText: 'is now step 2' }).count()).toBe(1)
      // a step that names a part nobody makes
      await page.evaluate(() => (window as unknown as { __e: { addPartsStep(o: string): void } }).__e.addPartsStep('letters'))
      await page.locator('.am-stepname').nth(2).click()
      await page.getByText('No file or earlier step makes the part “letters”.').waitFor()
      // delete it again
      await page.getByRole('button', { name: 'Step options' }).click()
      await page.getByRole('menuitem', { name: 'Delete' }).click()
      expect((await state(page)).steps).toEqual(['s1:emboss', 's2:resize'])
      // "Up to this step" shows the model after step 1 and says so
      await page.locator('.am-stepname').nth(0).click()
      await page.getByRole('button', { name: 'Up to this step', exact: true }).click()
      await page.getByText('Showing the model after step 1 of 2').first().waitFor()
      // choosing another step moves the view with it
      await page.locator('.am-stepname').nth(1).click()
      await page.getByText('Showing the model after step 2 of 2').first().waitFor()
      await page.locator('.am-stepname').nth(0).click()
      await page.getByText('Showing the model after step 1 of 2').first().waitFor()
      await page.getByRole('button', { name: 'Final result' }).click()
      // switch a step off
      await page.locator('.am-stepname').nth(1).click()
      await page.getByRole('button', { name: 'Step options' }).click()
      await page.getByRole('menuitem', { name: 'Switch off' }).click()
      expect(await page.locator('.am-step').nth(1).locator('.am-dot .am-sr').textContent()).toBe('Switched off')
    }, 120000)

    it('names a new step after its type, with a number when the name is taken', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser)
      await page.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
      for (const label of ['Text', 'Size', 'Size']) { await page.getByRole('button', { name: 'Add a step' }).click(); await page.getByRole('menuitem', { name: label, exact: true }).click() }
      const names = await page.locator('.am-stepname .am-t1').allTextContents()
      expect(names.map(n => n.trim())).toEqual(['Text', 'Text 2', 'Size', 'Size 2'])
      // the pencil next to the title renames the step; an empty name goes back to the type's title
      await page.getByRole('button', { name: 'Rename this step' }).click()
      expect(await page.getByLabel('Name', { exact: true }).inputValue()).toBe('Size 2')
      await page.getByLabel('Name', { exact: true }).fill('Name on the lid')
      await page.keyboard.press('Enter')
      expect((await page.locator('.am-stepname .am-t1').allTextContents()).map(n => n.trim())).toEqual(['Text', 'Text 2', 'Size', 'Name on the lid'])
      await page.getByRole('button', { name: 'Rename this step' }).click()
      await page.getByLabel('Name', { exact: true }).fill('')
      await page.keyboard.press('Enter')
      expect((await page.locator('.am-stepname .am-t1').allTextContents()).map(n => n.trim())[3]).toBe('Size')
      await page.getByRole('button', { name: 'Rename this step' }).click()
      await page.getByLabel('Name', { exact: true }).fill('Dropped')
      await page.keyboard.press('Escape')
      expect((await page.locator('.am-stepname .am-t1').allTextContents()).map(n => n.trim())[3]).toBe('Size')
    }, 120000)

    it('has a Ruler button, on by default, that draws a ruler in mm along X and Y on the plate, and takes it away again', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser)
      await page.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
      await page.waitForFunction(() => !!(window as unknown as { __viewer?: unknown }).__viewer, null, { timeout: 30000 })
      const sprites = (): Promise<number> => page.evaluate(() => { let n = 0; (window as unknown as { __viewer: { scene: { traverse(f: (o: { isSprite?: boolean }) => void): void } } }).__viewer.scene.traverse(o => { if (o.isSprite) n++ }); return n })
      const btn = page.getByRole('button', { name: 'Ruler' })
      expect(await btn.getAttribute('aria-pressed')).toBe('true')
      expect(await sprites()).toBeGreaterThan(4)          // on by default: numbers and a name for each direction
      await btn.click()
      expect(await btn.getAttribute('aria-pressed')).toBe('false')
      expect(await sprites()).toBe(0)
      await btn.click()
      expect(await btn.getAttribute('aria-pressed')).toBe('true')
      expect(await sprites()).toBeGreaterThan(4)
      await page.close()
    }, 120000)

    it('shows a crosshair while placing and a marker where the text sits', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser)
      await page.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
      const objects = (): Promise<number> => page.evaluate(() => (window as unknown as { __viewer: { scene: { children: unknown[] } } }).__viewer.scene.children.length)
      await page.waitForFunction(() => !!(window as unknown as { __viewer?: unknown }).__viewer, null, { timeout: 30000 })
      // a step without a place (Size) has no grip; selecting the text step, which has a place, adds one to the scene
      await page.getByRole('button', { name: 'Add a step' }).click(); await page.getByRole('menuitem', { name: 'Size', exact: true }).click()
      await page.waitForTimeout(500)
      const without = await objects()
      await page.locator('.am-stepname').nth(0).click()
      await page.waitForFunction(n => (window as unknown as { __viewer: { scene: { children: unknown[] } } }).__viewer.scene.children.length > n, without, { timeout: 15000 })
      // asking to place changes the pointer to a crosshair, and it goes back afterwards
      const cursor = (): Promise<string> => page.evaluate(() => (window as unknown as { __viewer: { renderer: { domElement: HTMLElement } } }).__viewer.renderer.domElement.style.cursor)
      expect(await cursor()).toBe('')
      await page.getByRole('button', { name: 'Place on the model' }).click()
      expect(await cursor()).toBe('crosshair')
      await page.getByRole('button', { name: 'Cancel' }).click()
      expect(await cursor()).toBe('')
    }, 120000)

    it('cuts a hole where the user clicks on the model: a closed solid with less volume', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser)
      await page.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
      await page.waitForFunction(() => !!(window as unknown as { __viewer?: unknown }).__viewer, null, { timeout: 30000 })
      // the signed volume of the biggest mesh in the scene (the model), in mm3
      const volume = (): Promise<number> => page.evaluate(() => {
        const sc = (window as unknown as { __viewer: { scene: { traverse(f: (o: { geometry?: { attributes: { position?: { array: ArrayLike<number> } }; index?: { array: ArrayLike<number> } | null } }) => void): void } } }).__viewer.scene
        let best = 0
        sc.traverse(o => {
          const pos = o.geometry?.attributes.position?.array; if (!pos) return
          const idx = o.geometry?.index?.array
          const n = idx ? idx.length : pos.length / 3
          let v = 0
          for (let t = 0; t < n; t += 3) {
            const at = (k: number): number[] => { const i = idx ? (idx[t + k] as number) : t + k; return [pos[3 * i] as number, pos[3 * i + 1] as number, pos[3 * i + 2] as number] }
            const A = at(0), B = at(1), C = at(2)
            v += (A[0]! * (B[1]! * C[2]! - B[2]! * C[1]!) - A[1]! * (B[0]! * C[2]! - B[2]! * C[0]!) + A[2]! * (B[0]! * C[1]! - B[1]! * C[0]!)) / 6
          }
          if (Math.abs(v) > Math.abs(best)) best = v
        })
        return Math.abs(best)
      })
      const before = await volume()
      expect(before).toBeGreaterThan(1000)
      await page.getByRole('button', { name: 'Add a step' }).click(); await page.getByRole('menuitem', { name: 'Cut hole', exact: true }).click()
      await page.getByRole('button', { name: 'Place on the model' }).click()
      const box = await page.locator('.am-editor-view canvas').first().boundingBox()
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
      await page.waitForFunction(() => document.querySelector('.am-stepname')?.parentElement?.parentElement?.textContent?.includes('mm'), null, { timeout: 30000 }).catch(() => undefined)
      await page.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
      const s = await state(page)
      expect(s.steps.at(-1)).toMatch(/:cut_hole$/)
      await page.waitForFunction(() => document.querySelectorAll('.am-problem, .am-error').length === 0, null, { timeout: 30000 })
      let after = before
      for (let i = 0; i < 40 && after >= before - 1; i++) { await page.waitForTimeout(500); after = await volume() }
      expect(after).toBeLessThan(before - 1)
    }, 180000)

    it('writes the axis in front of each box of a vector field (Rotate: X, Y, Z)', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser)
      await page.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
      await page.getByRole('button', { name: 'Add a step' }).click(); await page.getByRole('menuitem', { name: 'Rotate', exact: true }).click()
      await page.locator('.am-axis-name').first().waitFor()
      expect((await page.locator('.am-axis-name').allTextContents()).slice(0, 3)).toEqual(['X', 'Y', 'Z'])
      expect(await page.locator('.am-axis .am-unit').first().textContent()).toBe('\u00b0')
      expect(await axe(page)).toEqual([])
    }, 120000)

    it('draws every operation in the designed form: Rotate with axes, Size with segmented buttons, and a plugin that only gives hints', async ctx => {
      if (!browser) return ctx.skip()
      for (const dark of [false, true]) {
        const page = await open(browser, { dark })
        await page.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
        const add = async (label: string): Promise<void> => { await page.getByRole('button', { name: 'Add a step' }).click(); await page.getByRole('menuitem', { name: label, exact: true }).click() }
        // Rotate: the designed form (not the generated panel), X Y Z boxes, the six-way order as a list inside the collapsed "More" group
        await add('Rotate')
        await page.locator('.am-stepform').waitFor()
        expect(await page.locator('.am-panel').count()).toBe(0)
        expect((await page.locator('.am-axis-name').allTextContents()).slice(0, 3)).toEqual(['X', 'Y', 'Z'])
        const more = page.locator('details.am-group', { has: page.locator('summary', { hasText: 'More' }) })
        expect(await more.evaluate(e => (e as HTMLDetailsElement).open)).toBe(false)
        expect(await more.locator('select').count()).toBe(1)
        // Size: two buttons for the mode, one pressed; the other shows the other fields
        await add('Size')
        await page.getByRole('button', { name: 'Percent', exact: true }).waitFor()
        expect(await page.getByRole('button', { name: 'Percent', exact: true }).getAttribute('aria-pressed')).toBe('true')
        await page.getByRole('button', { name: 'Target size', exact: true }).click()
        expect(await page.getByRole('button', { name: 'Target size', exact: true }).getAttribute('aria-pressed')).toBe('true')
        // the plugin with hints only: a slider with its number box, buttons with an icon, cards, "advanced" in the collapsed group, the summary under the name
        await add('Tune')
        await page.locator('input[type="range"]').first().waitFor()
        expect(await page.locator('input[type="range"]').count()).toBeGreaterThanOrEqual(1)
        expect(await page.getByRole('button', { name: 'Soft', exact: true }).getAttribute('aria-pressed')).toBe('true')
        await page.getByRole('button', { name: 'Hard', exact: true }).click()
        expect(await page.getByRole('button', { name: 'Hard', exact: true }).getAttribute('aria-pressed')).toBe('true')
        expect(await page.getByRole('button', { name: 'Hard', exact: true }).locator('svg').count()).toBe(1)
        expect(await page.locator('.am-cards button').count()).toBe(3)
        expect(await page.getByText('How hard it works.').count()).toBe(1)
        const adv = page.locator('details.am-group', { has: page.locator('summary', { hasText: 'More' }) }).last()
        expect(await adv.evaluate(e => (e as HTMLDetailsElement).open)).toBe(false)
        expect(await adv.getByText('Tweak').count()).toBeGreaterThan(0)
        expect(await page.locator('.am-stepname .am-t2', { hasText: '5 x' }).count()).toBe(1)
        await adv.locator('summary').click()
        await page.getByRole('button', { name: /Increase Tweak/ }).click()
        expect(await page.locator('#' + (await page.locator('input[type="number"]').last().getAttribute('id'))).inputValue()).toBe('4')
        expect(await axe(page)).toEqual([])
        await page.context().close()
      }
    }, 240000)

    const recipeText = (name: string, ops: Array<[string, string, string?, Record<string, unknown>?]>): string => serializeRecipe(makeRecipe({
      name, created: '2026-11-09T00:00:00.000Z',
      list: ops.reduce((l, [id, op, plugin, params]) => addStep(l, makeStep({ id, plugin: { id: plugin ?? CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op, params: params ?? {} })), emptyStepList()),
    }))
    const addRecipe = (page: Page, text: string): Promise<void> => page.evaluate(t => (window as unknown as { __e: { addRecipe(t: string): void } }).__e.addRecipe(t), text)
    const menu = async (page: Page, item: string): Promise<void> => { await page.getByRole('button', { name: 'Add a step' }).first().click(); await page.getByRole('menuitem', { name: item }).click() }

    it('saves all the current steps as a recipe: a name, then in this browser or as a file', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser)
      await page.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
      for (const op of ['Size', 'Rotate']) await menu(page, op)
      await menu(page, 'Save as a recipe…')
      const dlg = page.getByRole('dialog')
      await dlg.getByText('Save the steps as a recipe').waitFor()
      expect(await dlg.getByText('3 steps you have now').count()).toBe(1)
      await dlg.getByLabel('Name', { exact: true }).fill('Mine')
      expect(await axe(page)).toEqual([])
      await dlg.getByRole('button', { name: 'Save in this browser' }).click()
      await dlg.waitFor({ state: 'detached' })
      await menu(page, 'Save as a recipe…')
      await page.getByRole('dialog').getByRole('button', { name: 'Download file' }).click()
      expect((await state(page)).saves).toEqual([{ where: 'browser', name: 'Mine', ops: ['emboss', 'resize', 'rotate'] }, { where: 'file', name: 'plate', ops: ['emboss', 'resize', 'rotate'] }])   // all the steps, in the order they have
    }, 120000)

    it('adds the steps of a saved recipe after mine, in the recipe order, as one change', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser)
      await page.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
      await addRecipe(page, recipeText('Two steps', [['r1', 'rotate'], ['r2', 'resize'], ['r3', 'rotate']]))
      await menu(page, 'Apply a recipe…')
      const dlg = page.getByRole('dialog')
      await dlg.getByText('3 steps').waitFor()
      expect(await axe(page)).toEqual([])
      await dlg.getByRole('button', { name: 'Use Two steps' }).click()
      await dlg.waitFor({ state: 'detached' })
      const st = await state(page)
      expect(st.steps).toEqual(['s1:emboss', 's2:rotate', 's3:resize', 's4:rotate'])      // my text step first, then the recipe's steps in its order
      expect(st.reasons.filter(r => r === 'recipe').length).toBe(1)                         // one change: one undo step for the host
    }, 120000)

    it('selects an unplaced text step of the recipe and starts the click-to-place mode', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser)
      await page.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
      await addRecipe(page, recipeText('Name', [['r1', 'emboss', undefined, { text: 'Anna', font: 'roboto', size: 8, height: 0.6, mode: 'raised', placement: null }]]))
      await menu(page, 'Apply a recipe…')
      await page.getByRole('dialog').getByRole('button', { name: 'Use Name' }).click()
      await page.getByText('Click on the model where the text goes').waitFor()
      expect((await state(page)).steps).toEqual(['s1:emboss', 's2:emboss'])
      expect(await page.locator('.am-stepname[aria-current="true"]').count()).toBe(1)
    }, 120000)

    it('warns about a plugin that is not installed and adds only the steps that can run', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser, { dark: true })
      await page.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
      await addRecipe(page, recipeText('Needs more', [['r1', 'resize'], ['r2', 'sparkle', 'org.example.gone']]))
      await menu(page, 'Apply a recipe…')
      const dlg = page.getByRole('dialog')
      await dlg.getByRole('button', { name: 'Use Needs more' }).click()
      await dlg.getByText('not installed here: org.example.gone').waitFor()
      expect(await axe(page)).toEqual([])                                                  // in the dark theme too
      await dlg.getByRole('button', { name: 'Add the other steps' }).click()
      await dlg.waitFor({ state: 'detached' })
      expect((await state(page)).steps).toEqual(['s1:emboss', 's2:resize'])
    }, 120000)

    it('has a "Build your own plugin" panel in the plugin manager: the three buttons, back, Escape, and a prompt that can be copied or selected', async ctx => {
      if (!browser) return ctx.skip()
      const build = { guideUrl: '/docs/plugin-guide.html', promptText: 'Build an AtelierMesh plugin: {{name}}', exampleUrl: '/docs/mirror-example.amplugin', kitUrl: '/docs/ateliermesh-plugin-kit.zip' }
      // without the `build` prop there is no entry at all
      const none = await open(browser)
      await none.getByRole('button', { name: 'Add a step' }).click(); await none.getByRole('menuitem', { name: 'Plugins…' }).click()
      await none.getByRole('button', { name: 'Add plugin' }).click()   // the entry would be in the add screen
      await none.getByRole('dialog', { name: 'Add a plugin' }).waitFor()
      expect(await none.getByRole('button', { name: 'Build your own plugin' }).count()).toBe(0)
      const page = await open(browser, { build })
      await page.getByRole('button', { name: 'Add a step' }).click(); await page.getByRole('menuitem', { name: 'Plugins…' }).click()
      await page.getByRole('button', { name: 'Add plugin' }).click()
      const entry = page.getByRole('button', { name: 'Build your own plugin' })
      await entry.click()
      const dlg = page.getByRole('dialog', { name: 'Build your own plugin' })
      await dlg.waitFor()
      for (const h of ['What you need', 'Five steps', 'Is it safe?']) expect(await dlg.getByRole('heading', { name: h }).count()).toBe(1)
      expect(await dlg.getByRole('listitem').count()).toBe(8)
      const guide = dlg.getByRole('link', { name: /Open the full guide/ })
      expect(await guide.getAttribute('href')).toBe('/docs/plugin-guide.html')
      expect(await guide.getAttribute('target')).toBe('_blank')
      expect(await guide.getAttribute('rel')).toContain('noopener')
      // the plugin kit (a zip with the guide, the example's source, the packages and the packing tool) and the packed example (only for trying the loader) are two different downloads
      const kit = dlg.getByRole('link', { name: 'Download the plugin kit (zip)' })
      expect(await kit.getAttribute('href')).toBe('/docs/ateliermesh-plugin-kit.zip'); expect(await kit.getAttribute('download')).not.toBeNull()
      expect(await dlg.getByText(/The packed example is only for trying the loader/).count()).toBe(1)
      const ex = dlg.getByRole('link', { name: 'Download the packed example (.amplugin)' })
      expect(await ex.getAttribute('href')).toBe('/docs/mirror-example.amplugin'); expect(await ex.getAttribute('download')).not.toBeNull()
      expect(await axe(page)).toEqual([])
      // back goes to the list and the focus returns to the entry; Escape goes back first, and closes the manager the second time
      await dlg.getByRole('button', { name: /Back to plugins/ }).first().click()
      await page.getByRole('dialog', { name: 'Add a plugin' }).waitFor()   // back to the add screen, where the entry is
      expect(await entry.evaluate(el => el === document.activeElement)).toBe(true)
      await entry.click(); await dlg.waitFor()
      await page.keyboard.press('Escape')
      await page.getByRole('dialog', { name: 'Add a plugin' }).waitFor()
      await page.keyboard.press('Escape')                                    // the add screen goes back to the list
      await page.getByRole('dialog', { name: 'Plugins' }).waitFor()
      expect(await page.getByRole('button', { name: 'Add plugin' }).evaluate(el => el === document.activeElement)).toBe(true)
      await page.keyboard.press('Escape')
      expect(await page.getByRole('dialog').count()).toBe(0)
      // copy with a clipboard: the prompt lands there and a polite message says so
      await page.evaluate(() => { (window as unknown as { __copied: string }).__copied = ''; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => { (window as unknown as { __copied: string }).__copied = t } } }) })
      await page.getByRole('button', { name: 'Add a step' }).click(); await page.getByRole('menuitem', { name: 'Plugins…' }).click()
      await page.getByRole('button', { name: 'Add plugin' }).click()
      await entry.click()
      await dlg.getByRole('button', { name: 'Copy a prompt for your AI agent' }).click()
      await dlg.getByRole('status').filter({ hasText: 'Copied' }).waitFor()
      expect(await page.evaluate(() => (window as unknown as { __copied: string }).__copied)).toBe(build.promptText)
      expect(await dlg.locator('textarea').count()).toBe(0)
      // no clipboard at all (plain http): the text is shown, selected, to copy by hand
      await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); document.execCommand = () => false })
      await dlg.getByRole('button', { name: 'Copy a prompt for your AI agent' }).click()
      const area = dlg.getByRole('textbox', { name: 'The prompt' })
      await area.waitFor()
      expect(await area.inputValue()).toBe(build.promptText)
      expect(await area.evaluate((el: HTMLTextAreaElement) => el.selectionEnd - el.selectionStart)).toBe(build.promptText.length)
      expect(await axe(page)).toEqual([])
    }, 120000)

    it('the "Build your own plugin" panel passes axe in the dark', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser, { dark: true, build: { guideUrl: '/g.html', promptText: 'x', exampleUrl: '/e.amplugin', kitUrl: '/k.zip' } })
      await page.getByRole('button', { name: 'Add a step' }).click(); await page.getByRole('menuitem', { name: 'Plugins…' }).click()
      await page.getByRole('button', { name: 'Add plugin' }).click()
      await page.getByRole('button', { name: 'Build your own plugin' }).click()
      await page.getByRole('dialog', { name: 'Build your own plugin' }).waitFor()
      expect(await axe(page)).toEqual([])
    }, 120000)

    it('shows the print check as a card: a verdict, a score, the findings, and a button that lights the places up in 3D', async ctx => {
      if (!browser) return ctx.skip()
      for (const dark of [false, true]) {
        const page = await open(browser, { dark })
        await page.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
        // a wall limit of 6 mm makes the 4 mm plate "too thin" everywhere
        await page.evaluate(() => (window as unknown as { __e: { addStepRaw(a: string, b: string, c: string, d: object): void } }).__e.addStepRaw('org.ateliermesh.printcheck', '0.1.0', 'printability', { min_wall: 6 }))
        await page.waitForFunction(() => document.querySelectorAll('.am-stepname').length >= 2, null, { timeout: 10000 })   // the new step is drawn
        await page.locator('.am-stepname').last().click()
        const card = page.locator('.am-printreport')
        await card.waitFor({ timeout: 30000 })
        expect(await card.getAttribute('data-verdict')).toBe('fix_recommended')
        expect(await card.textContent()).toContain('Fix recommended')
        expect(await card.textContent()).toContain('Score')
        expect(await card.textContent()).toMatch(/Walls thinner than 6 mm/)
        const show = card.locator('.am-pr-show').first()          // its name changes to 'Hide in 3D' when pressed
        expect(await show.isDisabled()).toBe(false)               // the check is the last step: the view shows the mesh it checked
        const objects = (): Promise<number> => page.evaluate(() => (window as unknown as { __viewer: { scene: { children: unknown[] } } }).__viewer.scene.children.length)
        const before = await objects()
        await show.click()
        await page.waitForFunction(n => (window as unknown as { __viewer: { scene: { children: unknown[] } } }).__viewer.scene.children.length > n, before, { timeout: 10000 })
        expect(await show.getAttribute('aria-pressed')).toBe('true')
        await show.click()
        await page.waitForFunction(n => (window as unknown as { __viewer: { scene: { children: unknown[] } } }).__viewer.scene.children.length <= n, before, { timeout: 10000 })
        // the passed checks sit in a closed list; the warnings of the step are not repeated in its notes
        expect(await card.locator('details').count()).toBe(1)
        expect(await page.locator('.am-notes .am-problem').count()).toBe(0)
        expect(await axe(page)).toEqual([])
      }
    }, 180000)

    it('lists the parts of the model and highlights one in the view', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser)
      await page.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
      await page.getByText('Parts', { exact: true }).click()
      // the plate is the body; the text step adds its own colour part
      await page.waitForFunction(() => (document.querySelector('.am-parts')?.textContent ?? '').includes('text'), null, { timeout: 30000 })
      expect(await page.locator('.am-parts li').count()).toBeGreaterThanOrEqual(2)
      const first = page.locator('.am-parts li button').first()
      await first.click()
      expect(await first.getAttribute('aria-pressed')).toBe('true')
      expect(await axe(page)).toEqual([])
    }, 120000)

    it('waits calmly: no flash for a quick run, loader + stage + Stop for a slow one, Stop keeps the model, announced once', async ctx => {
      if (!browser) return ctx.skip()
      // a quick run never shows the indicator
      const quick = await open(browser)
      await quick.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
      await quick.waitForTimeout(700)
      expect(await quick.getByTestId('working').count()).toBe(0)
      expect(await quick.getByTestId('center-loader').count()).toBe(0)
      // a slow run: after the short delay the row shows the stage of the running step, a bar and Stop; the view is dimmed
      const page = await open(browser, { delay: 6000 })
      const row = page.getByTestId('working')
      await row.waitFor({ timeout: 10000 })
      // the loader is also in the middle of the view; the stage row and bar stay in the foot
      const mid = await page.getByTestId('center-loader').boundingBox(), view = await page.locator('.am-editor-view').boundingBox()
      expect(Math.abs((mid!.x + mid!.width / 2) - (view!.x + view!.width / 2))).toBeLessThan(4)
      expect(Math.abs((mid!.y + mid!.height / 2) - (view!.y + view!.height / 2))).toBeLessThan(4)
      expect(await row.textContent()).not.toContain('Step 1 of')   // one step only: no counter
      expect(await row.textContent()).toContain('Cutting the letters')
      expect(await row.getByRole('button', { name: 'Stop' }).count()).toBe(1)
      expect(await page.locator('.am-editor-view').getAttribute('data-working')).toBe('true')
      expect(await page.locator('.am-bar-fill').getAttribute('style')).toContain('width')
      // the live region says "Working" once
      expect(await page.locator('.am-viewfoot [role="status"].am-sr').textContent()).toBe('Working')
      expect(await axe(page)).toEqual([])
      // Stop: the indicator goes, the model stays, the step shows it was stopped, and "Done" is announced
      await row.getByRole('button', { name: 'Stop' }).click()
      await row.waitFor({ state: 'detached', timeout: 10000 })
      expect(await page.locator('.am-editor-view').getAttribute('data-working')).toBeNull()
      expect(await page.locator('.am-status').first().textContent()).toContain('Closed solid')
      await page.waitForFunction(() => document.querySelector('.am-step .am-dot .am-sr')?.textContent === 'Stopped', null, { timeout: 10000 })
      expect(await page.locator('.am-viewfoot [role="status"].am-sr').textContent()).toBe('Done')
    }, 120000)

    it('animates the loader only when motion is allowed, and passes axe in the dark', async ctx => {
      if (!browser) return ctx.skip()
      const names = async (page: Page): Promise<string> => page.locator('.am-loader-f').first().evaluate(e => getComputedStyle(e).animationName)
      const calm = await open(browser, { delay: 4000 })       // reduced motion
      await calm.getByTestId('working').waitFor({ timeout: 10000 })
      expect(await names(calm)).toBe('none')
      const lively = await open(browser, { delay: 4000, motion: true, dark: true })
      await lively.getByTestId('working').waitFor({ timeout: 10000 })
      expect(await names(lively)).toBe('am-pass')
      expect(await axe(lively)).toEqual([])
    }, 120000)

    it('hides personalisation until it is switched on in Settings, and asks before switching it off', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser)
      expect(await page.getByText('Personalised design', { exact: true }).count()).toBe(0)
      await page.getByRole('button', { name: 'Settings' }).click()
      await page.getByRole('switch', { name: 'Show the Personalised design option' }).check()
      await page.getByRole('button', { name: 'Close' }).click()
      await page.getByRole('switch', { name: 'Personalised design' }).check()
      await page.getByLabel('Text is personalisable').check()
      await page.getByLabel('Lines at most').fill('2')
      expect((await state(page)).personalisable[0]).toEqual(['text'])
      expect(await page.locator('.am-badge').count()).toBe(1)
      // switching off asks first, and Cancel keeps everything
      await page.getByRole('switch', { name: 'Personalised design' }).click()
      await page.getByRole('alertdialog').or(page.getByRole('dialog')).getByText('This removes personalisation from 1 steps').waitFor()
      await page.getByRole('button', { name: 'Keep it on' }).click()
      expect((await state(page)).personalisable[0]).toEqual(['text'])
      await page.getByRole('switch', { name: 'Personalised design' }).click()
      await page.getByRole('button', { name: 'Switch off', exact: true }).click()
      expect((await state(page)).personalisable[0]).toEqual([])
      expect(await axe(page)).toEqual([])
    }, 120000)

    it('a plugin that crashes is switched off: a banner with the reason, the step names the problem, the menu drops it, and switching it on again tries it again', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser)
      await page.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
      await page.evaluate(() => (window as unknown as { __e: { addCrashStep(): void } }).__e.addCrashStep())
      const banner = page.locator('.am-crash')
      await banner.getByText('The plugin “Crashy” stopped working and was switched off. ReferenceError: oops is not defined').waitFor({ timeout: 30000 })
      // the step says why it does not run, and the text step before it keeps its result
      await page.locator('.am-stepname', { hasText: 'Boom' }).click()
      await page.getByText(/is switched off because it stopped working/).first().waitFor()
      await page.getByRole('button', { name: 'Add a step' }).click()
      expect(await page.getByRole('menuitem', { name: 'Boom' }).count()).toBe(0)
      await page.getByRole('menuitem', { name: 'Plugins…' }).click()
      const dlg = page.getByRole('dialog', { name: 'Plugins' })
      await dlg.getByText('Switched off because it stopped working: ReferenceError: oops is not defined').waitFor()
      expect(await axe(page)).toEqual([])
      await page.keyboard.press('Escape')
      // switch it on again: it runs again, crashes again and is switched off again (the banner comes back, nothing loops)
      await banner.getByRole('button', { name: 'Switch on again' }).click()
      await banner.getByText(/stopped working and was switched off/).waitFor({ timeout: 30000 })
      expect(await page.locator('.am-crash').count()).toBe(1)
    }, 120000)

    it('manages plugins and guards unsaved changes', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser, { dirty: true })
      await page.getByRole('button', { name: 'Add a step' }).click()
      await page.getByRole('menuitem', { name: 'Plugins…' }).click()
      const dlg = page.getByRole('dialog', { name: 'Plugins' })
      await dlg.waitFor()
      expect(await dlg.getByText('Built in').count()).toBe(1)
      expect(await dlg.getByRole('button', { name: 'Remove Parts' }).isEnabled()).toBe(true)
      await dlg.getByRole('button', { name: 'Remove Parts' }).click()
      await page.getByRole('dialog', { name: 'Remove this plugin?' }).getByRole('button', { name: 'Remove', exact: true }).click()
      await dlg.getByRole('button', { name: 'Add plugin' }).click()
      const add = page.getByRole('dialog', { name: 'Add a plugin' })
      await add.getByLabel('Plugin address (https)').fill('https://example.com/p.amplugin')
      await add.getByRole('button', { name: 'Load' }).click()
      expect((await state(page)).plugin).toEqual(['remove:test.parts', 'url:https://example.com/p.amplugin'])
      expect(await axe(page)).toEqual([])
      await page.keyboard.press('Escape')                                   // the add screen goes back to the list
      await page.getByRole('dialog', { name: 'Plugins' }).waitFor()
      await page.keyboard.press('Escape')
      expect(await page.getByRole('dialog').count()).toBe(0)
      // leaving with unsaved changes: Stay keeps the page, Save and leave saves first
      await page.getByRole('button', { name: 'Open another file' }).click()
      const leave = page.getByRole('alertdialog', { name: 'Leave without saving?' })
      await leave.getByText('Your changes since 14:32 are not saved').waitFor()
      await page.keyboard.press('Escape')                                   // a question that must be answered: Escape does not answer it
      expect(await leave.count()).toBe(1)
      await leave.getByRole('button', { name: 'Stay' }).click()
      expect((await state(page)).left).toBe(0)
      await page.getByRole('button', { name: 'Open another file' }).click()
      await page.getByRole('button', { name: 'Save and leave' }).click()
      await page.waitForFunction(() => (window as unknown as { __e: { state(): { left: number } } }).__e.state().left === 1)
      expect((await state(page)).saved).toBe(1)
    }, 120000)

    it('uses a bottom sheet on a phone: the whole list is reachable and the view keeps its height', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser, { phone: true })
      const sheet = page.locator('.am-sheet')
      await sheet.waitFor()
      // add six steps; the list lives in the sheet, which scrolls on its own
      for (let i = 0; i < 6; i++) { await page.getByRole('button', { name: 'Add a step' }).click(); await page.getByRole('menuitem', { name: 'Size', exact: true }).click() }
      expect((await state(page)).steps.length).toBe(7)
      const box = async (sel: string): Promise<{ top: number; bottom: number; height: number }> => page.locator(sel).first().evaluate(e => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height } })
      const vh = page.viewportSize()!.height
      // pull the sheet to full: it takes most of the screen, so the list is not squeezed into a small window
      const handle = page.getByRole('button', { name: 'Pull the panel down' })
      await handle.click()                                                  // half -> full
      const full = await box('.am-sheet')
      expect(full.height).toBeGreaterThan(vh * 0.65)
      expect(full.bottom).toBeLessThanOrEqual(vh + 1)
      // every step's buttons can be reached by scrolling the sheet body, and are really on screen afterwards
      const last = page.locator('.am-stepname').last()
      await last.scrollIntoViewIfNeeded()
      const lb = await last.boundingBox()
      expect(lb!.y).toBeGreaterThan(full.top)
      expect(lb!.y + lb!.height).toBeLessThanOrEqual(full.bottom + 1)
      expect(await last.click({ trial: true }).then(() => true, () => false)).toBe(true)
      // peek: one line, the view is nearly the whole screen
      await handle.click()                                                  // full -> peek
      const peek = await box('.am-sheet')
      expect(peek.height).toBeLessThan(80)
      expect((await box('.am-editor-view')).height).toBeGreaterThan(vh * 0.6)
      expect(await axe(page)).toEqual([])
    }, 120000)

    // ---- embedded use (0.2.1): no top bar, one column, extra sheet tab and sticky bar, state and one command
    type Ed = { states(): Array<Record<string, unknown>>; current(): Record<string, unknown>; request(on: boolean): Promise<boolean> }
    const ed = <R>(page: Page, f: (e: Ed) => R | Promise<R>): Promise<R> => page.evaluate(`(${f.toString()})(window.__e)`) as Promise<R>

    it('chrome none removes the whole top bar; full keeps it', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser, { embed: { chrome: 'none' } })
      await page.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
      expect(await page.locator('.am-editor-bar').count()).toBe(0)
      expect(await page.getByRole('switch').count()).toBe(0)
      expect(await page.getByRole('button', { name: 'Undo' }).count()).toBe(0)
      expect(await page.getByRole('button', { name: 'Settings' }).count()).toBe(0)
      expect(await page.getByRole('heading', { name: 'Editor', level: 1 }).count()).toBe(1)   // the screen-reader heading stays
      expect(await page.getByRole('button', { name: 'Add a step' }).first().isVisible()).toBe(true)
      const full = await open(browser)
      expect(await full.locator('.am-editor-bar').count()).toBe(1)
    }, 120000)

    it('embedded layout: one left column, the view takes the rest', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser, { width: 1280, embed: { chrome: 'none', layout: 'embedded' } })
      await page.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
      expect(await page.locator('.am-right').count()).toBe(0)
      const col = (await page.locator('.am-embedded-col').boundingBox())!, view = (await page.locator('.am-editor-view').boundingBox())!
      expect(Math.round(col.width + view.width)).toBe(1280)
      expect(view.width).toBeGreaterThan(1280 - 400)                          // before: 640 between two columns; now the right column's width is added
      // steps on top, the selected step's settings under them, in the same column
      const steps = (await page.locator('.am-embedded-col .am-panelhead').boundingBox())!, settings = (await page.locator('.am-embedded-col .am-settingspane').boundingBox())!
      expect(settings.y).toBeGreaterThan(steps.y)
      expect(Math.abs(settings.x - col.x)).toBeLessThan(40)
      expect(await axe(page)).toEqual([])
      const dark = await open(browser, { width: 1280, dark: true, embed: { chrome: 'none', layout: 'embedded' } })
      await dark.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
      expect(await axe(dark)).toEqual([])
    }, 120000)

    it('embedded layout: the step settings are only under the Steps tab, not under Colours', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser, { width: 1280, embed: { chrome: 'none', layout: 'embedded', colours: true } })
      await page.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
      expect(await page.locator('.am-embedded-col .am-settingspane .am-sethead').count()).toBe(1)
      await page.locator('#am-ltab-colours').click()
      expect(await page.locator('.am-embedded-col .am-settingspane .am-sethead').count()).toBe(0)
      await page.locator('#am-ltab-steps').click()
      expect(await page.locator('.am-embedded-col .am-settingspane .am-sethead').count()).toBe(1)
    }, 120000)

    it('embedded layout: the switcher has equal tabs with the icon over the label, a long label is cut, Add a step is the first button of the Steps panel', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser, { width: 1000, embed: { chrome: 'none', layout: 'embedded', colours: true } })
      await page.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
      await page.evaluate(() => { const l = document.querySelector('#am-ltab-colours .am-ctab-label'); if (l) l.textContent = 'Kleuren en filamenten' })
      const col = (await page.locator('.am-embedded-col').boundingBox())!
      const a = (await page.locator('#am-ltab-steps').boundingBox())!, b = (await page.locator('#am-ltab-colours').boundingBox())!
      expect(Math.abs(a.width - b.width)).toBeLessThan(2)                      // equal widths
      expect(a.height).toBeGreaterThanOrEqual(56)
      expect(b.x + b.width).toBeLessThanOrEqual(col.x + col.width)
      const label = (await page.locator('#am-ltab-colours .am-ctab-label').boundingBox())!, icon = (await page.locator('#am-ltab-colours .am-ctab-icon').boundingBox())!
      expect(label.y).toBeGreaterThan(icon.y + icon.height - 2)                // the label is under the icon
      expect(label.width).toBeLessThanOrEqual(b.width)
      // no column title: the switcher is the header; Add a step is the full-width first button of the panel
      expect(await page.locator('.am-embedded-col h2', { hasText: /^Steps$/ }).count()).toBe(0)
      const add = (await page.locator('.am-embedded-col .am-panelact').first().boundingBox())!, sw = (await page.locator('.am-ctabs').boundingBox())!
      expect(add.y).toBeGreaterThan(sw.y + sw.height - 1)
      expect(add.width).toBeGreaterThan(col.width - 60)
      // no store and no colours: no switcher at all
      const bare = await open(browser, { width: 1000, embed: { chrome: 'none', layout: 'embedded' } })
      await bare.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
      expect(await bare.locator('.am-ctabs').count()).toBe(0)
    }, 120000)

    it('host options: header slot, status chip or none, compact tabs, sheet start and memory, tablet widths', async ctx => {
      if (!browser) return ctx.skip()
      // header slot at the top of the embedded left column; status line as a chip
      const wide = await open(browser, { width: 1280, embed: { chrome: 'none', layout: 'embedded', headerText: 'Personalised design', props: { statusLine: 'chip' } } })
      await wide.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
      const head = (await wide.locator('.am-embedded-col .host-header').boundingBox())!, colhead = (await wide.locator('.am-embedded-col .am-panelhead').boundingBox())!
      expect(head.y).toBeLessThan(colhead.y)
      const view = (await wide.locator('.am-editor-view').boundingBox())!, chip = (await wide.locator('.am-status-chip').boundingBox())!
      expect(chip.y).toBeLessThan(view.y + 60)                                // at the top of the view, not along the bottom
      await wide.context().close()
      // no status line: nothing drawn for the eye, still in the page for a screen reader
      const none = await open(browser, { width: 1280, embed: { chrome: 'none', layout: 'embedded', props: { statusLine: 'none' } } })
      await none.waitForFunction(() => [...document.querySelectorAll('.am-sr[role="status"]')].some(e => e.textContent?.includes('Closed solid')), null, { timeout: 60000 })
      expect(await none.locator('.am-status').count()).toBe(0)
      await none.context().close()
      // tablet: nothing runs past the right edge between 769 and 900 px, in both layouts
      for (const layout of ['columns', 'embedded']) {
        const tab = await open(browser, { width: 820, embed: { chrome: 'none', layout } })
        await tab.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
        expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        expect((await tab.locator('.am-editor-view').boundingBox())!.width).toBeGreaterThan(280)
        await tab.context().close()
      }
    }, 180000)

    it('a picture setting shows the host\'s pictures as a grid: pick one, clear it, upload goes to the host', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser, { width: 1280, embed: { pictures: true } })
      await page.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
      await page.getByRole('button', { name: 'Add a step' }).click()
      await page.getByRole('menuitem', { name: /texture/i }).first().click()
      await page.locator('.am-settingspane select', { has: page.locator('option', { hasText: /^Picture$/ }) }).first().selectOption({ label: 'Picture' })
      const grid = page.locator('.am-pictures')
      if (!(await grid.isVisible())) await page.locator('details.am-group', { has: grid }).locator('summary').click()
      await grid.waitFor()
      expect(await grid.locator('.am-pic').count()).toBe(2)
      expect(await page.getByRole('combobox', { name: 'Group' }).count()).toBe(1)           // two groups: a filter
      await grid.getByRole('button', { name: 'Dots' }).click()
      expect(await grid.getByRole('button', { name: 'Dots' }).getAttribute('aria-pressed')).toBe('true')
      expect((await state(page)).steps.some(x => x.includes('texture'))).toBe(true)
      await grid.getByRole('button', { name: 'None' }).click()
      expect(await grid.locator('[aria-pressed="true"]').count()).toBe(0)
      await grid.getByRole('button', { name: 'Upload…' }).click()
      expect((await state(page)).plugin.some(x => x.startsWith('asset:'))).toBe(true)        // the host's own file picker is asked
      await page.context().close()
    }, 120000)

    it('host options on a phone: the sheet starts where it is told, remembers its height, the switcher, header in the sheet', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser, { phone: true, embed: { chrome: 'none', layout: 'embedded', tabs: true, headerText: 'Personalised design', props: { sheetStart: 'full', compactTabs: true, sheetRemember: 'am-test-sheet' } } })
      await page.locator('.am-sheet').waitFor()
      expect(await page.locator('.am-phonebody').getAttribute('data-sheet')).toBe('full')
      // the switcher is the design's (round 7): 56 px tabs with the icon over the label; `compactTabs` no longer changes it
      expect(await page.locator('.am-sheet .am-ctabs').count()).toBe(1)
      expect((await page.locator('.am-sheet .am-ctab').first().boundingBox())!.height).toBeGreaterThanOrEqual(56)
      expect(await page.locator('.am-sheet .am-ctab-divider').count()).toBe(1)                // the host's Print tab comes after a divider
      expect(await page.locator('.am-sheet-header .host-header').count()).toBe(1)
      await page.context().close()
      // a remembered height wins over sheetStart
      const again = await open(browser, { phone: true, embed: { chrome: 'none', layout: 'embedded', seed: { 'am-test-sheet': 'peek' }, props: { sheetStart: 'full', sheetRemember: 'am-test-sheet' } } })
      await again.locator('.am-sheet').waitFor()
      expect(await again.locator('.am-phonebody').getAttribute('data-sheet')).toBe('peek')
      // a change is written down
      await again.locator('.am-sheet-handle').click()
      const kept = await again.evaluate(() => (window as unknown as { __store: Record<string, string> }).__store['am-test-sheet'])
      expect(['half', 'full']).toContain(kept)
      expect(await again.locator('.am-phonebody').getAttribute('data-sheet')).toBe(kept)
    }, 180000)

    it('embedded on a phone: an extra tab in the sheet and a sticky bar that stays at every height', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser, { phone: true, embed: { chrome: 'none', layout: 'embedded', tabs: true, footer: true } })
      const sheet = page.locator('.am-sheet')
      await sheet.waitFor()
      const vh = page.viewportSize()!.height
      const rect = (sel: string): Promise<{ top: number; bottom: number; height: number }> => page.locator(sel).first().evaluate(e => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height } })
      const handle = page.locator('.am-sheet-handle')
      for (const height of ['half', 'full', 'peek'] as const) {
        while ((await sheet.getAttribute('class'))!.includes(`am-sheet-${height}`) === false) await handle.click()
        const f = await rect('.host-next'), h = await rect('.am-sheet-handle'), sh = await rect('.am-sheet')
        expect(f.bottom).toBeLessThanOrEqual(vh + 1); expect(f.top).toBeGreaterThanOrEqual(sh.top)     // the bar is on screen, inside the sheet
        expect(f.top).toBeGreaterThanOrEqual(h.bottom - 1)                                              // and does not cover the handle
        expect(h.top).toBeGreaterThanOrEqual(sh.top - 1); expect(h.top).toBeGreaterThanOrEqual(0)
        expect((await page.locator('.host-next').click({ trial: true }).then(() => true, () => false))).toBe(true)
      }
      // peek: the view still has most of the screen, and the bar sits under the handle
      expect((await rect('.am-editor-view')).height).toBeGreaterThan(vh * 0.55)
      await handle.click()                                                                              // peek -> half
      // the extra tab: reachable by the keyboard, shows the host's content
      const steps = page.getByRole('tab', { name: 'Steps' }), print = page.getByRole('tab', { name: 'Print' })
      expect(await steps.getAttribute('aria-selected')).toBe('true')
      await steps.focus(); await page.keyboard.press('ArrowRight')
      expect(await print.getAttribute('aria-selected')).toBe('true')
      expect(await page.getByText('Print settings').isVisible()).toBe(true)
      expect(await page.getByRole('button', { name: 'Print option' }).isVisible()).toBe(true)
      await page.getByRole('tab', { name: 'Steps' }).click()
      expect(await page.getByText('Print settings').count()).toBe(0)
      expect(await axe(page)).toEqual([])
    }, 120000)

    it('onState reports what the host needs and changes when it changes; requestPersonalised asks first', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser, { mode: 'designer', embed: { chrome: 'none', layout: 'embedded' } })
      await page.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
      await page.waitForFunction(() => (window as unknown as { __e: Ed }).__e.current()['running'] === false, null, { timeout: 60000 })
      const s0 = await ed(page, e => e.current())
      expect(s0).toMatchObject({ personalised: false, personalisableSteps: 0, hasError: false, closedSolid: true, running: false })
      expect(s0['size']).toEqual({ w: 70, h: 30, d: 4.8 })
      expect((await ed(page, e => e.states())).length).toBeGreaterThan(0)
      // a step of a plugin this browser does not have fails: hasError
      await page.evaluate(() => (window as unknown as { __e: { addStepRaw(a: string, b: string, c: string, d: object): void } }).__e.addStepRaw('nobody.here', '1.0.0', 'x', {}))
      await page.waitForFunction(() => (window as unknown as { __e: Ed }).__e.current()['hasError'] === true, null, { timeout: 30000 })
      // turn the personalised design on, mark a step as personalisable, then ask to turn it off
      expect(await ed(page, e => e.request(true))).toBe(true)
      await page.waitForFunction(() => (window as unknown as { __e: Ed }).__e.current()['personalised'] === true)
      await page.getByLabel('Text is personalisable').check()
      expect(await ed(page, e => e.current()['personalisableSteps'])).toBe(1)
      const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'))
      const pending = page.evaluate(() => (window as unknown as { __e: Ed }).__e.request(false))
      await dialog.getByText('This removes personalisation from 1 steps').waitFor()
      await page.getByRole('button', { name: 'Keep it on' }).click()
      expect(await pending).toBe(false)
      expect((await ed(page, e => e.current()))['personalised']).toBe(true)
      const again = page.evaluate(() => (window as unknown as { __e: Ed }).__e.request(false))
      await page.getByRole('button', { name: 'Switch off', exact: true }).click()
      expect(await again).toBe(true)
      await page.waitForFunction(() => (window as unknown as { __e: Ed }).__e.current()['personalised'] === false)
      expect((await ed(page, e => e.current()))['personalisableSteps']).toBe(0)
      // the same value is no change
      expect(await ed(page, e => e.request(false))).toBe(false)
    }, 120000)
  })
}

// Where the Add a step menu is drawn. It must stay inside the window: the step column is narrow, sits at the left edge, and scrolls, so a panel wider than the column
// can be clipped or make the column scroll sideways (seen in Firefox on 2026-11-16). Checked in all three engines, at three window widths, with the submenu open,
// after a scroll and after a resize, because the engines differ in what they do with a focused field inside a scrolling column.
for (const [name, type] of [['chromium', chromium], ['webkit', webkit], ['firefox', firefox]] as const) {
  d(`the Add a step menu stays inside the window in ${name}`, () => {
    let browser: Browser | null = null
    beforeAll(async () => {
      try { browser = await type.launch({ headless: true, ...(name === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } : {}) }) }
      catch (e) { console.warn(`${name} is not available here: ${String(e).split('\n')[0]}`) }
    })
    afterAll(async () => { await browser?.close() })
    afterEach(async () => { await Promise.all(opened.splice(0).map(c => c.close().catch(() => undefined))) })

    const inside = async (page: Page, selector: string, what: string): Promise<void> => {
      const box = (await page.locator(selector).first().boundingBox())!, vp = page.viewportSize()!
      expect(box, `${what} is drawn`).not.toBeNull()
      expect(box.x, `${what}: left edge`).toBeGreaterThanOrEqual(0)
      expect(box.y, `${what}: top edge`).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width, `${what}: right edge`).toBeLessThanOrEqual(vp.width)
      expect(box.y + box.height, `${what}: bottom edge`).toBeLessThanOrEqual(vp.height)
    }
    const notScrolled = async (page: Page): Promise<void> => {
      expect(await page.locator('.am-left').evaluate(e => e.scrollLeft), 'the step column did not scroll sideways').toBe(0)
      expect((await page.locator('.am-panelhead').boundingBox())!.x, 'the column header is still at the left edge').toBeGreaterThanOrEqual(0)
    }

    for (const width of [900, 1200, 1500]) {
      it(`at ${width} px wide: the panel and its submenu are inside the window, below the button, and the step column does not scroll sideways`, async ctx => {
        if (!browser) return ctx.skip()
        const page = await open(browser, { width })
        await page.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
        const button = page.getByRole('button', { name: 'Add a step' }).first()
        await button.click()
        await page.locator('.am-addpanel').waitFor()
        await inside(page, '.am-addpanel', 'the panel')
        await notScrolled(page)
        const b = (await button.boundingBox())!, p = (await page.locator('.am-addpanel').boundingBox())!
        expect(p.y, 'below the button').toBeGreaterThanOrEqual(b.y + b.height)
        // a submenu (a plugin with several operations in one group) opens inside the window too
        await page.locator('[data-group]').first().click()
        await page.locator('.am-flyout').waitFor()
        await inside(page, '.am-flyout', 'the submenu')
        await notScrolled(page)
        // it is really on screen, not clipped by the panel's list: what is at the middle of its first row is that row
        const hit = await page.locator('.am-flyout').evaluate(f => { const r = f.querySelector('[role="menuitem"]')!.getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!e && f.contains(e) })
        expect(hit, 'the submenu is on top and not clipped').toBe(true)
        await page.getByRole('menuitem', { name: 'Twist' }).click()
        expect(await page.locator('.am-addpanel').count(), 'choosing from the submenu adds the step and closes the menu').toBe(0)
      })
    }

    it('draws the "Recent" pills whole, with their top and bottom edges inside their row, also in a short window', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser, { width: 1200 })
      await page.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
      await page.getByRole('button', { name: 'Add a step' }).first().click(); await page.getByRole('menuitem', { name: 'Size', exact: true }).click()   // now it is a recent step
      await page.setViewportSize({ width: 1200, height: 520 })   // a short window makes the panel's list scroll: the row must keep its height
      await page.getByRole('button', { name: 'Add a step' }).first().click()
      const row = page.locator('.am-menu-recent'); await row.waitFor()
      const r = (await row.boundingBox())!, chip = (await row.locator('.am-chip').first().boundingBox())!
      expect(chip.height, 'the pill keeps its height').toBeGreaterThanOrEqual(28)
      expect(chip.y, 'the pill top is inside the row').toBeGreaterThanOrEqual(r.y)
      expect(chip.y + chip.height, 'the pill bottom is inside the row').toBeLessThanOrEqual(r.y + r.height)
      expect(r.height, 'the row is the pill plus its padding').toBeGreaterThanOrEqual(chip.height + 8)
    })

    it('stays inside the window and below the button after the step column is scrolled and after the window is resized while it is open', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser, { width: 1200 })
      await page.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
      for (let i = 0; i < 8; i++) { await page.getByRole('button', { name: 'Add a step' }).first().click(); await page.getByRole('menuitem', { name: 'Size', exact: true }).click() }   // a long list: the column scrolls
      await page.locator('.am-left').evaluate(e => { e.scrollTop = e.scrollHeight })
      await page.getByRole('button', { name: 'Add a step' }).first().click()
      await page.locator('.am-addpanel').waitFor()
      await inside(page, '.am-addpanel', 'the panel after a scroll')
      expect(await page.locator('.am-addpanel').evaluate(p => { const r = p.getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + 40); return !!e && p.contains(e) }), 'the panel is on top of the view').toBe(true)
      await notScrolled(page)
      await page.setViewportSize({ width: 800, height: 600 })
      await page.waitForTimeout(200)
      await inside(page, '.am-addpanel', 'the panel after a resize')
      const b = (await page.getByRole('button', { name: 'Add a step' }).first().boundingBox())!, p = (await page.locator('.am-addpanel').boundingBox())!
      expect(p.y, 'still below the button').toBeGreaterThanOrEqual(b.y + b.height)
    })

    it('typing in the search field does not scroll anything sideways', async ctx => {
      if (!browser) return ctx.skip()
      const page = await open(browser, { width: 1000 })
      await page.waitForFunction(() => document.querySelector('.am-status')?.textContent?.includes('Closed solid'), null, { timeout: 60000 })
      await page.getByRole('button', { name: 'Add a step' }).first().click()
      const field = page.getByRole('searchbox')
      await field.fill('hol')
      await inside(page, '.am-addpanel', 'the panel while searching')
      await notScrolled(page)
      expect(await page.getByRole('menuitem').count()).toBeGreaterThan(2)
    })

    it('on a phone the sheet is inside the window', async ctx => {
      if (!browser || name === 'firefox') return ctx.skip()   // Firefox has no mobile emulation
      const page = await open(browser, { phone: true })
      await page.getByRole('button', { name: 'Add a step' }).first().click()
      await page.locator('.am-addpanel').waitFor()
      await inside(page, '.am-addpanel', 'the sheet')
    })
  })
}

