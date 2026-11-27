import { build } from 'esbuild'
import { chromium, webkit } from 'playwright-core'
import type { Browser } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
let script = ''

beforeAll(async () => {
  const r = await build({ entryPoints: [path.join(here, 'fixtures/harness.ts')], bundle: true, format: 'iife', write: false, logLevel: 'silent', platform: 'browser' })
  script = r.outputFiles[0]!.text
})

type T = { start(): { webgl: boolean }; bigPick(): { hit: Hit | null; triangles: number; tFirst: number; tNext: number; tThreeAll: number; same: boolean }; picks(): { centre: Hit | null; corner: Hit | null }; lookDown(): void; click(): Hit | null; pinch(): { before: number; after: number }; handle(): { log: string[]; orbitMoved: boolean }; highlight(): boolean; overlay(): { added: number; after: number }; snapshot(): Promise<{ size: number; magic: number[]; width: number; height: number; drawn: number; red: number }>; dispose(): number }
interface Hit { point: number[]; normal: number[]; triangle: number; segment: string | null }

for (const [name, type] of [['chromium', chromium], ['webkit', webkit]] as const) {
  describe(`viewer in ${name}`, () => {
    let browser: Browser | null = null
    beforeAll(async () => {
      try { browser = await type.launch({ headless: true, ...(name === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } : {}) }) }
      catch (e) { console.warn(`${name} is not available here: ${String(e).split('\n')[0]}`) }
    })
    afterAll(async () => { await browser?.close() })

    it('shows, picks, highlights, overlays, snapshots and cleans up', async ctx => {
      if (!browser) return ctx.skip()
      const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
      const errors: string[] = []
      page.on('pageerror', e => errors.push(String(e)))
      await page.setContent('<!doctype html><html><body></body></html>')
      await page.addScriptTag({ content: script })
      const call = <K extends keyof T>(k: K, ...a: unknown[]) => page.evaluate(([key, args]) => (window as unknown as { __t: Record<string, (...x: unknown[]) => unknown> }).__t[key as string]!(...(args as unknown[])), [k, a] as const) as Promise<Awaited<ReturnType<T[K]>>>

      expect((await call('start')).webgl).toBe(true)
      await call('lookDown')                       // drag far down: the camera ends above the part
      const { centre, corner } = await call('picks')
      expect(corner).toBeNull()                    // the sky
      expect(centre).not.toBeNull()
      // from above, the hit is on a top face: point z = 10 mm (engine Z up), normal points up in engine coordinates
      expect(centre!.point[2]).toBeCloseTo(10, 3)
      expect(centre!.normal[2]).toBeCloseTo(1, 3)
      expect(centre!.segment).toBe('text')         // the top triangles carry the segment label
      expect(Number.isInteger(centre!.triangle)).toBe(true)
      // the hit lies inside the L-shaped outline (40 x 20 with a 20 x 10 notch)
      const [x, y] = centre!.point as [number, number]
      expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(40); expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(20)

      const clicked = await call('click')
      expect(clicked).not.toBeNull()
      expect(clicked!.triangle).toBe(centre!.triangle)

      const pinch = await call('pinch')
      expect(pinch.after).toBeLessThan(pinch.before * 0.8)        // two fingers moving apart zoom in
      const grab = await call('handle')
      expect(grab.orbitMoved).toBe(false)                         // the handle was grabbed, the model did not orbit
      expect(grab.log[0]).not.toBeUndefined(); expect(grab.log.at(-1)).toBe('end'); expect(grab.log.length).toBeGreaterThanOrEqual(3)

      expect(await call('highlight')).toBe(true)
      const ov = await call('overlay')
      expect(ov.after).toBe(ov.added - 1)          // the overlay group is removed again

      const snap = await call('snapshot')
      expect(snap.magic).toEqual([137, 80, 78, 71]) // PNG
      expect(snap.size).toBeGreaterThan(1000)
      expect(snap.drawn).toBeGreaterThan(2000)      // the model is on the canvas
      expect(snap.red).toBeGreaterThan(200)         // the segment colour shows (top faces, seen from above)

      const big = await call('bigPick')           // runs last: it replaces the model
      expect(big.triangles).toBeGreaterThan(100000)
      expect(big.hit).not.toBeNull()
      expect(big.hit!.point[2]).toBeCloseTo(5, 6)
      expect(Math.abs(big.hit!.normal[2])).toBeCloseTo(1, 6)
      console.log(`${name}: ${big.triangles} triangles, first click ${big.tFirst.toFixed(0)} ms (builds the index), later ${big.tNext.toFixed(2)} ms, three.js raycaster + pick ${big.tThreeAll.toFixed(2)} ms`)
      expect(big.same).toBe(true)                 // same points as three.js
      expect(big.tNext).toBeLessThan(5)           // ms per click once the index exists

      expect(await call('dispose')).toBe(0)
      expect(errors).toEqual([])
      await page.close()
    })
  })
}
