import { build } from 'esbuild'
import { chromium, webkit } from 'playwright-core'
import type { Browser, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import { buildPluginPackage } from '../src'

const here = path.dirname(fileURLToPath(import.meta.url))
let script = ''
beforeAll(async () => {
  const r = await build({ entryPoints: [path.join(here, 'fixtures/harness.ts')], bundle: true, format: 'iife', write: false, logLevel: 'silent', platform: 'browser' })
  script = r.outputFiles[0]!.text
})

const manifest = (id: string, ops: string[], permissions?: string[], kind: 'modifier' | 'analyzer' = 'modifier') => ({ manifest_version: 1 as const, id, name: id, version: '1.0.0', license: 'MIT', description: 'A plugin used by the sandbox test.', ...(permissions ? { permissions } : {}), operations: ops.map(o => ({ id: o, kind, params: [] })) })
const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64')

// an add(a, b) function in WebAssembly, assembled by hand: (module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add))
const ADD_WASM = Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 7, 1, 0x60, 2, 0x7f, 0x7f, 1, 0x7f, 3, 2, 1, 0, 7, 7, 1, 3, 0x61, 0x64, 0x64, 0, 0, 10, 9, 1, 7, 0, 0x20, 0, 0x20, 1, 0x6a, 0x0b])

const PLUGINS = {
  scale: { m: manifest('ext.scale', ['double']), main: `export default { async run(op, ctx) { const p = ctx.mesh.positions.map(v => v * 2); return { mesh: { positions: p, indices: ctx.mesh.indices } } } }` },
  fetcher: { m: manifest('ext.fetcher', ['try'], undefined, 'analyzer'), main: `export default { async run(op, ctx) {
    const out = {}
    try { await fetch('https://example.org/'); out.fetch = 'reached' } catch (e) { out.fetch = 'blocked' }
    try { const x = new XMLHttpRequest(); x.open('GET', 'https://example.org/'); x.send(); await new Promise(r => setTimeout(r, 300)); out.xhr = x.status === 0 ? 'blocked' : 'reached' } catch (e) { out.xhr = 'blocked' }
    try { const ws = new WebSocket('wss://example.org/'); await new Promise((res, rej) => { ws.onopen = () => res('open'); ws.onerror = () => rej(new Error('x')); setTimeout(() => rej(new Error('t')), 800) }); out.ws = 'reached' } catch (e) { out.ws = 'blocked' }
    try { out.parent = String(typeof self.parent) } catch (e) { out.parent = 'blocked' }
    try { out.storage = typeof localStorage } catch (e) { out.storage = 'blocked' }
    try { out.cookie = typeof document } catch (e) { out.cookie = 'blocked' }
    return { report: out } } }` },
  wasm: { m: manifest('ext.wasm', ['add'], ['wasm'], 'analyzer'), assets: { 'assets/add.wasm': ADD_WASM }, main: `export default { async run(op, ctx) { const bytes = await ctx.assets('pkg:ext.wasm/assets/add.wasm'); const { instance } = await WebAssembly.instantiate(bytes); return { report: { sum: instance.exports.add(2, 40) } } } }` },
  nan: { m: manifest('ext.nan', ['bad']), main: `export default { async run(op, ctx) { const p = new Float64Array([0, 0, NaN, 1, 0, 0, 0, 1, 0]); return { mesh: { positions: p, indices: new Uint32Array([0, 1, 2]) } } } }` },
  range: { m: manifest('ext.range', ['bad']), main: `export default { async run(op, ctx) { return { mesh: { positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 7]) } } } }` },
  loop: { m: manifest('ext.loop', ['spin']), main: `export default { async run(op, ctx) { for (;;) {} } }` },
  throws: { m: manifest('ext.throws', ['boom']), main: `export default { async run() { throw Object.assign(new Error('x'), {}) } }` },
  nomodule: { m: manifest('ext.nomodule', ['x']), main: `export const nothing = 1` },
  syntax: { m: manifest('ext.syntax', ['x']), main: `export default { run( { ` },
  assets: { m: manifest('ext.assets', ['peek'], undefined, 'analyzer'), assets: { 'assets/secret.txt': new TextEncoder().encode('hello') }, main: `export default { async run(op, ctx) { const a = await ctx.assets('pkg:ext.assets/assets/secret.txt'); let m = 'none'; try { await ctx.assets('pkg:ext.assets/manifest.json'); m = 'read' } catch (e) { m = 'refused' } let o = 'none'; try { await ctx.assets('pkg:other.plugin/main.js'); o = 'read' } catch (e) { o = 'refused' } return { report: { text: new TextDecoder().decode(a), manifest: m, other: o } } } }` },
  // a picture decoded inside the sandboxed worker: what a texture plugin would do first
  image: { m: manifest('ext.image', ['look'], undefined, 'analyzer'), assets: { 'assets/dot.png': Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')) }, main: `export default { async run(op, ctx) {
    const bytes = await ctx.assets('pkg:ext.image/assets/dot.png')
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d'); g.drawImage(bmp, 0, 0)
    return { report: { w: bmp.width, h: bmp.height, pixel: g.getImageData(0, 0, 1, 1).data.length } } } }` },
  // letter outlines asked of the host from inside the sandbox
  letters: { m: ({ ...manifest('ext.letters', ['outline'], undefined, 'analyzer'), uses: ['fonts'] } as ReturnType<typeof manifest>), main: `export default { async run(op, ctx) {
    const o = await ctx.fonts.outline('font:Any', 'Oo', { size: 10 })
    let bad = ''
    try { await ctx.fonts.outline('font:Any', 'Oo', { size: 'big' }) } catch (e) { bad = e.code }
    try { await ctx.fonts.outline('font:Any', '\u4e2d', { size: 10 }) } catch (e) { bad += '|' + e.code }
    return { report: { contours: o.contours.length, rule: o.fillRule, height: Math.round(o.bbox[3]), bad } } } }` },
  // stored payloads: a mesh step that also takes a stored drawing (a `payload` parameter), and a generator that returns a drawing
  stamper: { m: ({ ...manifest('ext.stamper', [], undefined), operations: [
    { id: 'stamp', kind: 'modifier', params: [{ name: 'shape', type: 'payload', accept: ['drawing'], default: null }] },
    { id: 'sketch', kind: 'generator', payload: { out: 'drawing' }, params: [] },
  ] } as ReturnType<typeof manifest>), main: `export default { async run(op, ctx) {
    if (op === 'sketch') return { payload: { kind: 'drawing', paths: [{ closed: true, points: [[0, 0], [4, 0], [4, 4], [0, 4]] }] } }
    const d = ctx.payloads.shape
    if (!d) throw Object.assign(new Error('no shape'), { code: 'test.no_shape' })
    let width = 0; for (const p of d.paths) for (const q of p.points) width = Math.max(width, q[0])
    return { mesh: { positions: ctx.mesh.positions.map(v => v * 2), indices: ctx.mesh.indices }, report: { kind: d.kind, paths: d.paths.length, width, names: Object.keys(ctx.payloads).join(',') } } } }` },
} as const
type Name = keyof typeof PLUGINS

for (const [name, type] of [['chromium', chromium], ['webkit', webkit]] as const) {
  describe(`sandbox in ${name}`, () => {
    let browser: Browser | null = null
    beforeAll(async () => { try { browser = await type.launch({ headless: true }) } catch (e) { console.warn(`${name} is not available here: ${String(e).split('\n')[0]}`) } })
    afterAll(async () => { await browser?.close() })

    const session = async (): Promise<Page> => {
      const page = await browser!.newPage()
      await page.setContent('<!doctype html><html><body></body></html>')
      await page.addScriptTag({ content: script })
      return page
    }
    const run = async (page: Page, plugin: Name, op: string, opts: { timeoutMs?: number; fontB64?: string; params?: Record<string, unknown>; store?: Record<string, unknown>; noSource?: boolean } = {}) => {
      const p = PLUGINS[plugin]
      const bytes = await buildPluginPackage({ manifest: p.m, main: p.main, ...('assets' in p ? { assets: p.assets as Record<string, Uint8Array> } : {}) })
      return page.evaluate(([data, o, timeout, font, params, store, noSource]) => (window as unknown as { __ld: { run: (b: string, op: string, params: object, opts: object) => Promise<{ status: string; error: { code: string; params?: Record<string, unknown> } | null; report: Record<string, unknown> | null; payloadKind: string | null; paths: number | null; volume: number | null; ms: number; iframes: number }> } }).__ld.run(data as string, o as string, params as object, { timeoutMs: timeout, ...(font ? { fontB64: font } : {}), ...(store ? { store } : {}), ...(noSource ? { noSource: true } : {}) }), [b64(bytes), op, opts.timeoutMs ?? 20000, opts.fontB64 ?? '', opts.params ?? {}, opts.store ?? null, opts.noSource ?? false] as const)
    }

    it('runs a plugin in the sandbox and returns its mesh; the sandbox is gone afterwards', async ctx => {
      if (!browser) return ctx.skip()
      const page = await session()
      const r = await run(page, 'scale', 'double')
      expect(r.status).toBe('ok')
      expect(r.volume).toBeCloseTo(8000, 6)
      expect(await page.locator('iframe').count()).toBe(0)
      await page.close()
    })

    it('a plugin takes a stored drawing through a payload parameter (ctx.payloads) next to its mesh', async ctx => {
      if (!browser) return ctx.skip()
      const page = await session()
      const store = { logo: { payload: { kind: 'drawing', paths: [{ closed: true, points: [[0, 0], [7, 0], [7, 3], [0, 3]] }, { closed: false, points: [[1, 1], [2, 2]] }] } } }
      const r = await run(page, 'stamper', 'stamp', { params: { shape: 'logo' }, store })
      expect(r.status, JSON.stringify(r.error)).toBe('ok')
      expect(r.report).toEqual({ kind: 'drawing', paths: 2, width: 7, names: 'shape' })
      expect(r.volume).toBeCloseTo(8000, 3)   // the plugin doubled the 10 mm box: 20 x 20 x 20
      expect(await page.locator('iframe').count()).toBe(0)
      await page.close()
    })

    it('a stored entry that is missing, or of the wrong kind, never reaches the sandboxed plugin', async ctx => {
      if (!browser) return ctx.skip()
      const page = await session()
      const missing = await run(page, 'stamper', 'stamp', { params: { shape: 'ghost' }, store: {} })
      expect(missing.error).toMatchObject({ code: 'input.missing_payload', params: { name: 'ghost' } })
      const wrong = await run(page, 'stamper', 'stamp', { params: { shape: 'plate' }, store: { plate: { payload: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] } } } })
      expect(wrong.error?.code).toBeDefined()
      await page.close()
    })

    it('a sandboxed plugin can return a drawing, which the runner checks like any other result', async ctx => {
      if (!browser) return ctx.skip()
      const page = await session()
      const r = await run(page, 'stamper', 'sketch', { noSource: true })
      expect(r.status, JSON.stringify(r.error)).toBe('ok')
      expect(r.payloadKind).toBe('drawing')
      expect(r.paths).toBe(1)
      await page.close()
    })

    it('a plugin that calls fetch, XMLHttpRequest or a WebSocket gets nothing, and cannot reach the app', async ctx => {
      if (!browser) return ctx.skip()
      const page = await session()
      const r = await run(page, 'fetcher', 'try')
      expect(r.status, JSON.stringify(r.error)).toBe('ok')
      expect(r.report).toMatchObject({ fetch: 'blocked', xhr: 'blocked', ws: 'blocked', storage: 'undefined', cookie: 'undefined' })
      await page.close()
    })

    it('a plugin with a WebAssembly module runs it', async ctx => {
      if (!browser) return ctx.skip()
      const page = await session()
      const r = await run(page, 'wasm', 'add')
      expect(r.status, JSON.stringify(r.error)).toBe('ok')
      expect(r.report).toEqual({ sum: 42 })
      await page.close()
    })

    it('a plugin that returns NaN positions or indices past the end is rejected', async ctx => {
      if (!browser) return ctx.skip()
      const page = await session()
      expect((await run(page, 'nan', 'bad')).error?.code).toBe('plugin.bad_mesh')
      expect((await run(page, 'range', 'bad')).error?.code).toBe('plugin.bad_mesh')
      await page.close()
    })

    it('a plugin that never stops is terminated at the time limit, and the page stays responsive', async ctx => {
      if (!browser) return ctx.skip()
      const page = await session()
      const r = await run(page, 'loop', 'spin', { timeoutMs: 700 })
      expect(r.error?.code).toBe('run.timeout')
      expect(r.ms).toBeLessThan(5000)
      await page.waitForFunction(() => document.querySelectorAll('iframe').length === 0, null, { timeout: 5000 })   // the sandbox is removed once the grace period is over
      const t = await page.evaluate(() => (window as unknown as { __ld: { pageAlive: () => Promise<number> } }).__ld.pageAlive())
      expect(t).toBeGreaterThan(0)
      await page.close()
    })

    it('probePackage: a package that starts is accepted, one that cannot be imported or has no run function is refused with the first line of the reason, and the sandbox is removed', async ctx => {
      if (!browser) return ctx.skip()
      const page = await session()
      const probe = async (plugin: Name) => {
        const p = PLUGINS[plugin]
        const bytes = await buildPluginPackage({ manifest: p.m, main: p.main })
        return page.evaluate(b => (window as unknown as { __ld: { probe: (b: string) => Promise<{ ok: boolean; message?: string; iframes: number }> } }).__ld.probe(b), b64(bytes))
      }
      expect(await probe('scale')).toMatchObject({ ok: true })
      const none = await probe('nomodule')
      expect(none.ok).toBe(false); expect(none.message).toContain('no default export')
      expect(await probe('syntax')).toMatchObject({ ok: false })
      await page.waitForFunction(() => document.querySelectorAll('iframe').length === 0, null, { timeout: 5000 })
      await page.close()
    })

    it('errors from a plugin, and a module without a run function, come back as structured errors', async ctx => {
      if (!browser) return ctx.skip()
      const page = await session()
      expect((await run(page, 'throws', 'boom')).error?.code).toBe('plugin.crashed')   // an exception the plugin did not mean is a crash, not a plugin.failed
      const bad = await run(page, 'nomodule', 'x', { timeoutMs: 3000 })
      expect(bad.status).toBe('error')
      expect(['plugin.crashed', 'run.timeout']).toContain(bad.error?.code)
      await page.close()
    })

    it('a plugin reads its own files through pkg: ids, but not the manifest, main.js or another package', async ctx => {
      if (!browser) return ctx.skip()
      const page = await session()
      const r = await run(page, 'assets', 'peek')
      expect(r.report).toEqual({ text: 'hello', manifest: 'refused', other: 'refused' })
      await page.close()
    })

    it('a plugin asks the host for letter outlines from inside the sandbox, and bad requests come back as errors', async ctx => {
      if (!browser) return ctx.skip()
      const page = await session()
      const r = await run(page, 'letters', 'outline', { fontB64: Buffer.from(fs.readFileSync(path.join(here, '../../../apps/standalone/public/fonts/roboto-regular.woff2'))).toString('base64') })
      expect(r.status).toBe('ok')
      expect(r.report).toEqual({ contours: 4, rule: 'nonzero', height: 10, bad: 'fonts.bad_options|emboss.missing_glyphs' })
      const none = await run(page, 'letters', 'outline')                     // a host without a font service refuses before the plugin starts
      expect(none.error?.code).toBe('plugin.needs_fonts')
      await page.close()
    })

    it('a plugin decodes a picture in the sandboxed worker (what a texture plugin needs)', async ctx => {
      if (!browser) return ctx.skip()
      const page = await session()
      const r = await run(page, 'image', 'look')
      expect(r.report).toEqual({ w: 1, h: 1, pixel: 4 })
      await page.close()
    })

    it('a URL that is not https is refused before anything is fetched, in the browser too', async ctx => {
      if (!browser) return ctx.skip()
      const page = await session()
      const out = await page.evaluate(() => (window as unknown as { __ld: { pinned: (u: string) => Promise<string> } }).__ld.pinned('http://example.org/x.amplugin'))
      expect(out).toBe('loader.bad_url:scheme_not_allowed')
      await page.close()
    })
  })
}
