import { describe, expect, it } from 'vitest'
import { Registry, addStep, emptyStepList, makeStep, measureMesh, runWorkflow } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'
import { lBracketMesh, sphereMesh } from '@ateliermesh/core/testing'
import { CORE_PLUGIN_ID, CORE_PLUGIN_VERSION, corePlugin, expandRuns, overhangForUp } from '../src'
import type { Candidate } from '../src'
import { mushroom, polygonArea, tBeam } from './shapes'
import { boxMesh } from '@ateliermesh/core/testing'
const cubeMesh = (): Mesh => boxMesh(10, 10, 10)

const registry = (): Registry => new Registry().register(corePlugin())
const st = (id: string, op: string, params: Record<string, unknown> = {}) => makeStep({ id, plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op, params })
const run = (mesh: Mesh, ...steps: ReturnType<typeof st>[]) => runWorkflow(steps.reduce((l, s) => addStep(l, s), emptyStepList()), { registry: registry(), source: mesh })

describe('the test parts are what they claim', () => {
  it('T-beam and mushroom are closed with the expected volume', () => {
    const t = measureMesh(tBeam(50))
    expect(t.watertight).toBe(true); expect(t.volume).toBeCloseTo(50 * (40 * 10 + 10 * 20), 6)
    const m = measureMesh(mushroom())
    expect(m.watertight).toBe(true)
    expect(m.volume).toBeCloseTo(polygonArea(5) * 20 + polygonArea(20) * 5, 3)
  })
})

describe('overhang', () => {
  it('matches hand-computed areas for known orientations', () => {
    const T = tBeam(50)
    expect(overhangForUp(T, [0, 0, 1], 45).area).toBeCloseTo(30 * 50, 9)      // stem down: the bar's underside, 2 x 15 x 50
    expect(overhangForUp(T, [0, 0, -1], 45).area).toBeCloseTo(0, 9)           // bar down: nothing hangs
    expect(overhangForUp(T, [0, 0, 1], 45).bed_area).toBeCloseTo(10 * 50, 9)  // the stem's end sits on the bed, not an overhang
    const M = mushroom()
    expect(overhangForUp(M, [0, 0, 1], 45).area).toBeCloseTo(polygonArea(20) - polygonArea(5), 6)
    expect(overhangForUp(M, [0, 0, -1], 45).area).toBeCloseTo(0, 9)
  })
  it('the angle decides, and a face exactly at the limit is fine', () => {
    // a 10 mm cube tipped 30 degrees about y: its underside is 60 degrees from vertical, the face on the -x side 30 degrees
    const t = Math.PI / 6
    const up: [number, number, number] = [Math.sin(t), 0, Math.cos(t)]
    const c = cubeMesh()
    expect(overhangForUp(c, up, 45).area).toBeCloseTo(100, 9)     // -z face: 60 degrees from vertical, over the 45 limit
    expect(overhangForUp(c, up, 20).area).toBeCloseTo(200, 9)     // the -x face (30 degrees) counts too
    expect(overhangForUp(c, up, 60).area).toBeCloseTo(0, 9)       // exactly at the limit: no support needed
    expect(overhangForUp(c, up, 59).area).toBeCloseTo(100, 9)
  })
  it('the analyzer reports area, share and flagged triangles, and does not change the mesh', async () => {
    const T = tBeam(50)
    const r = await run(T, st('o', 'overhang'))
    const rep = r.results[0]!.report!
    expect(rep['area']).toBeCloseTo(1500, 9)
    expect(rep['share'] as number).toBeCloseTo(1500 / (rep['surface'] as number), 12)
    const tris = expandRuns(rep['flagged_runs'] as Array<[number, number]>)
    expect(tris.length).toBe(rep['triangles'])
    expect(r.mesh).toBe(T) // passed through untouched
  })
})

const orient = async (mesh: Mesh, goal: string) => {
  const r = await run(mesh, st('a', 'auto_orient', { goal }))
  const rep = r.results[0]!.report! as { candidates: Candidate[]; winner: number; rotate: { angles: number[]; order: string; pivot: string } }
  return rep
}

describe('auto_orient', () => {
  it('picks the hand-computed best for each goal (T-beam)', async () => {
    const T = tBeam(50)
    // candidates: stem down (overhang 1500, height 30, base 500), bar down (0, 30, 2000), lying on y (0, 50, 600), on its end (x down): height 40
    for (const goal of ['min_support', 'min_height', 'max_stability']) {
      const rep = await orient(T, goal)
      const w = rep.candidates[rep.winner]!
      expect(w.overhang_area, goal).toBeCloseTo(0, 6)
      expect(w.height, goal).toBeCloseTo(30, 6)
      expect(w.base_area, goal).toBeCloseTo(2000, 6)
    }
    const rep = await orient(T, 'min_support')
    expect(rep.candidates.length).toBeGreaterThanOrEqual(6)
    expect(rep.candidates.find(c => Math.abs(c.overhang_area - 1500) < 1e-6 && Math.abs(c.height - 30) < 1e-6)).toBeTruthy()  // stem down is among the candidates
  })

  it('goals can disagree: min_height prefers the lowest, max_stability the widest base (L-bracket)', async () => {
    const L = lBracketMesh()
    const h = await orient(L, 'min_height')
    expect(h.candidates[h.winner]!.height).toBeCloseTo(10, 6)
    const s = await orient(L, 'max_stability')
    expect(s.candidates[s.winner]!.base_area).toBeCloseTo(600, 6)   // an L face: 40*20 - 20*10 = 600
  })

  it('mushroom: cap down has no overhang', async () => {
    const rep = await orient(mushroom(), 'min_support')
    expect(rep.candidates[rep.winner]!.overhang_area).toBeCloseTo(0, 6)
    expect(rep.candidates[rep.winner]!.height).toBeCloseTo(25, 6)
  })

  it('applying the reported rotate step reproduces the reported figures; overhang and auto_orient agree', async () => {
    // a tilted copy first, so the winner needs a real rotation, not a multiple of 90 degrees
    const tilted = (await run(tBeam(50), st('t', 'rotate', { angles: [23, -17, 41], pivot: 'origin' }))).mesh!
    const rep = await orient(tilted, 'min_support')
    const w = rep.candidates[rep.winner]!
    expect(w.overhang_area).toBeCloseTo(0, 6)
    const after = await run(tilted, st('r', 'rotate', rep.rotate), st('o', 'overhang'))
    const o = after.results[1]!.report!
    expect(o['area'] as number).toBeCloseTo(w.overhang_area, 6)
    expect(o['height'] as number).toBeCloseTo(w.height, 6)
    expect(o['bed_area'] as number).toBeCloseTo(w.base_area, 6)
    // and for every candidate, rotating by its angles gives the same figures as the report
    for (const c of rep.candidates) {
      const rr = await run(tilted, st('r', 'rotate', { angles: c.angles, order: 'XYZ', pivot: 'bbox_center' }), st('o', 'overhang'))
      expect(rr.results[1]!.report!['area'] as number, JSON.stringify(c.up)).toBeCloseTo(c.overhang_area, 6)
      expect(rr.results[1]!.report!['height'] as number).toBeCloseTo(c.height, 6)
    }
  })

  it('refuses a mesh over the triangle budget with a clear code', async () => {
    const r = await runWorkflow(addStep(emptyStepList(), st('a', 'auto_orient')), { registry: registry(), source: sphereMesh(10, 4), limits: { maxTriangles: 1000 } }).catch(e => e)
    expect(r).toMatchObject({ code: 'budget.triangles' })
  })

  it('needs a mesh', async () => {
    const r = await runWorkflow(addStep(emptyStepList(), st('a', 'overhang')), { registry: registry() })
    expect(r.results[0]!.error?.code).toBe('input.missing_mesh')
  })
})

describe('orient (the modifier: turns the model and puts it on the bed)', () => {
  it('turns a T-beam stem-down into the least-support position and puts it on the bed', async () => {
    const T = tBeam(50)
    // start in the worst way up (bar underneath is fine; stem down needs support): tip it so it lies on its side
    const tipped = await run(T, st('r', 'rotate', { angles: [90, 0, 0] }), st('o', 'orient', { goal: 'min_support' }))
    expect(tipped.ok).toBe(true)
    const mesh = tipped.mesh!
    const rep = tipped.results[1]!.report! as { overhang_area: number; lifted_by: number }
    // the result's real overhang equals what the report says, and is the smallest of the candidates (bar down: nothing hangs)
    expect(overhangForUp(mesh, [0, 0, 1], 45).area).toBeCloseTo(rep.overhang_area, 6)
    expect(rep.overhang_area).toBeCloseTo(0, 6)
    const m = measureMesh(mesh)
    expect(m.watertight).toBe(true)
    expect(m.volume).toBeCloseTo(measureMesh(T).volume, 6)         // only turned and moved
    let zmin = Infinity; for (let i = 2; i < mesh.positions.length; i += 3) zmin = Math.min(zmin, mesh.positions[i] as number)
    expect(zmin).toBeCloseTo(0, 9)                                  // on the bed
  })
  it('keeps the place when asked not to put the model on the bed, and does nothing to a model that is already right', async () => {
    const T = tBeam(50)
    const r = await run(T, st('o', 'orient', { goal: 'min_support', place_on_bed: false }))
    const rep = r.results[0]!.report! as { turned: boolean; lifted_by: number }
    expect(rep.lifted_by).toBe(0)
    const again = await run(r.mesh!, st('o', 'orient', { goal: 'min_support', place_on_bed: true }))
    expect((again.results[0]!.report as { turned: boolean }).turned).toBe(false)
  })
  it('is deterministic', async () => {
    const a = await run(mushroom(), st('o', 'orient', { goal: 'min_height' }))
    const b = await run(mushroom(), st('o', 'orient', { goal: 'min_height' }))
    expect(Array.from(a.mesh!.positions)).toEqual(Array.from(b.mesh!.positions))
  })
})
