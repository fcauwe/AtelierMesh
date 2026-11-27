import { build } from 'esbuild'
import { chromium, firefox, webkit } from 'playwright-core'
import type { Browser, Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { addStep, emptyStepList, loadProject, makeStep, saveProject } from '@ateliermesh/core'
import { sphereMesh } from '@ateliermesh/core/testing'
import { CORE_PLUGIN_ID, CORE_PLUGIN_VERSION } from '@ateliermesh/plugins'

// The two hooks in a real browser, with the real engine and no editor page: what `useProjectSession` and `useOpenFile` do for a host. See fixtures/hooks-harness.tsx.
const here = path.dirname(fileURLToPath(import.meta.url))
let script = ''
beforeAll(async () => {
  const r = await build({ entryPoints: [path.join(here, 'fixtures/hooks-harness.tsx')], bundle: true, format: 'iife', write: false, logLevel: 'silent', platform: 'browser', jsx: 'automatic', loader: { '.json': 'json' }, define: { 'process.env.NODE_ENV': '"development"' } })
  script = r.outputFiles[0]!.text
})

type H = {
  session: { docRef: { current: { name: string; list: { steps: unknown[] }; store: Record<string, unknown> } | null }; undo(): void; redo(): void; setName(n: string): void; addStoredItem(h: string, p: unknown): string | null; close(): void; projectBytes(d: unknown, e?: { name?: string }): Uint8Array }
  renders: Array<{ hasDoc: boolean; name: string | null }>
  changes: Array<{ why: string; name: string; steps: number; store: string[] }>
  edit(id: string): void; start(name: string): void; runNow(): void; release(): void; done: boolean
}
type O = { opened: Array<{ fileName: string; closed: boolean; triangles: number; simplified?: { from: number; to: number }; project: boolean; steps: number }>; noModel: number; open(bytes: Uint8Array, name: string): Promise<void> }
declare const __h: H, __o: O

const TRIS = sphereMesh(10, 3).indices.length / 3
const resize = makeStep({ id: 'r', plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op: 'resize', params: { mode: 'uniform', percent: 120 } })
const projectOf = (base: ReturnType<typeof sphereMesh> | null, name = 'p'): number[] => Array.from(saveProject({ name, base, list: addStep(emptyStepList(), resize), rollback: null, assets: [] }))

const opened: Array<{ close(): Promise<void> }> = []
for (const [name, type] of [['chromium', chromium], ['webkit', webkit], ['firefox', firefox]] as const) {
  describe(`the editor hooks in ${name}`, () => {
    let browser: Browser | null = null
    beforeAll(async () => { try { browser = await type.launch({ headless: true }) } catch (e) { console.warn(`${name} is not available here: ${String(e).split('\n')[0]}`) } })
    afterAll(async () => { await browser?.close() })
    afterEach(async () => { await Promise.all(opened.splice(0).map(c => c.close().catch(() => undefined))) })

    const mount = async (cfg: object, which: 'session' | 'open' = 'session', limits?: { edit: number; read: number }): Promise<Page> => {
      const ctx = await browser!.newContext(); opened.push(ctx)
      const page = await ctx.newPage()
      page.on('pageerror', e => { throw e })
      await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>')
      await page.evaluate(([c, w, l]) => { Object.assign(window, { __cfg: c, __which: w, __limits: l }) }, [cfg, which, limits] as const)
      await page.addScriptTag({ content: script })
      await page.waitForFunction(() => (window as unknown as { __h?: H }).__h?.session !== undefined || (window as unknown as { __o?: O }).__o?.open !== null)
      return page
    }
    const changes = (page: Page, n: number): Promise<unknown> => page.waitForFunction(k => __h.changes.length >= k, n)

    describe('useProjectSession', () => {
      it('starts with the project it is given, so the first render already has it, and that is not a change', async ctx => {
        if (!browser) return ctx.skip()
        const page = await mount({ initial: true })
        const r = await page.evaluate(() => ({ first: __h.renders[0], changes: __h.changes.length, name: __h.session.docRef.current!.name }))
        expect(r.first).toEqual({ hasDoc: true, name: 'first' }); expect(r.changes).toBe(0); expect(r.name).toBe('first')
      })
      it('without an initial project the first render is empty, as before', async ctx => {
        if (!browser) return ctx.skip()
        const page = await mount({})
        expect(await page.evaluate(() => __h.renders[0])).toEqual({ hasDoc: false, name: null })
      })
      it('tells the host what changed and why, once per change, and not when the project is closed', async ctx => {
        if (!browser) return ctx.skip()
        const page = await mount({})
        await page.evaluate(() => __h.start('p')); await changes(page, 1)
        await page.evaluate(() => __h.edit('a')); await changes(page, 2)
        await page.waitForTimeout(900)   // two edits of one step within 800 ms are one undo step (History coalescing): keep these two apart
        await page.evaluate(() => __h.edit('b')); await changes(page, 3)
        await page.evaluate(() => __h.session.undo()); await changes(page, 4)
        await page.evaluate(() => __h.session.redo()); await changes(page, 5)
        await page.evaluate(() => __h.session.setName('q')); await changes(page, 6)
        await page.evaluate(() => __h.session.addStoredItem('logo.svg', { kind: 'drawing', paths: [{ closed: true, points: [[0, 0], [1, 0], [1, 1]] }] })); await changes(page, 7)
        await page.evaluate(() => __h.session.close()); await page.waitForTimeout(100)
        const c = await page.evaluate(() => __h.changes)
        expect(c.map(x => x.why)).toEqual(['start', 'edit', 'edit', 'undo', 'redo', 'name', 'store'])
        expect(c.map(x => x.steps)).toEqual([0, 1, 2, 1, 2, 2, 2])
        expect(c[5]!.name).toBe('q'); expect(c[6]!.store).toEqual(['logo'])
      })
      it('puts an item under an exact name (replacing, and dropping the old SVG source), and refuses a bad name', async ctx => {
        if (!browser) return ctx.skip()
        const page = await mount({})
        await page.evaluate(() => __h.start('p')); await changes(page, 1)
        const tri = (): unknown => ({ kind: 'drawing', paths: [{ closed: true, points: [[0, 0], [1, 0], [1, 1]] }] })
        const r = await page.evaluate(t => {
          const s = __h.session as unknown as { putStoredItem(n: string, p: unknown): boolean }
          const a = s.putStoredItem('logo', t), b = s.putStoredItem('logo', t), bad = s.putStoredItem('Bad Name', t)
          return { a, b, bad }
        }, tri())
        expect(r).toEqual({ a: true, b: true, bad: false })
        await changes(page, 2)   // both puts happen in one batch: one change is reported
        expect(await page.evaluate(() => Object.keys(__h.session.docRef.current!.store))).toEqual(['logo'])
        expect((await page.evaluate(() => __h.changes)).map(c => c.why)).toEqual(['start', 'store'])
      })
      it('undoes with Ctrl-Z on the page by default, and not at all when shortcuts are off', async ctx => {
        if (!browser) return ctx.skip()
        for (const [cfg, steps] of [[{}, 0], [{ shortcuts: false }, 1]] as const) {
          const page = await mount(cfg)
          await page.evaluate(() => __h.start('p')); await changes(page, 1)
          await page.evaluate(() => __h.edit('a')); await changes(page, 2)
          await page.keyboard.press('Control+z')
          await page.waitForTimeout(150)
          expect(await page.evaluate(() => __h.session.docRef.current!.list.steps.length), `shortcuts ${JSON.stringify(cfg)}`).toBe(steps)
        }
      })
      it('writes the project file under another name without changing the project', async ctx => {
        if (!browser) return ctx.skip()
        const page = await mount({})
        await page.evaluate(() => __h.start('p')); await changes(page, 1)
        const bytes = await page.evaluate(() => Array.from(__h.session.projectBytes(__h.session.docRef.current, { name: 'Renamed' })))
        expect((await loadProject(Uint8Array.from(bytes))).name).toBe('Renamed')
        expect(await page.evaluate(() => __h.session.docRef.current!.name)).toBe('p')
      })
      it('waits for plugins that are still loading before it runs', async ctx => {
        if (!browser) return ctx.skip()
        const page = await mount({ holdReady: true })
        await page.evaluate(() => __h.start('p')); await changes(page, 1)
        await page.evaluate(() => __h.edit('a')); await changes(page, 2)
        await page.evaluate(() => __h.runNow())
        await page.waitForTimeout(150)
        expect(await page.evaluate(() => __h.done), 'still waiting').toBe(false)
        await page.evaluate(() => __h.release())
        await page.waitForFunction(() => __h.done, null, { timeout: 15000 })
      })
    })

    describe('useOpenFile', () => {
      it('offers a project saved under a higher limit the same simplification as a model, and opens it with its steps', async ctx => {
        if (!browser) return ctx.skip()
        const page = await mount({}, 'open', { edit: Math.floor(TRIS / 2), read: TRIS * 3 })
        void page.evaluate(b => __o.open(Uint8Array.from(b), 'big.amproj'), projectOf(sphereMesh(10, 3), 'big'))
        await page.getByRole('button', { name: /Simplify to/ }).click()
        await page.getByRole('button', { name: 'Open in the editor' }).click({ timeout: 60000 })
        await page.waitForFunction(() => __o.opened.length === 1, null, { timeout: 15000 })
        const m = (await page.evaluate(() => __o.opened))[0]!
        expect(m.project).toBe(true); expect(m.steps).toBe(1)
        expect(m.simplified!.from).toBe(TRIS); expect(m.triangles).toBeLessThan(TRIS / 2)
      })
      it('opens a project within the limit straight away, with no question', async ctx => {
        if (!browser) return ctx.skip()
        const page = await mount({}, 'open', { edit: TRIS + 10, read: TRIS * 3 })
        await page.evaluate(b => __o.open(Uint8Array.from(b), 'ok.amproj'), projectOf(sphereMesh(10, 3), 'ok'))
        const m = (await page.evaluate(() => __o.opened))[0]!
        expect(m.project).toBe(true); expect(m.triangles).toBe(TRIS); expect(m.simplified).toBeUndefined()
        expect(await page.getByRole('dialog').count()).toBe(0)
      })
      it('says so through its own callback when a project has no model, not with the generic "cannot be read" dialog', async ctx => {
        if (!browser) return ctx.skip()
        const page = await mount({}, 'open', { edit: 500, read: 5000 })
        await page.evaluate(b => __o.open(Uint8Array.from(b), 'empty.amproj'), projectOf(null, 'empty'))
        expect(await page.evaluate(() => __o.noModel)).toBe(1)
        expect(await page.evaluate(() => __o.opened.length)).toBe(0)
        expect(await page.getByRole('dialog').count()).toBe(0)
      })
      it('refuses a project over even the read limit, saying it is too large', async ctx => {
        if (!browser) return ctx.skip()
        const page = await mount({}, 'open', { edit: 100, read: Math.floor(TRIS / 2) })
        void page.evaluate(b => __o.open(Uint8Array.from(b), 'huge.amproj'), projectOf(sphereMesh(10, 3), 'huge'))
        await page.getByRole('button', { name: 'Choose another file' }).click({ timeout: 30000 })
        expect(await page.evaluate(() => __o.opened.length)).toBe(0)
      })
    })
  })
}
