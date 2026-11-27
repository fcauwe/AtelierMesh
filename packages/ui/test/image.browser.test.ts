import { build } from 'esbuild'
import { chromium, webkit } from 'playwright-core'
import type { Browser } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
let script = ''
beforeAll(async () => {
  const entry = `import { decodeImage } from '${path.join(here, '../../core/src/image').replace(/\\/g, '/')}'
  ;(window as any).__img = { decodeImage }`
  const r = await build({ stdin: { contents: entry, resolveDir: here, loader: 'ts' }, bundle: true, format: 'iife', write: false, logLevel: 'silent', platform: 'browser' })
  script = r.outputFiles[0]!.text
})

for (const [name, type] of [['chromium', chromium], ['webkit', webkit]] as const) {
  describe(`image decoding in ${name}`, () => {
    let browser: Browser | null = null
    beforeAll(async () => { try { browser = await type.launch({ headless: true }) } catch (e) { console.warn(`${name} is not available here: ${String(e).split('\n')[0]}`) } })
    afterAll(async () => { await browser?.close() })
    it('decodes a PNG to pixels, refuses garbage and oversized pictures with clear errors', async ctx => {
      if (!browser) return ctx.skip()
      const page = await browser.newPage()
      await page.setContent('<!doctype html><html lang="en"><head><title>x</title></head><body></body></html>')
      await page.addScriptTag({ content: script })
      const out = await page.evaluate(async () => {
        const w = window as unknown as { __img: { decodeImage: (b: Uint8Array, o?: object) => Promise<{ width: number; height: number; data: Uint8ClampedArray }>} }
        // a 4 x 2 picture: left half black, right half white, drawn and encoded by the browser
        const c = new OffscreenCanvas(4, 2), g = c.getContext('2d') as OffscreenCanvasRenderingContext2D
        g.fillStyle = '#000'; g.fillRect(0, 0, 2, 2); g.fillStyle = '#fff'; g.fillRect(2, 0, 2, 2)
        const png = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer())
        const img = await w.__img.decodeImage(png)
        const err = async (f: () => Promise<unknown>): Promise<string> => { try { await f(); return 'none' } catch (e) { return (e as { code?: string }).code ?? String(e) } }
        return { w: img.width, h: img.height, left: img.data[0], right: img.data[8], garbage: await err(() => w.__img.decodeImage(new Uint8Array([1, 2, 3, 4]))), big: await err(() => w.__img.decodeImage(png, { maxPixels: 4 })) }
      })
      expect(out).toMatchObject({ w: 4, h: 2, garbage: 'image.invalid', big: 'image.too_large' })
      expect([out.left, out.right]).toEqual([0, 255])                      // black on the left, white on the right (red channel)
      await page.close()
    })
  })
}
