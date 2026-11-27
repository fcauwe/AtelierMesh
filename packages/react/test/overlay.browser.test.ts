import { build } from 'esbuild'
import { chromium, webkit } from 'playwright-core'
import type { Browser } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/overlay.css'), 'utf8')

const here = path.dirname(fileURLToPath(import.meta.url))
const FONT = fileURLToPath(new URL('../../../assets/atelier/frontend/public/fonts/roboto-v51-latin-regular.woff2', import.meta.url))
let script = ''
beforeAll(async () => {
  const r = await build({ entryPoints: [path.join(here, 'fixtures/harness.tsx')], bundle: true, format: 'iife', write: false, logLevel: 'silent', platform: 'browser', jsx: 'automatic', loader: { '.json': 'json' }, define: { 'process.env.NODE_ENV': '"development"' } })
  script = r.outputFiles[0]!.text
})

interface Status { ok: boolean | null; triangles: number; error: string | null; done: Record<string, unknown> | null; closed: number }
const d = fs.existsSync(FONT) ? describe : describe.skip

for (const [name, type] of [['chromium', chromium], ['webkit', webkit]] as const) {
  d(`personalise overlay in ${name}`, () => {
    let browser: Browser | null = null
    beforeAll(async () => {
      try { browser = await type.launch({ headless: true, ...(name === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } : {}) }) }
      catch (e) { console.warn(`${name} is not available here: ${String(e).split('\n')[0]}`) }
    })
    afterAll(async () => { await browser?.close() })

    it('shows only what is personalisable, runs on change, holds to the limits, resets and finishes', async ctx => {
      if (!browser) return ctx.skip()
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
      const errors: string[] = []
      page.on('pageerror', e => errors.push(String(e)))
      await page.setContent('<!doctype html><html lang="en"><head><title>Overlay</title></head><body></body></html>')
      await page.evaluate(b64 => { (window as unknown as { __font: string }).__font = b64 }, fs.readFileSync(FONT).toString('base64'))
      await page.addStyleTag({ content: css })
      await page.addScriptTag({ content: script })
      await page.evaluate(() => (window as unknown as { __t: { start(o?: object): void } }).__t.start())
      const status = (): Promise<Status> => page.evaluate(() => (window as unknown as { __t: { status(): Status } }).__t.status())
      const settled = async (): Promise<Status> => { await page.waitForFunction(() => (window as unknown as { __t: { status(): Status } }).__t.status().ok !== null, null, { timeout: 60000 }); return status() }

      // the first run: the designer's text is on the plate
      const first = await settled()
      expect(first.ok).toBe(true); expect(first.triangles).toBeGreaterThan(200)
      // no accessibility violations (WCAG 2.1 AA and best practice) with the default styles
      await page.addScriptTag({ path: axePath })
      const violations = await page.evaluate(async () => (await (window as unknown as { axe: { run: (c: Document, o: object) => Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ target: string[] }> }> }> } }).axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] })).violations.map(v => `${v.id}: ${v.help} -> ${v.nodes.map(n => n.target.join(' ')).join(', ')}`))
      expect(violations).toEqual([])
      // only the opened fields: text, font, letter height and direction; nothing for position, depth or mode
      await page.getByLabel('Wording').waitFor()
      expect(await page.getByRole('button', { name: 'Move left' }).count()).toBe(0)
      expect(await page.getByText('Depth').count()).toBe(0)
      expect(await page.getByRole('button', { name: '+90°', exact: true }).isEnabled()).toBe(false)   // outside the designer's -45 to 45
      expect(await page.getByRole('button', { name: '0°', exact: true }).isEnabled()).toBe(true)

      // typing stops at the designer's limit, and the model follows
      await page.getByLabel('Wording').fill('Anna\nSecond line')
      expect(await page.getByLabel('Wording').inputValue()).toBe('Anna')               // one line at most
      await page.waitForFunction(() => (window as unknown as { __t: { status(): Status } }).__t.status().triangles !== 0)
      // the letter height stops at the range
      await page.getByRole('spinbutton', { name: 'Letter height' }).fill('50')
      expect(await page.getByRole('spinbutton', { name: 'Letter height' }).inputValue()).toBe('10')

      // Reset goes back to the designer's version
      await page.getByRole('button', { name: 'Reset' }).click()
      expect(await page.getByLabel('Wording').inputValue()).toBe('Lotte')
      expect(await page.getByText("Back to the shop's design").isVisible()).toBe(true)

      // too long: the step fails, the banner offers a size, Done is disabled, the last good model stays
      await page.getByLabel('Wording').fill('WWWWWWWWWWWWWWWWWWWW')
      await page.getByRole('spinbutton', { name: 'Letter height' }).fill('10')
      await page.locator('.am-problem.am-error').waitFor({ timeout: 60000 })
      expect(await page.getByRole('button', { name: 'Done' }).isDisabled()).toBe(true)
      expect(await page.locator('.am-problem').textContent()).toContain('The previous result is still shown.')
      const fix = page.locator('.am-problem button', { hasText: /^Make it \d/ })
      expect(await fix.count()).toBe(1)                                                    // the engine named a size that fits
      await fix.click()
      await page.locator('.am-problem.am-error').waitFor({ state: 'detached', timeout: 60000 })
      expect(await page.getByRole('spinbutton', { name: 'Letter height' }).inputValue()).not.toBe('10')

      // Done: available once the run is good (the test clicks as soon as it is enabled), then hands the list back
      await page.getByRole('button', { name: 'Done' }).click()
      await page.waitForFunction(() => (window as unknown as { __t: { status(): Status } }).__t.status().done !== null, null, { timeout: 60000 })
      expect((await status()).done).toMatchObject({ font: 'roboto' })
      await page.getByRole('button', { name: 'Close without changes' }).click()
      expect((await status()).closed).toBe(1)
      expect(errors).toEqual([])
      await page.close()
    })

    const open = async (b: Browser, viewport: { width: number; height: number }, opts: object = {}) => {
      const page = await b.newPage({ viewport })
      const errors: string[] = []
      page.on('pageerror', e => errors.push(String(e)))
      await page.setContent('<!doctype html><html lang="en"><head><title>Overlay</title></head><body></body></html>')
      await page.evaluate(b64 => { (window as unknown as { __font: string }).__font = b64 }, fs.readFileSync(FONT).toString('base64'))
      await page.addStyleTag({ content: css })
      await page.addScriptTag({ content: script })
      await page.evaluate(o => (window as unknown as { __t: { start(o?: object): void } }).__t.start(o), opts)
      return { page, errors }
    }
    const done = (page: import('playwright-core').Page): Promise<Record<string, unknown> | null> => page.evaluate(() => (window as unknown as { __t: { status(): Status } }).__t.status().done)

    it('with colour slots the model is drawn in the colours the host chose for them', async ctx => {
      if (!browser) return ctx.skip()
      const list = async (o: object): Promise<string[]> => {
        const { page } = await open(browser!, { width: 1200, height: 800 }, o)
        await page.waitForFunction(() => (window as unknown as { __t: { colourList(): string[] } }).__t.colourList().length > 0, null, { timeout: 60000 })
        const n = await page.evaluate(() => (window as unknown as { __t: { colourList(): string[] } }).__t.colourList())
        await page.close()
        return n
      }
      const plain = await list({}), slots = await list({ colours: true })
      expect(slots.some(c => /^1\.000,0\.0\d\d,0\.0\d\d$|^1\.000,0\.000,0\.000$/.test(c))).toBe(true)   // the red slot (sRGB to linear leaves 1 and 0)
      expect(slots.some(c => /^0\.0\d\d,1\.000,0\.0\d\d$|^0\.000,1\.000,0\.000$/.test(c))).toBe(true)   // the green slot
      expect(plain.some(c => c === '1.000,0.000,0.000')).toBe(false)
    }, 120000)

    it('Done is greyed out while the model recalculates, and does nothing until the run is good', async ctx => {
      if (!browser) return ctx.skip()
      const { page, errors } = await open(browser, { width: 1200, height: 800 }, { hold: true })
      await page.getByLabel('Wording').waitFor()
      const doneBtn = page.locator('.am-primary')
      expect(await doneBtn.isDisabled()).toBe(true)              // the first run is pending
      expect((await doneBtn.textContent())?.trim()).toBe('Calculating…')
      await page.getByLabel('Wording').fill('Anna')
      expect(await doneBtn.isDisabled()).toBe(true)              // a new change: still pending
      await doneBtn.click({ force: true }).catch(() => undefined)
      expect(await done(page)).toBeNull()                        // pressing it did nothing, and nothing is queued
      await page.evaluate(() => (window as unknown as { __t: { release(): void } }).__t.release())
      await page.waitForFunction(() => !(document.querySelector('.am-primary') as HTMLButtonElement | null)?.disabled, null, { timeout: 60000 })
      expect(await done(page)).toBeNull()                        // the queued press did not fire when the run finished
      expect((await doneBtn.textContent())?.trim()).toBe('Done')
      await doneBtn.click()
      expect(await done(page)).toMatchObject({ text: 'Anna' })
      expect(errors).toEqual([])
      await page.close()
    })

    it('opens from the customer\'s earlier list: their values, the designer\'s Reset, and nothing the designer did not open', async ctx => {
      if (!browser) return ctx.skip()
      // the stored list changes the wording and the size (open), the depth (closed) and says the depth is open (a claim the designer never made)
      const { page, errors } = await open(browser, { width: 1200, height: 800 }, { initial: { params: { text: 'Anna', size: 6, height: 5 }, open: ['text', 'size', 'height'] } })
      expect(await page.getByLabel('Wording').inputValue()).toBe('Anna')
      expect(await page.getByText('Depth').count()).toBe(0)       // the designer's flags decide what is open
      await page.waitForFunction(() => !(document.querySelector('.am-primary') as HTMLButtonElement | null)?.disabled, null, { timeout: 60000 })
      await page.getByRole('button', { name: 'Done' }).click()
      expect(await done(page)).toMatchObject({ text: 'Anna', size: 6, height: 0.8 })   // the closed value is the designer's
      await page.getByRole('button', { name: 'Reset' }).click()
      expect(await page.getByLabel('Wording').inputValue()).toBe('Lotte')              // Reset goes to the designer's version, not the stored one
      expect(errors).toEqual([])
      await page.close()
    })

    it('on a phone the header buttons keep their width under a long title, and one open step draws no chip row', async ctx => {
      if (!browser) return ctx.skip()
      const { page, errors } = await open(browser, { width: 360, height: 740 }, { title: 'A very long name of a design that goes on and on and on, 60 chars' })
      await page.getByLabel('Wording').waitFor()
      const cut = await page.evaluate(() => [...document.querySelectorAll('.am-overlay-bar button')].filter(b => b.scrollWidth > b.clientWidth).map(b => b.textContent))
      expect(cut).toEqual([])
      expect(await page.locator('.am-overlay-bar strong').evaluate(e => e.scrollWidth > e.clientWidth)).toBe(true)   // the title is the one that gives way
      expect(await page.locator('.am-steps').isVisible()).toBe(false)
      expect(errors).toEqual([])
      await page.close()
    })

    it('drags the text on the model, inside the dashed limit, and the arrows agree', async ctx => {
      if (!browser) return ctx.skip()
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
      const errors: string[] = []
      page.on('pageerror', e => errors.push(String(e)))
      await page.setContent('<!doctype html><html lang="en"><head><title>Overlay</title></head><body></body></html>')
      await page.evaluate(b64 => { (window as unknown as { __font: string }).__font = b64 }, fs.readFileSync(FONT).toString('base64'))
      await page.addStyleTag({ content: css })
      await page.addScriptTag({ content: script })
      await page.evaluate(() => (window as unknown as { __t: { start(o?: object): void } }).__t.start({ position: true }))
      await page.waitForFunction(() => (window as unknown as { __t: { status(): Status } }).__t.status().ok !== null, null, { timeout: 60000 })
      await page.getByRole('button', { name: 'Move left' }).waitFor()                  // position is open: arrows are there
      expect(await page.getByRole('button', { name: '+90°', exact: true }).count()).toBe(0)   // direction is not
      const x0 = await page.evaluate(() => (window as unknown as { __t: { anchorX(): number } }).__t.anchorX())
      const shot = async (dx: number): Promise<{ from: { x: number; y: number }; to: { x: number; y: number } }> => page.evaluate(d => (window as unknown as { __t: { gripAt(d: number): never } }).__t.gripAt(d), dx)
      await page.waitForFunction(() => (window as unknown as { __t: { gripAt(d: number): unknown } }).__t.gripAt(0) !== null)
      // a short drag moves the text; a long one stops at the circle ("move at most 3 mm")
      const a = await shot(1.5), b = await shot(20)
      const canvas = (await page.locator('.am-canvas').boundingBox())!
      void canvas
      for (const [target, label] of [[a.to, 'short'], [b.to, 'long']] as const) {
        await page.mouse.move(a.from.x, a.from.y); await page.mouse.down()
        await page.mouse.move((a.from.x + target.x) / 2, (a.from.y + target.y) / 2, { steps: 4 }); await page.mouse.move(target.x, target.y, { steps: 4 }); await page.mouse.up()
        await page.waitForFunction(prev => Math.abs((window as unknown as { __t: { anchorX(): number } }).__t.anchorX() - prev) > 0.05, x0, { timeout: 30000 }).catch(() => undefined)
        await page.waitForTimeout(400)
        const x = await page.evaluate(() => (window as unknown as { __t: { anchorX(): number } }).__t.anchorX())
        expect(Math.abs(x - x0), label).toBeGreaterThan(0.3)
        expect(Math.abs(x - x0), label).toBeLessThanOrEqual(3 + 1e-6)
        if (label === 'short') expect(Math.abs(x - x0 - 1.5)).toBeLessThan(0.7)
        else expect(Math.abs(x - x0)).toBeGreaterThan(2.5)                            // pulled to the limit, not past it
        await page.getByRole('button', { name: "Back to the shop's position" }).click()
      }
      expect(errors).toEqual([])
      await page.close()
    })
  })
}
