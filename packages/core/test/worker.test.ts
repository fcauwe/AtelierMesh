import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Registry, WorkerHost, fromNodeWorker, runWorkflow, addStep, emptyStepList, makeStep, measureMesh, type Step } from '../src'
import { boxMesh, createTestPlugin, TEST_PLUGIN_ID } from '../src/testing'

let dir = '', file = ''
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'am-worker-'))
  file = join(dir, 'worker.mjs')
  await build({ entryPoints: [join(__dirname, 'fixtures/worker-entry.ts')], bundle: true, platform: 'node', format: 'esm', outfile: file, logLevel: 'silent' })
})
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

const host = (graceMs = 300) => new WorkerHost(() => fromNodeWorker(new Worker(file)), { graceMs })
const st = (id: string, op: string, params: Record<string, unknown> = {}): Step => makeStep({ id, plugin: { id: TEST_PLUGIN_ID, version: '1.0.0' }, op, params })
const list = (...s: Step[]) => s.reduce((l, x) => addStep(l, x), emptyStepList())
const registry = () => new Registry().register(createTestPlugin().entry)

describe('WorkerHost in a Node worker thread', () => {
  it('runs a workflow and leaves the input mesh usable', async () => {
    const src = boxMesh(10, 10, 10)
    const r = await runWorkflow(list(st('s', 'scale', { factor: 2 }), st('m', 'measure')), { registry: registry(), host: host(), source: src })
    expect(r.ok).toBe(true)
    expect(r.results[1]!.report!['volume']).toBeCloseTo(8000)
    expect(src.positions.byteLength).toBeGreaterThan(0) // not transferred away
    expect(measureMesh(src).volume).toBeCloseTo(1000)
  })
  it('carries segments across the worker boundary, in and out', async () => {
    const src = boxMesh(10, 10, 10)
    const r = await runWorkflow(list(st('l', 'label_top', { name: 'top' }), st('u', 'lift', { segment: 'top', dz: 0 })), { registry: registry(), host: host(), source: src })
    expect(r.ok, JSON.stringify(r.results.map(x => x.error))).toBe(true)
    const m = r.mesh!
    expect(m.segments?.table.map(x => x.name)).toEqual(['body', 'top'])
    expect(Array.from(m.segments!.labels).filter(l => l === 1).length).toBe(2)   // the two triangles of the top face
    expect(src.segments).toBeUndefined()
  })
  it('reports plugin errors with their code', async () => {
    const r = await runWorkflow(list(st('f', 'fail')), { registry: registry(), host: host(), source: boxMesh(1, 1, 1) })
    expect(r.results[0]!.error?.code).toBe('test.deliberate')
  })
  it('serves assets through the host resolver', async () => {
    const r = await runWorkflow(list(st('a', 'read_asset', { id: 'font' })), { registry: registry(), host: host(), source: boxMesh(1, 1, 1), assets: async id => new Uint8Array([id.length, 2, 3]) })
    expect(r.results[0]!.report).toEqual({ length: 3, first: 4 })
  })
  it('answers ctx.fonts.outline through the host, and refuses nonsense options', async () => {
    const seen: Array<[string, string, unknown]> = []
    const fonts = async (id: string, text: string, o: unknown) => { seen.push([id, text, o]); return { contours: [[[0, 0], [1, 0], [1, 1]] as Array<[number, number]>], fillRule: 'nonzero' as const, bbox: [0, 0, 1, 1] as [number, number, number, number], lines: 1, size: 10, fitScale: 1 } }
    const r = await runWorkflow(list(st('o', 'font_outline', { font: 'font:Roboto', text: 'Hi', size: 12 })), { registry: registry(), host: host(), source: boxMesh(1, 1, 1), fonts })
    expect(r.results[0]!.report).toEqual({ contours: 1, bbox: [0, 0, 1, 1], fillRule: 'nonzero', size: 10 })
    expect(seen).toEqual([['font:Roboto', 'Hi', { size: 12, align: 'left' }]])
    // a size that is not a number never reaches the host's font code
    const bad = await runWorkflow(list(st('o', 'font_outline', { font: 'font:Roboto', text: 'Hi', size: 0 })), { registry: registry(), host: host(), source: boxMesh(1, 1, 1), fonts })
    expect(bad.results[0]!.error).toBeUndefined()          // 0 is clamped up to 0.1, a number
    expect((seen[1]![2] as { size: number }).size).toBe(0.1)
  })
  it('a plugin that asks for fonts when the host has none gets fonts.unavailable', async () => {
    const r = await runWorkflow(list(st('o', 'font_outline')), { registry: registry(), host: host(), source: boxMesh(1, 1, 1) })
    expect(r.results[0]!.error?.code).toBe('fonts.unavailable')
  })
  it('cancels cooperatively', async () => {
    const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 150)
    const r = await runWorkflow(list(st('w', 'slow', { ms: 5000 })), { registry: registry(), host: host(), source: boxMesh(1, 1, 1), signal: ctrl.signal })
    expect(r.results[0]!.status).toBe('cancelled')
  })
  it('terminates a plugin that ignores cancellation', async () => {
    const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 150)
    const t0 = Date.now()
    const r = await runWorkflow(list(st('x', 'stubborn', { ms: 5000 })), { registry: registry(), host: host(200), source: boxMesh(1, 1, 1), signal: ctrl.signal })
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(r.results[0]!.status).toBe('cancelled')
  })
})
