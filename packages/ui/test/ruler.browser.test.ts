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
import { boxMesh } from '@ateliermesh/core/testing'
import { createViewer } from '../../src/viewer'
const count = (scene) => { let sprites = 0, lines = 0; scene.traverse(o => { if (o.isSprite) sprites++; if (o.isLineSegments && !o.isGridHelper && o.type === 'LineSegments' && o.material && o.material.type === 'LineBasicMaterial' && !o.geometry.userData.grid) lines++ }); return { sprites, lines } }
// the ruler of a 70 x 30 mm plate: counted in the scene, with the option and with setGuides
const bytes = async (v) => { const b = new Uint8Array(await (await v.snapshot()).arrayBuffer()); let h = 0; for (let i = 0; i < b.length; i++) h = (h * 31 + b[i]) >>> 0; return b.length + ':' + h }
window.__ruler = async (opts) => {
  const el = document.createElement('div'); el.style.cssText = 'position:fixed;left:0;top:0;width:300px;height:240px'; document.body.append(el)
  const v = createViewer(THREE, el, { maxPixelRatio: 1, ...opts })
  const out = {}
  v.setMesh(boxMesh(70, 30, 5), { fit: true })
  out.first = count(v.scene)
  v.setGuides({ ruler: true }); out.on = count(v.scene)
  v.setMesh(boxMesh(70, 30, 5), { fit: true }); out.again = count(v.scene)   // a new model keeps the ruler
  v.setGuides({ ruler: false }); out.off = count(v.scene)
  v.setGuides({ ruler: true }); out.back = count(v.scene)
  // the picture is the same with the ruler on or off, and the ruler is still there afterwards
  const plain = createViewer(THREE, el, { maxPixelRatio: 1 }); plain.setMesh(boxMesh(70, 30, 5), { fit: true }); plain.resize()
  out.snapPlain = await bytes(plain); plain.dispose()
  v.resize(); out.snapRuler = await bytes(v); out.afterSnap = count(v.scene)
  v.setMesh(null); out.empty = count(v.scene)
  v.dispose(); el.remove(); return out
}`
  const r = await build({ stdin: { contents: entry, resolveDir: path.join(here, 'fixtures'), loader: 'ts' }, bundle: true, format: 'iife', write: false, logLevel: 'silent', platform: 'browser' })
  script = r.outputFiles[0]!.text
})

type Counts = { sprites: number; lines: number }
type Out = { first: Counts; on: Counts; again: Counts; off: Counts; back: Counts; empty: Counts; snapPlain: string; snapRuler: string; afterSnap: Counts }

for (const [name, type] of [['chromium', chromium], ['webkit', webkit]] as const) {
  describe(`the ruler of the viewer in ${name}`, () => {
    let browser: Browser | null = null
    beforeAll(async () => {
      try { browser = await type.launch({ headless: true, ...(name === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } : {}) }) }
      catch (e) { console.warn(`${name} is not available here: ${String(e).split('\n')[0]}`) }
    })
    afterAll(async () => { await browser?.close() })

    it('is off by default, comes with setGuides, follows a new model, and goes away again', async ctx => {
      if (!browser) return ctx.skip()
      const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
      const errors: string[] = []
      page.on('pageerror', e => errors.push(String(e)))
      await page.setContent('<!doctype html><html><body></body></html>')
      await page.addScriptTag({ content: script })
      const run = (opts: object): Promise<Out> => page.evaluate(o => (window as unknown as { __ruler: (o: object) => Out }).__ruler(o as object), opts)

      const out = await run({})
      expect(out.first).toEqual({ sprites: 0, lines: 0 })            // nothing is drawn unless asked
      // 70 x 30 mm: ticks every 10 mm from the corner to the far edge of the plate; a number at every second tick; one name per direction
      expect(out.on).toEqual({ sprites: 11, lines: 2 })              // X: 0 20 40 60 80 + name, Y: 0 20 40 60 + name; one line object per direction
      expect(out.again).toEqual(out.on)
      expect(out.off).toEqual({ sprites: 0, lines: 0 })
      expect(out.back).toEqual(out.on)
      expect(out.empty).toEqual({ sprites: 0, lines: 0 })            // no model, no ruler
      expect(out.snapRuler).toBe(out.snapPlain)                      // the picture has no ruler
      expect(out.afterSnap).toEqual(out.on)                          // and the screen keeps it
      expect((await run({ ruler: true })).first).toEqual(out.on)     // the option does the same as setGuides
      expect(errors).toEqual([])
      await page.close()
    })
  })
}
