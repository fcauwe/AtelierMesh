import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MemoryCache, Registry, WorkerHost, addStep, applyPermanently, decodeDrawing, drawingBounds, emptyStepList, encodeDrawing, fromNodeWorker, isDrawing, loadProject, makeStep, measureMesh,
  payloadKindOf, payloadKinds, readZip, runWorkflow, saveProject, validateManifest, drawingShapeProblem, type Drawing, type Mesh, type Payload, type Step,
} from '../src'
import { SHAPES_PLUGIN_ID, TEST_PLUGIN_ID, boxMesh, createShapesPlugin, createTestPlugin, shapesManifest } from '../src/testing'

const sq = (id: string, op: string, params: Record<string, unknown> = {}, plugin = SHAPES_PLUGIN_ID): Step => makeStep({ id, plugin: { id: plugin, version: '1.0.0' }, op, params })
const list = (...s: Step[]) => s.reduce((l, x) => addStep(l, x), emptyStepList())
const registry = () => { const s = createShapesPlugin(); return { reg: new Registry().register(s.entry).register(createTestPlugin().entry), calls: s.calls } }
const square = (s: number): Drawing => ({ kind: 'drawing', paths: [{ closed: true, points: [[0, 0], [s, 0], [s, s], [0, s]] }] })

describe('payload kinds: a workflow that goes from a drawing to a mesh', () => {
  it('generates a drawing, shifts it, extrudes it, then runs a mesh step on the result', async () => {
    const { reg } = registry()
    const r = await runWorkflow(list(sq('a', 'square', { size: 20 }), sq('b', 'shift', { dx: 5 }), sq('c', 'extrude', { height: 3 }), sq('d', 'scale', { factor: 2 }, TEST_PLUGIN_ID)), { registry: reg })
    expect(r.ok, JSON.stringify(r.results.map(x => x.error))).toBe(true)
    // the drawing steps carry a payload and no mesh; the extrusion and what follows carry both
    expect(r.results[0]!.mesh).toBeUndefined()
    expect(payloadKindOf(r.results[0]!.payload!)).toBe('drawing')
    expect(drawingBounds(r.results[1]!.payload as Drawing)).toEqual([5, 0, 25, 20])
    expect(r.results[2]!.mesh).toBeDefined()
    expect(measureMesh(r.mesh!).volume).toBeCloseTo(20 * 20 * 3 * 8)
    expect(r.payload).toBe(r.mesh)
  })

  it('starts from a drawing given as the source', async () => {
    const { reg } = registry()
    const r = await runWorkflow(list(sq('b', 'shift', { dx: 2 }), sq('c', 'extrude')), { registry: reg, source: square(10) })
    expect(r.ok).toBe(true)
    expect(measureMesh(r.mesh!).volume).toBeCloseTo(10 * 10 * 4)
  })

  it('goes back to a drawing too (mesh to drawing)', async () => {
    const { reg } = registry()
    const r = await runWorkflow(list(sq('f', 'footprint')), { registry: reg, source: boxMesh(10, 20, 5) })
    expect(r.ok).toBe(true)
    expect(isDrawing(r.payload)).toBe(true)
    expect(r.mesh).toBeUndefined()
  })

  it('refuses a mesh step on a drawing and marks what follows stale', async () => {
    const { reg } = registry()
    const r = await runWorkflow(list(sq('a', 'square'), sq('b', 'scale', { factor: 2 }, TEST_PLUGIN_ID), sq('c', 'extrude')), { registry: reg })
    expect(r.ok).toBe(false)
    expect(r.results[1]!.error).toEqual({ code: 'input.wrong_kind', params: { op: 'scale', expected: 'mesh', got: 'drawing' } })
    expect(r.results[2]!.status).toBe('stale')
    expect(r.payload && isDrawing(r.payload)).toBe(true)   // the last good result is kept
  })

  it('refuses an extrusion of a mesh', async () => {
    const { reg } = registry()
    const r = await runWorkflow(list(sq('c', 'extrude')), { registry: reg, source: boxMesh(1, 1, 1) })
    expect(r.results[0]!.error).toEqual({ code: 'input.wrong_kind', params: { op: 'extrude', expected: 'drawing', got: 'mesh' } })
  })

  it('says what is missing when there is no input at all', async () => {
    const { reg } = registry()
    const r = await runWorkflow(list(sq('c', 'extrude')), { registry: reg })
    expect(r.results[0]!.error).toEqual({ code: 'input.missing_payload', params: { op: 'extrude', kind: 'drawing' } })
  })

  it('refuses a result of another kind than the operation promised', async () => {
    const { reg } = registry()
    const r = await runWorkflow(list(sq('a', 'square'), sq('w', 'wrong')), { registry: reg })
    expect(r.results[1]!.error?.code).toBe('plugin.bad_output')
    expect(r.results[1]!.error?.params).toMatchObject({ expected: 'drawing', got: 'mesh' })
  })

  it('reuses cached drawing and mesh steps', async () => {
    const { reg, calls } = registry()
    const cache = new MemoryCache()
    const l = list(sq('a', 'square'), sq('c', 'extrude'))
    await runWorkflow(l, { registry: reg, cache })
    const again = await runWorkflow(l, { registry: reg, cache })
    expect(again.fromCache).toBe(2); expect(again.ran).toBe(0)
    expect(calls['square']).toBe(1)
    expect(isDrawing(again.results[0]!.payload)).toBe(true)
    expect(again.mesh).toBeDefined()
    // another drawing as the source is another key
    const other = await runWorkflow(list(sq('s', 'shift')), { registry: reg, cache, source: square(10) })
    const other2 = await runWorkflow(list(sq('s', 'shift')), { registry: reg, cache, source: square(11) })
    expect(other2.fromCache).toBe(0); expect(other.ok && other2.ok).toBe(true)
  })

  it('applies permanently across kinds: the new base is a mesh', async () => {
    const { reg } = registry()
    const state = { base: square(10) as Payload, list: list(sq('c', 'extrude', { height: 2 })), rollback: null }
    const { state: next } = await applyPermanently<Payload, Mesh>(state, { registry: reg })
    expect(measureMesh(next.base!).volume).toBeCloseTo(200)
    expect(next.list.steps).toEqual([])
  })
})

describe('payload kinds: across a worker', () => {
  let dir = '', file = ''
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'am-payload-'))
    file = join(dir, 'worker.mjs')
    await build({ entryPoints: [join(__dirname, 'fixtures/worker-entry.ts')], bundle: true, platform: 'node', format: 'esm', outfile: file, logLevel: 'silent' })
  })
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('carries a drawing in and out, and a mesh out of an extrusion', async () => {
    const { reg } = registry()
    const host = new WorkerHost(() => fromNodeWorker(new Worker(file)), { graceMs: 300 })
    const src = square(10)
    const r = await runWorkflow(list(sq('b', 'shift', { dx: 1 }), sq('c', 'extrude', { height: 2 }), sq('f', 'footprint')), { registry: reg, host, source: src })
    expect(r.ok, JSON.stringify(r.results.map(x => x.error))).toBe(true)
    expect(drawingBounds(r.results[0]!.payload as Drawing)).toEqual([1, 0, 11, 10])
    expect(measureMesh(r.results[1]!.mesh!).volume).toBeCloseTo(200)
    expect(drawingBounds(r.payload as Drawing)).toEqual([1, 0, 11, 10])
    expect(drawingBounds(src)).toEqual([0, 0, 10, 10])   // the input is untouched
  })

  it('carries a stored drawing next to the mesh into the worker (ctx.payloads)', async () => {
    const { reg } = registry()
    const host = new WorkerHost(() => fromNodeWorker(new Worker(file)), { graceMs: 300 })
    const r = await runWorkflow(list(sq('s', 'stamp', { shape: 'logo' })), { registry: reg, host, source: boxMesh(10, 10, 10), store: { logo: { payload: square(6) } } })
    expect(r.ok, JSON.stringify(r.results.map(x => x.error))).toBe(true)
    expect(r.results[0]!.report).toEqual({ shapePaths: 1, shapeWidth: 6 })
  })
})

describe('payload kinds: projects', () => {
  it('saves and loads a project that starts from a drawing, only for a host that accepts drawings', async () => {
    const bytes = saveProject({ name: 'd', base: square(10), list: list(sq('c', 'extrude')), rollback: null, assets: [] })
    const json = JSON.parse(new TextDecoder().decode((await readZip(bytes)).find(e => e.name === 'project.json')!.data)) as { base: string; base_kind: string }
    expect(json.base).toBe('inputs/base.amdraw'); expect(json.base_kind).toBe('drawing')
    await expect(loadProject(bytes)).rejects.toMatchObject({ code: 'import.invalid_project', params: { reason: 'base_kind_not_allowed', kind: 'drawing' } })
    const p = await loadProject<Payload>(bytes, { baseKinds: ['mesh', 'drawing'] })
    expect(isDrawing(p.base)).toBe(true)
    expect(drawingBounds(p.base as Drawing)).toEqual([0, 0, 10, 10])
  })

  it('a mesh project is written as before, without a base kind', async () => {
    const bytes = saveProject({ name: 'm', base: boxMesh(1, 2, 3), list: emptyStepList(), rollback: null, assets: [] })
    const json = JSON.parse(new TextDecoder().decode((await readZip(bytes)).find(e => e.name === 'project.json')!.data)) as { base: string; base_kind?: string }
    expect(json.base).toBe('inputs/base.ammesh'); expect(json.base_kind).toBeUndefined()
    expect((await loadProject(bytes)).base!.indices.length).toBe(36)
  })

  it('refuses a base of a kind nobody registered', async () => {
    expect(() => saveProject({ name: 'x', base: { kind: 'nothing' } as unknown as Payload, list: emptyStepList(), rollback: null, assets: [] })).toThrow()
  })
})

describe('payload kinds: files and manifests', () => {
  it('a drawing survives encode and decode, and a damaged one is refused', () => {
    const d: Drawing = { kind: 'drawing', paths: [{ closed: false, points: [[0, 0], [1, 1]], segment: 'cut' }], segments: [{ name: 'cut', color: '#ff0000' }], fillRule: 'evenodd' }
    expect(decodeDrawing(encodeDrawing(d))).toEqual(d)
    expect(() => decodeDrawing(new TextEncoder().encode('{"format":"amdraw","version":1,"paths":[{"closed":true,"points":[[0,0],[1,NaN]]}]}'))).toThrow()
    expect(() => decodeDrawing(new TextEncoder().encode('nope'))).toThrow()
    expect(() => decodeDrawing(encodeDrawing(square(1)), { maxPaths: 0 })).toThrow()
  })
  it('the shape check names the first problem', () => {
    expect(drawingShapeProblem({ kind: 'drawing', paths: [{ closed: true, points: [[0, 0], [1, 1]] }] })).toMatch(/too few points/)
    expect(drawingShapeProblem({ kind: 'drawing', paths: [{ closed: false, points: [[0, 0], [1, 1]], segment: 'x' }], segments: [] })).toMatch(/unknown segment/)
    expect(drawingShapeProblem(square(1))).toBeNull()
  })
  it('the fingerprint changes with the content', () => {
    expect(payloadKinds.key(square(1))).not.toBe(payloadKinds.key(square(2)))
    expect(payloadKinds.key(square(1))).toBe(payloadKinds.key(square(1)))
  })
  it('a manifest may declare the kinds; a bad word is refused', () => {
    expect(validateManifest(shapesManifest()).errors.map(e => e.code)).not.toContain('manifest.invalid')
    const bad = shapesManifest(); (bad.operations[0] as unknown as Record<string, unknown>)['payload'] = { in: 'Not A Word' }
    expect(JSON.stringify(validateManifest(bad).errors)).toContain('bad_payload')
  })
})
