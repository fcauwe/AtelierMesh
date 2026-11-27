import { describe, expect, it } from 'vitest'
import { Registry, addStep, assignSegment, emptyStepList, makeStep, measureMesh, runWorkflow } from '@ateliermesh/core'
import { cylinderMesh, sphereMesh } from '@ateliermesh/core/testing'
import { CORE_PLUGIN_ID, CORE_PLUGIN_VERSION, corePlugin, decimate, decimateWasm } from '../src'
import { gridBox } from './parts'

describe('decimate in WebAssembly', () => {
  it('gives an equivalent result to the JavaScript version (same algorithm; equal-cost ties may break differently)', async () => {
    for (const [name, mesh, target] of [['sphere', sphereMesh(20, 4), 800], ['cylinder', cylinderMesh(10, 30, 96), 200], ['box', gridBox(20, 20, 20, 10, 10, 10), 100]] as const) {
      const a = decimate(mesh, { targetTriangles: target }), b = await decimateWasm(mesh, { targetTriangles: target })
      expect(Math.abs(b.after - a.after) / a.after, name).toBeLessThan(0.06)   // held vertices can leave a few more or fewer triangles, depending on tie order
      expect(Math.abs(measureMesh(b.mesh).volume - measureMesh(a.mesh).volume) / measureMesh(a.mesh).volume, name).toBeLessThan(0.005)
      expect(measureMesh(b.mesh).watertight, name).toBe(true)
      expect(b.maxError, name).toBeLessThan(a.maxError * 1.5 + 1e-6)
    }
  })

  it('keeps segment labels and borders, honours max_error, and returns the input when it is small enough', async () => {
    const box = gridBox(20, 20, 20, 10, 10, 10)
    const flags = new Uint8Array(box.indices.length / 3)
    for (let t = 0; t < flags.length; t++) if ([0, 1, 2].every(k => Math.abs(box.positions[3 * box.indices[3 * t + k]! + 2]! - 20) < 1e-9)) flags[t] = 1
    const r = await decimateWasm(assignSegment(box, 'top', flags), { targetTriangles: 100 })
    for (let t = 0; t < r.mesh.indices.length; t += 3) {
      const isTop = r.mesh.segments!.labels[t / 3] === 1
      const flat = [0, 1, 2].every(k => Math.abs(r.mesh.positions[3 * r.mesh.indices[t + k]! + 2]! - 20) < 1e-9)
      expect(isTop).toBe(flat)
    }
    const early = await decimateWasm(sphereMesh(20, 4), { targetTriangles: 4, maxError: 0.05 })
    expect(early.after).toBeGreaterThan(500)
    const small = sphereMesh(5, 1)
    expect((await decimateWasm(small, { targetTriangles: 1000 })).mesh).toBe(small)
    await expect(decimateWasm({ ...small, groups: [{ start: 0, count: 3, role: 'solid' }] }, { targetTriangles: 8 })).rejects.toMatchObject({ code: 'decimate.groups_unsupported' })   // does not cover the mesh
  })

  it('works as a step with engine auto, wasm and js, and says which it used', async () => {
    const reg = new Registry().register(corePlugin())
    const run = async (engine: string) => (await runWorkflow(addStep(emptyStepList(), makeStep({ id: 'd', plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op: 'decimate', params: { mode: 'target', target_triangles: 500, engine } })), { registry: reg, source: sphereMesh(10, 4) })).results[0]!
    expect((await run('auto')).report!['engine']).toBe('wasm')
    expect((await run('wasm')).report!['engine']).toBe('wasm')
    const js = await run('js')
    expect(js.report!['engine']).toBe('js')
    expect(js.report!['triangles_after']).toBe((await run('wasm')).report!['triangles_after'])
  })

  it('is much faster: 128 000 flat triangles to 20 000, and a sphere of 82 000 to 8 000', async () => {
    const flat = gridBox(200, 100, 3, 250, 125, 2)
    let t = performance.now(); const w = await decimateWasm(flat, { targetTriangles: 20000 }); const wasmMs = performance.now() - t
    t = performance.now(); const j = decimate(flat, { targetTriangles: 20000 }); const jsMs = performance.now() - t
    expect(w.after).toBe(j.after)
    console.log(`flat 128k: wasm ${Math.round(wasmMs)} ms, js ${Math.round(jsMs)} ms`)
    expect(wasmMs).toBeLessThan(jsMs)
    if (!process.env['COVERAGE']) expect(wasmMs).toBeLessThan(5000)
    const sph = sphereMesh(30, 6)
    t = performance.now(); const s = await decimateWasm(sph, { targetTriangles: 8000 }); const sMs = performance.now() - t
    console.log(`sphere 82k: wasm ${Math.round(sMs)} ms`)
    expect(measureMesh(s.mesh).watertight).toBe(true)
  })
})
