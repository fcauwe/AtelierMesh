import { build } from 'esbuild'
import { chromium, webkit } from 'playwright-core'
import type { Browser } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
let script = ''
beforeAll(async () => {
  const entry = `import * as THREE from 'three'
import { sphereMesh } from '@ateliermesh/core/testing'
import { createViewer } from '../../src/viewer'
import { STILL_LOOK } from '../../src/look'
// draws a sphere on a transparent canvas and reads the picture back: the colour of the middle, the alpha of the corner and of the ground under the sphere
window.__look = async (opts, finishLater) => {
  const w = 300, h = 240
  const el = document.createElement('div'); el.style.cssText = 'position:fixed;left:0;top:0;width:' + w + 'px;height:' + h + 'px'; document.body.append(el)
  const v = createViewer(THREE, el, { background: null, plate: false, axes: false, maxPixelRatio: 1, color: '#d9541e', ...opts })
  v.setMesh(sphereMesh(20, 4), { fit: true }); v.setView('iso'); v.resize()
  if (finishLater !== undefined) v.setFinish(finishLater)
  const blob = await v.snapshot('image/png')
  const bmp = await createImageBitmap(blob)
  const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d'); g.drawImage(bmp, 0, 0)
  const px = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data)
  let shadow = 0   // pixels that are partly see-through and dark: a shadow, not the model
  const all = g.getImageData(0, 0, bmp.width, bmp.height).data
  for (let i = 0; i < all.length; i += 4) if (all[i + 3] > 20 && all[i + 3] < 200 && all[i] < 60 && all[i + 1] < 60) shadow++
  const out = { w: bmp.width, h: bmp.height, corner: px(2, 2), middle: px(w >> 1, h >> 1), shadow, magic: new Uint8Array(await blob.arrayBuffer()).slice(0, 4).join() }
  v.dispose(); el.remove(); return out
}
window.__still = STILL_LOOK`
  const r = await build({ stdin: { contents: entry, resolveDir: path.join(here, 'fixtures'), loader: 'ts' }, bundle: true, format: 'iife', write: false, logLevel: 'silent', platform: 'browser' })
  script = r.outputFiles[0]!.text
})

type Shot = { w: number; h: number; corner: number[]; middle: number[]; shadow: number; magic: string }

for (const [name, type] of [['chromium', chromium], ['webkit', webkit]] as const) {
  describe(`viewer looks in ${name}`, () => {
    let browser: Browser | null = null
    beforeAll(async () => {
      try { browser = await type.launch({ headless: true, ...(name === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } : {}) }) }
      catch (e) { console.warn(`${name} is not available here: ${String(e).split('\n')[0]}`) }
    })
    afterAll(async () => { await browser?.close() })

    it('keeps the old picture by default, and adds light, shadow and finish only when asked, on a transparent canvas', async ctx => {
      if (!browser) return ctx.skip()
      const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
      const errors: string[] = []
      page.on('pageerror', e => errors.push(String(e)))
      await page.setContent('<!doctype html><html><body></body></html>')
      await page.addScriptTag({ content: script })
      const shot = (opts: object, later?: string | null) => page.evaluate(([o, f]) => (window as unknown as { __look: (o: object, f?: unknown) => Promise<Shot> }).__look(o as object, f ?? undefined), [opts, later] as const)

      const plain = await shot({})
      expect(plain.magic).toBe('137,80,78,71')
      expect(plain.corner[3]).toBe(0)               // transparent canvas
      expect(plain.shadow).toBe(0)                  // no shadow unless asked
      expect(plain.middle[3]).toBe(255)

      const shadow = await shot({ shadow: true })
      expect(shadow.corner[3]).toBe(0)              // the shadow is only under the model; the rest stays transparent
      expect(shadow.shadow).toBeGreaterThan(300)    // a soft shadow shows next to the sphere

      const still = await page.evaluate(() => (window as unknown as { __still: object }).__still)
      expect(still).toMatchObject({ environment: 'studio', shadow: true, quality: 'high' })
      const high = await shot(still)
      expect(high.corner[3]).toBe(0)
      expect(high.shadow).toBeGreaterThan(300)
      expect(high.middle.slice(0, 3)).not.toEqual(plain.middle.slice(0, 3))   // studio light changes the colour of the surface

      const matte = await shot({ ...still, finish: 'matte' }), gloss = await shot({ ...still, finish: 'gloss' })
      expect(gloss.middle.slice(0, 3)).not.toEqual(matte.middle.slice(0, 3))
      const later = await shot({ ...still }, 'gloss')                         // setFinish after the viewer exists
      expect(later.middle.slice(0, 3)).toEqual(gloss.middle.slice(0, 3))

      const toned = await shot({ toneMapping: 'aces' })
      expect(toned.middle.slice(0, 3)).not.toEqual(plain.middle.slice(0, 3))  // tone mapping changes how colours come out
      expect(errors).toEqual([])
      await page.close()
    }, 60_000)
  })
}
