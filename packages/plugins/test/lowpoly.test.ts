import { describe, expect, it } from 'vitest'
import { Registry, addStep, assignSegment, emptyStepList, makeStep, measureMesh, operationParamsSchema, runFixtures, runWorkflow, segmentTable, sha256Hex, validateManifest } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'
import { boxMesh, sphereMesh } from '@ateliermesh/core/testing'
import Ajv from 'ajv/dist/2020'
import { LOWPOLY_PLUGIN_ID, LOWPOLY_PLUGIN_VERSION, corePlugin, crystallise, lowPoly, lowpolyFixtures, lowpolyManifest, lowpolyPlugin, orderHints, decimate } from '../src'
import { CORE_PLUGIN_ID, CORE_PLUGIN_VERSION } from '../src/core-plugin'
import { gridBox } from './parts'
import { mushroom, tBeam } from './shapes'

const registry = (): Registry => new Registry().register(corePlugin()).register(lowpolyPlugin())
const lp = (id: string, params: Record<string, unknown>) => makeStep({ id, plugin: { id: LOWPOLY_PLUGIN_ID, version: LOWPOLY_PLUGIN_VERSION }, op: 'low_poly', params: { triangles_mode: 'fixed', ...params } })
const run = (mesh: Mesh, params: Record<string, unknown>, signal?: AbortSignal) => runWorkflow(addStep(emptyStepList(), lp('l', params)), { registry: registry(), source: mesh, ...(signal ? { signal } : {}) })

/** A closed UV sphere with about nu * (2 * nv - 2) triangles, poles as fans. */
function uvSphere(r: number, nu: number, nv: number, bump = 0): Mesh {
  const pos: number[] = [], idx: number[] = []
  const rad = (a: number, b: number): number => r * (1 + bump * Math.sin(3 * a) * Math.cos(2 * b))
  pos.push(0, 0, rad(0, 0))
  for (let j = 1; j < nv; j++) for (let i = 0; i < nu; i++) {
    const th = (Math.PI * j) / nv, ph = (2 * Math.PI * i) / nu, q = rad(ph, th)
    pos.push(q * Math.sin(th) * Math.cos(ph), q * Math.sin(th) * Math.sin(ph), q * Math.cos(th))
  }
  pos.push(0, 0, -rad(0, Math.PI))
  const north = 0, south = 1 + (nv - 1) * nu, ring = (j: number, i: number): number => 1 + (j - 1) * nu + (i % nu)
  for (let i = 0; i < nu; i++) idx.push(north, ring(1, i), ring(1, i + 1))
  for (let j = 1; j < nv - 1; j++) for (let i = 0; i < nu; i++) { idx.push(ring(j, i), ring(j + 1, i), ring(j + 1, i + 1), ring(j, i), ring(j + 1, i + 1), ring(j, i + 1)) }
  for (let i = 0; i < nu; i++) idx.push(south, ring(nv - 1, i + 1), ring(nv - 1, i))
  return { positions: Float64Array.from(pos), indices: Uint32Array.from(idx) }
}

describe('org.ateliermesh.lowpoly', () => {
  it('has a valid manifest and a JSON Schema that agrees with the validator', () => {
    expect(validateManifest(lowpolyManifest).ok).toBe(true)
    const ajv = new Ajv({ strict: false })
    for (const op of lowpolyManifest.operations) {
      const ok = ajv.validate(operationParamsSchema(lowpolyManifest, op), Object.fromEntries(op.params.map(p => [p.name, p.default])))
      expect(ok, op.id).toBe(true)
    }
  })

  it('passes its conformance fixtures', async () => {
    const results = await runFixtures(lowpolyFixtures, { registry: registry() })
    expect(results.filter(r => !r.ok)).toEqual([])
  })

  it('stays a closed solid on a sphere, a mushroom, a T-beam and a dense box, and gets near the target', async () => {
    const shapes: Array<[string, Mesh, number]> = [['sphere', sphereMesh(20, 4), 800], ['mushroom', mushroom(96), 300], ['box', gridBox(30, 20, 10, 20, 14, 8), 100], ['t-beam', tBeam(10), 20]]
    for (const [name, m, target] of shapes) {
      const before = measureMesh(m)
      const r = await run(m, { triangles: target })
      expect(r.ok, name).toBe(true)
      const after = measureMesh(r.mesh!)
      expect(after.watertight, name).toBe(true)
      expect(after.triangles, name).toBeLessThanOrEqual(m.indices.length / 3)
      expect(after.triangles, name).toBeLessThanOrEqual(Math.max(target * 1.15, target + 8))
      expect(after.volume, name).toBeGreaterThan(0)
      // the outline stays where it was
      for (let k = 0; k < 3; k++) { expect(after.bbox.min[k]!).toBeGreaterThan(before.bbox.min[k]! - 0.25); expect(after.bbox.max[k]!).toBeLessThan(before.bbox.max[k]! + 0.25) }
    }
  })

  it('keeps the eight corners of a box', async () => {
    const box = gridBox(30, 20, 10, 20, 14, 8)
    const r = await run(box, { triangles: 100 })
    const P = r.mesh!.positions
    for (const x of [-15, 15]) for (const y of [-10, 10]) for (const z of [0, 10]) {
      let best = Infinity
      for (let v = 0; v < P.length; v += 3) best = Math.min(best, Math.hypot(P[v]! - x, P[v + 1]! - y, P[v + 2]! - z))
      expect(best, `corner ${x},${y},${z}`).toBeLessThan(1e-6)
    }
    // a box has nothing but flat faces: the result is as flat as the input and has the same volume
    expect(measureMesh(r.mesh!).volume).toBeCloseTo(6000, 3)
  })

  it('reaches 2000 triangles on a 30 000 triangle sphere within 10 percent of the volume', async () => {
    const sph = uvSphere(20, 125, 121)
    expect(sph.indices.length / 3).toBe(30000)
    const t0 = performance.now()
    const r = await run(sph, { triangles: 2000 })
    const ms = performance.now() - t0
    expect(r.ok).toBe(true)
    const rep = r.results[0]!.report as Record<string, number>
    expect(Math.abs(rep['triangles_after']! - 2000)).toBeLessThan(60)
    expect(Math.abs(rep['volume_change_percent']!)).toBeLessThan(10)
    expect(measureMesh(r.mesh!).watertight).toBe(true)
    console.log(`low poly 30k -> ${rep['triangles_after']} triangles in ${Math.round(ms)} ms, volume ${rep['volume_change_percent']} %, moved ${rep['moved']}`)
  })

  it('does 128 000 triangles to 2000 in a few seconds', async () => {
    const big = uvSphere(25, 200, 321)
    expect(big.indices.length / 3).toBe(128000)
    const t0 = performance.now()
    const r = await run(big, { triangles: 2000 })
    const ms = performance.now() - t0
    expect(r.ok).toBe(true)
    console.log(`low poly 128k -> ${r.results[0]!.report!['triangles_after']} triangles in ${Math.round(ms)} ms`)
    expect(ms).toBeLessThan(15000)
  })

  it('crystallise 0 is the plain collapse; more moves vertices a little, never folds, never opens', async () => {
    const lump = uvSphere(20, 90, 60, 0.06)
    const plain = (await run(lump, { triangles: 600, crystallise: 0 })).mesh!
    const crisp = (await run(lump, { triangles: 600, crystallise: 1 })).mesh!
    expect(crisp.indices).toEqual(plain.indices)
    let moved = 0, worst = 0
    for (let i = 0; i < plain.positions.length; i += 3) { const d = Math.hypot(plain.positions[i]! - crisp.positions[i]!, plain.positions[i + 1]! - crisp.positions[i + 1]!, plain.positions[i + 2]! - crisp.positions[i + 2]!); if (d > 1e-9) moved++; worst = Math.max(worst, d) }
    expect(moved).toBeGreaterThan(0)
    expect(worst).toBeLessThan(3)
    const m = measureMesh(crisp)
    expect(m.watertight).toBe(true)
    expect(m.volume).toBeGreaterThan(0)
    // every face still points the way it did
    const a = measureMesh(plain)
    expect(Math.abs(m.volume - a.volume) / a.volume).toBeLessThan(0.1)
  })

  it('snaps a rounded corner back to the corner of the original', () => {
    // the original is a cube; the "result" has its first corner pulled in; crystallise puts it back on the cube
    const cube = gridBox(10, 10, 10, 2, 2, 2)
    const out: Mesh = { positions: Float64Array.from(cube.positions), indices: cube.indices }
    let v = -1
    for (let i = 0; i < out.positions.length; i += 3) if (out.positions[i] === -5 && out.positions[i + 1] === -5 && out.positions[i + 2] === 0) v = i
    expect(v).toBeGreaterThanOrEqual(0)
    out.positions[v] = -4.6; out.positions[v + 1] = -4.6; out.positions[v + 2] = 0.4
    const r = crystallise(cube, out, { amount: 1, sharpness: 40, keepBorders: true })
    const d = Math.hypot(r.mesh.positions[v]! + 5, r.mesh.positions[v + 1]! + 5, r.mesh.positions[v + 2]!)
    expect(d).toBeLessThan(Math.hypot(0.4, 0.4, 0.4))
    expect(r.moved).toBeGreaterThan(0)
  })

  it('keeps bodies and segments', async () => {
    const a = sphereMesh(10, 4), b = boxMesh(10, 10, 10)
    const na = a.indices.length / 3, nb = b.indices.length / 3
    const off = a.positions.length / 3
    const both: Mesh = {
      positions: Float64Array.from([...a.positions, ...b.positions.map((x, i) => (i % 3 === 0 ? x + 40 : x))]),
      indices: Uint32Array.from([...a.indices, ...Array.from(b.indices, i => i + off)]),
      groups: [{ start: 0, count: na, role: 'solid', name: 'ball' }, { start: na, count: nb, role: 'solid', name: 'cube' }],
    }
    const flags = new Uint8Array(na + nb); for (let i = 0; i < na / 2; i++) flags[i] = 1
    const marked = assignSegment(both, 'top', flags)
    const r = await run(marked, { triangles: 300 })
    expect(r.ok).toBe(true)
    const out = r.mesh!
    expect(out.groups!.map(g => g.name)).toEqual(['ball', 'cube'])
    expect(out.groups![1]!.start).toBe(out.groups![0]!.count)
    expect(out.groups!.reduce((s, g) => s + g.count, 0)).toBe(out.indices.length / 3)
    for (const g of out.groups!) expect(measureMesh({ positions: out.positions, indices: out.indices.slice(3 * g.start, 3 * (g.start + g.count)) }).watertight).toBe(true)
    expect(segmentTable(out).map(s => s.name)).toEqual(['body', 'top'])
    expect(new Set(out.segments!.labels)).toEqual(new Set([0, 1]))
    expect(out.groups![0]!.count).toBeLessThan(na)
  })

  it('is deterministic', async () => {
    const m = uvSphere(15, 100, 80, 0.05)
    const h = async (): Promise<string> => { const r = await run(m, { triangles: 700 }); return sha256Hex(new Uint8Array(r.mesh!.positions.buffer.slice(0))) + sha256Hex(new Uint8Array(r.mesh!.indices.buffer.slice(0))) }
    expect(await h()).toBe(await h())
  })

  it('returns a model with fewer triangles than the target unchanged, with a warning', async () => {
    const m = sphereMesh(10, 2)
    const r = await run(m, { triangles: 5000 })
    expect(r.ok).toBe(true)
    expect(r.mesh).toBe(m)
    expect(r.results[0]!.warnings!.map(w => w.code)).toEqual(['lowpoly.already_smaller'])
  })

  it('says so when the bodies need more triangles than the target allows', async () => {
    // eight separate bodies need at least a few triangles each, so a target of 12 cannot be met
    const ball = sphereMesh(5, 3), n = ball.indices.length / 3, nv = ball.positions.length / 3
    const pos: number[] = [], idx: number[] = [], groups: NonNullable<Mesh['groups']> = []
    for (let k = 0; k < 8; k++) {
      for (let i = 0; i < ball.positions.length; i += 3) pos.push(ball.positions[i]! + 20 * k, ball.positions[i + 1]!, ball.positions[i + 2]!)
      for (const i of ball.indices) idx.push(i + k * nv)
      groups.push({ start: k * n, count: n, role: 'solid', name: `b${k}` })
    }
    const r = await run({ positions: Float64Array.from(pos), indices: Uint32Array.from(idx), groups }, { triangles: 12 })
    expect(r.ok).toBe(true)
    expect(measureMesh(r.mesh!).watertight).toBe(true)
    const w = r.results[0]!.warnings!.find(x => x.code === 'lowpoly.target_not_reached')
    expect(w).toBeDefined()
    expect(w!.params).toMatchObject({ target: 12 })
  })

  it('refuses input that makes no sense, with a code', async () => {
    const bad = await run({ positions: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: Uint32Array.from([0, 1, 2]) }, { triangles: 12 })
    expect(bad.ok).toBe(false)
    expect(bad.results[0]!.error!.code).toBe('lowpoly.bad_input')
    const nan = await run({ ...sphereMesh(5, 3), positions: Float64Array.from([NaN, ...sphereMesh(5, 3).positions.slice(1)]) }, { triangles: 100 })
    expect(nan.results[0]!.error!.code).toBe('lowpoly.bad_input')
  })

  it('can be cancelled', async () => {
    const ac = new AbortController(); ac.abort()
    await expect(lowPoly(uvSphere(10, 100, 80), { triangles: 500, sharpness: 40, crystallise: 0.5, keepBorders: true, signal: ac.signal })).rejects.toMatchObject({ code: 'run.cancelled' })
  })

  it('is hinted to go above the text steps, like decimate', () => {
    const text = makeStep({ id: 't', plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op: 'emboss', params: {} })
    const hints = orderHints([text, lp('l', {})].reduce((l, s) => addStep(l, s), emptyStepList()))
    expect(hints).toEqual([expect.objectContaining({ step: 'l', code: 'decimate_after_text', fix: { id: 'l', to: 0 } })])
  })

  it('reuses the decimator: crystallise 0 gives exactly the decimated mesh', async () => {
    const sph = sphereMesh(20, 4)
    const plain = decimate(sph, { targetTriangles: 800, creaseAngle: 40 })
    const r = await lowPoly(sph, { triangles: 800, sharpness: 40, crystallise: 0, keepBorders: true, engine: 'js' })
    expect(Array.from(r.mesh.positions)).toEqual(Array.from(plain.mesh.positions))
  })

  describe('automatic triangle count', () => {
    const auto = (mesh: Mesh, detail: number, more: Record<string, unknown> = {}) => run(mesh, { triangles_mode: 'auto', detail, ...more })
    const diag = (m: Mesh): number => { const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < m.positions.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, m.positions[i + k]!); hi[k] = Math.max(hi[k]!, m.positions[i + k]!) } return Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) }
    const tol = (m: Mesh, d: number): number => diag(m) * (0.08 * (1 - d) * (1 - d) + 0.002)
    const radialDeviation = (m: Mesh, r: number): number => { let worst = 0; for (let i = 0; i < m.positions.length; i += 3) worst = Math.max(worst, Math.abs(Math.hypot(m.positions[i]!, m.positions[i + 1]!, m.positions[i + 2]!) - r)); return worst }

    it('picks fewer triangles for a coarser detail, and both stay within the tolerance (30 000 triangle sphere)', async () => {
      const sph = uvSphere(20, 125, 121)
      const coarse = await auto(sph, 0.2), fine = await auto(sph, 0.8)
      expect(coarse.ok && fine.ok).toBe(true)
      const nc = coarse.results[0]!.report!['triangles_after'] as number, nf = fine.results[0]!.report!['triangles_after'] as number
      console.log(`auto 30k sphere: detail 0.2 -> ${nc} triangles (tolerance ${tol(sph, 0.2).toFixed(2)} mm), detail 0.8 -> ${nf} (${tol(sph, 0.8).toFixed(3)} mm)`)
      expect(nc).toBeLessThan(nf)
      expect(radialDeviation(coarse.mesh!, 20)).toBeLessThanOrEqual(tol(sph, 0.2) * 1.5)
      expect(radialDeviation(fine.mesh!, 20)).toBeLessThanOrEqual(tol(sph, 0.8) * 1.5)
      expect(measureMesh(coarse.mesh!).watertight && measureMesh(fine.mesh!).watertight).toBe(true)
      const rep = coarse.results[0]!.report as Record<string, unknown>
      expect(rep['mode']).toBe('auto'); expect(rep['chosen_triangles']).toBe(nc); expect(rep['tolerance']).toBeCloseTo(tol(sph, 0.2), 2)
    }, 60000)

    it('takes a box down to 12 triangles', async () => {
      for (const box of [boxMesh(30, 20, 10), gridBox(40, 20, 20, 40, 20, 20)]) {
        const r = await auto(box, 0.5)
        expect(r.ok).toBe(true)
        expect(r.results[0]!.report!['triangles_after']).toBe(12)
        expect(measureMesh(r.mesh!).watertight).toBe(true)
      }
    })

    it('never gives more triangles for a lower detail', async () => {
      const bumpy = uvSphere(20, 80, 60, 0.06)
      const counts: number[] = []
      for (const d of [0, 0.25, 0.5, 0.75, 1]) counts.push((await auto(bumpy, d)).results[0]!.report!['triangles_after'] as number)
      console.log(`auto bumpy sphere, detail 0 .25 .5 .75 1 -> ${counts.join(', ')} triangles`)
      for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeGreaterThanOrEqual(counts[i - 1]!)
      expect(counts[4]!).toBeGreaterThan(counts[0]! * 2)
    }, 60000)

    it('keeps a step stored before the setting existed as a fixed count, with the same result as before', async () => {
      const sph = uvSphere(20, 60, 40)
      const old = makeStep({ id: 'o', plugin: { id: LOWPOLY_PLUGIN_ID, version: '0.1.0' }, op: 'low_poly', params: { triangles: 600, sharpness: 40, crystallise: 0.5, keep_borders: true } })
      const migrated = await runWorkflow(addStep(emptyStepList(), old), { registry: registry(), source: sph })
      const fixed = await run(sph, { triangles: 600 })
      expect(migrated.ok).toBe(true)
      expect(migrated.results[0]!.report!['mode']).toBe('fixed')
      expect(migrated.results[0]!.migratedFrom).toBe('0.1.0')
      expect(sha256Hex(new Uint8Array(migrated.mesh!.positions.buffer))).toBe(sha256Hex(new Uint8Array(fixed.mesh!.positions.buffer)))
      expect(migrated.results[0]!.report!['triangles_after']).toBe(fixed.results[0]!.report!['triangles_after'])
    })

    it('is deterministic and ignores the fixed count', async () => {
      const sph = uvSphere(20, 80, 60, 0.03)
      const a = await auto(sph, 0.5), b = await auto(sph, 0.5, { triangles: 50 })
      expect(sha256Hex(new Uint8Array(a.mesh!.positions.buffer))).toBe(sha256Hex(new Uint8Array(b.mesh!.positions.buffer)))
    })

    it('stays close to the time of the fixed mode on 128 000 triangles', async () => {
      const big = uvSphere(25, 200, 321)
      const t0 = performance.now(); const f = await run(big, { triangles: 2000 }); const tf = performance.now() - t0
      const t1 = performance.now(); const a = await auto(big, 0.5); const ta = performance.now() - t1
      expect(f.ok && a.ok).toBe(true)
      console.log(`low poly 128k: fixed 2000 -> ${f.results[0]!.report!['triangles_after']} in ${Math.round(tf)} ms; auto (detail 0.5) -> ${a.results[0]!.report!['triangles_after']} in ${Math.round(ta)} ms (x${(ta / tf).toFixed(2)})`)
      expect(ta).toBeLessThan(tf * 3 + 500)
    }, 120000)
  })
})
