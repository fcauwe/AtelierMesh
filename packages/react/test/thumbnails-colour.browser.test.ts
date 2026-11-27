import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import type { Browser } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
let browser: Browser, plain: Browser, script = ''
beforeAll(async () => {
  script = (await build({ entryPoints: [path.join(here, 'fixtures/thumb-harness.ts')], bundle: true, format: 'iife', write: false, logLevel: 'silent', platform: 'browser' })).outputFiles[0]!.text
  browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
  plain = await chromium.launch()   // as the Atelier's CI starts it: SwiftShader, but strict `failIfMajorPerformanceCaveat` is still granted
}, 60_000)
afterAll(async () => { await browser?.close(); await plain?.close() })

describe('preview picture colour', () => {
  it('the picture takes the colour asked for and is grey without one', async () => {
    const page = await browser.newPage()
    await page.setContent('<!doctype html><body></body>')
    await page.addScriptTag({ content: script })
    const grey = await page.evaluate(() => (window as unknown as { __colour: (c?: string) => Promise<number[] | null> }).__colour())
    const red = await page.evaluate(() => (window as unknown as { __colour: (c?: string) => Promise<number[] | null> }).__colour('#d02020'))
    expect(grey).not.toBeNull(); expect(red).not.toBeNull()
    const [gr, gg, gb] = grey as number[], [rr, rg, rb] = red as number[]
    expect(Math.abs((gr as number) - (gb as number))).toBeLessThan(25)          // grey: red and blue are close
    expect((rr as number) - (rb as number)).toBeGreaterThan(40)                  // red: much more red than blue
    expect((rr as number) - (rg as number)).toBeGreaterThan(40)
    void gg; void rg
    await page.close()
  }, 60_000)

  it.each([['flags that make the strict check fail', () => browser], ['a plain launch, where the strict check is granted', () => plain]])('`auto`: software is found with %s; the same size, two at once both finish, many in a row let go of their contexts', async (_n, which) => {
    const page = await which().newPage()
    const warnings: string[] = []
    page.on('console', m => { if (/too many active webgl contexts/i.test(m.text())) warnings.push(m.text()) })
    await page.setContent('<!doctype html><body></body>')
    await page.addScriptTag({ content: script })
    const r = await page.evaluate(() => (window as unknown as { __auto: () => Promise<{ software: boolean; sizes: number[][]; many: number }> }).__auto())
    expect(r.software).toBe(true)                                   // swiftshader is a software renderer
    expect(r.sizes).toEqual([[1024, 683], [200, 100], [1024, 683]])   // auto, auto with a size, light               // the high picture's size, or the one asked for
    expect(r.many).toBe(24)
    expect(warnings).toEqual([])
    await page.close()
  }, 120_000)
})
