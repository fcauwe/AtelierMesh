import { describe, expect, it } from 'vitest'
import { addStep, emptyStepList, makeStep, runWorkflow, Registry } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'
import { boxMesh } from '@ateliermesh/core/testing'
import { describeProblem } from '@ateliermesh/ui'
import { corePlugin, printCheck, printcheckPlugin, PRINTCHECK_PLUGIN_ID } from '../src'
import type { PrintCheckOptions, PrintCheckResult } from '../src'
import { sphere } from '../src/samples'
import { lathe, mushroom, prism, tBeam } from './shapes'

const base: PrintCheckOptions = { process: 'fdm', nozzle: 0.4, layerHeight: 0.2, minWall: 0, minFeature: 0, minGap: 0, overhangAngle: 45, bridgeLength: 10, bed: [220, 220, 250], quality: 'export' }
const check = (m: Mesh, o: Partial<PrintCheckOptions> = {}): PrintCheckResult => printCheck(m, { ...base, ...o })
const find = (r: PrintCheckResult, name: string) => r.findings.find(f => f.name === name)!
const NEW = ['floating_body', 'island', 'overhang', 'bridge']
const quiet = (r: PrintCheckResult, names: string[] = NEW): void => { for (const n of names) expect(find(r, n).severity, n).toBe('ok') }

/** A box whose lowest point is at z = 0. */
const onBed = (w: number, d: number, h: number): Mesh => { const b = boxMesh(w, d, h); let lo = Infinity; for (let i = 2; i < b.positions.length; i += 3) lo = Math.min(lo, b.positions[i] as number); return { ...b, positions: Float64Array.from(b.positions, (v, i) => (i % 3 === 2 ? v - lo : v)) } }
const move = (m: Mesh, dx: number, dy: number, dz: number): Mesh => ({ ...m, positions: Float64Array.from(m.positions, (v, i) => v + (i % 3 === 0 ? dx : i % 3 === 1 ? dy : dz)) })
const join = (a: Mesh, b: Mesh): Mesh => {
  const nv = a.positions.length / 3
  return { positions: Float64Array.from([...a.positions, ...b.positions]), indices: Uint32Array.from([...a.indices, ...Array.from(b.indices, v => v + nv)]) }
}

/** An arch (Pi) on two feet: legs 6 wide, the gap between them `gap`, a deck 5 thick on top; `rightFoot` is the height where the right leg starts. */
const arch = (gap: number, rightFoot = 0, depth = 40): Mesh => prism([[0, 0], [6, 0], [6, 20], [6 + gap, 20], [6 + gap, rightFoot], [12 + gap, rightFoot], [12 + gap, 25], [0, 25]], depth)
/** A post with an arm on top (an inverted L): the arm's underside sticks out 20 mm. */
const invertedL = (depth = 40): Mesh => prism([[0, 0], [5, 0], [5, 25], [25, 25], [25, 30], [0, 30]], depth)
/** A hook: a post, an arm over the top, and a tip that points down again and stops in the air at z 15. */
const hook = (): Mesh => prism([[0, 0], [5, 0], [5, 25], [20, 25], [20, 15], [25, 15], [25, 30], [0, 30]], 40)
/** A block whose left wall leans out over the plate by `deg` degrees from vertical, 20 mm high. */
const leaning = (deg: number): Mesh => { const d = 20 * Math.tan((deg * Math.PI) / 180); return prism([[10, 0], [30, 0], [30, 20], [10 - d, 20]], 40) }
const vase = (): Mesh => lathe([[0, 0], [8, 0], [9, 5], [11, 15], [12, 25], [11, 35], [9, 40], [0, 40]])

describe('printcheck: parts that start in mid-air', () => {
  it('a cube on the plate and a vase have no new finding; a ball on its pole only needs support below', () => {
    for (const m of [onBed(30, 30, 30), vase()]) quiet(check(m))
    expect(check(onBed(30, 30, 30)).score).toBe(100)
    const ball = check(sphere(15, 3))
    quiet(ball, ['floating_body', 'island', 'bridge'])           // no spurious island at the pole
    expect(find(ball, 'overhang').severity).toBe('warning')       // the lower cap leans over more than 45 degrees
  })

  it('an arch on two feet is fine over a 4 mm gap and a bridge over a 15 mm gap', () => {
    quiet(check(arch(4)))
    const r = check(arch(15))
    const f = find(r, 'bridge')
    expect(f.severity).toBe('warning'); expect(f.value).toBeGreaterThan(14); expect(f.value).toBeLessThan(16); expect(f.triangles!.length).toBeGreaterThan(0)
    expect(find(r, 'island').severity).toBe('ok'); expect(find(r, 'floating_body').severity).toBe('ok')
    expect(find(check(arch(15), { bridgeLength: 20 }), 'bridge').severity).toBe('ok')
    expect(r.verdict).toBe('fix_recommended')
  })

  it('a T-beam stem down is an overhang with its area, and the advice is to turn it', () => {
    const r = check(tBeam(50))
    const f = find(r, 'overhang')
    expect(f.severity).toBe('warning'); expect(f.value).toBeCloseTo(1500, 0); expect(f.count).toBe(2)
    expect(f.params['largest']).toBeCloseTo(750, 0); expect(f.params['height']).toBe(20)
    expect(f.params['turn']).toBe(1); expect(f.params['from_area']).toBe(1500); expect(f.params['to_area']).toBe(0)
    expect(find(r, 'bridge').severity).toBe('ok')
  })

  it('a mushroom has a ring-shaped overhang, an inverted L is flat-turned', () => {
    const f = find(check(mushroom(96)), 'overhang')
    expect(f.severity).toBe('warning'); expect(f.count).toBe(1); expect(f.params['turn']).toBe(1)
    const l = find(check(invertedL()), 'overhang')
    expect(l.severity).toBe('warning'); expect(l.value).toBeCloseTo(800, 0)
    expect(l.params['from_area']).toBeCloseTo(800, 0); expect(l.params['to_area']).toBe(0)                                                   // arm down: nothing hangs
    expect(Math.abs(l.params['turn_x'] as number) + Math.abs(l.params['turn_y'] as number) + Math.abs(l.params['turn_z'] as number)).toBeGreaterThan(0)
    expect(find(check(invertedL()), 'island').severity).toBe('ok')
  })

  it('a 45 degree wedge is fine, a steeper lean is flagged, and a small overhang is left out', () => {
    quiet(check(leaning(40)))
    quiet(check(leaning(45)))
    const f = find(check(leaning(55)), 'overhang')
    expect(f.severity).toBe('warning'); expect(f.value).toBeGreaterThan(900)
    expect(find(check(leaning(55), { overhangAngle: 60 }), 'overhang').severity).toBe('ok')           // the angle is the existing parameter
    expect(find(check(leaning(55), { minOverhangArea: 5000 }), 'overhang').severity).toBe('ok')
    expect(find(check(prism([[10, 0], [30, 0], [30, 4], [10 - 4 * Math.tan(1), 4]], 2)), 'overhang').severity).toBe('ok')     // a few mm2
  })

  it('a separate body that floats above the plate is an error; one that rests on another body is not', () => {
    const base_ = onBed(30, 30, 5)
    const next = join(base_, move(onBed(10, 10, 10), 40, 0, 5))                 // beside the base, 5 mm up
    const r = check(next)
    const f = find(r, 'floating_body')
    expect(f.severity).toBe('error'); expect(f.count).toBe(1); expect(f.value).toBeCloseTo(5, 1); expect(f.triangles!.length).toBeGreaterThan(0)
    expect(r.verdict).toBe('not_printable')
    expect(find(check(join(base_, move(onBed(10, 10, 10), 0, 0, 5))), 'floating_body').severity).toBe('ok')            // on top of the base
    expect(find(check(join(base_, move(onBed(10, 10, 10), 0, 0, 10))), 'floating_body').count).toBe(1)                 // 5 mm over the base
    expect(find(check(join(base_, move(onBed(10, 10, 10), 0, 0, 5.2))), 'floating_body').severity).toBe('ok')          // 0.2 mm: the gap fuses
    expect(find(check(join(base_, move(onBed(10, 10, 10), 40, 0, 0))), 'floating_body').severity).toBe('ok')           // beside, on the plate
    expect(find(check(join(base_, move(onBed(10, 10, 10), 5, 5, 2))), 'floating_body').severity).toBe('ok')            // sunk into the base
    expect(find(check(join(base_, move(onBed(10, 10, 10), 40, 0, 5))), 'island').severity).toBe('ok')                   // reported as a body, not twice
  })

  it('a part of one connected model that starts in the air is an island (arm that starts high, a hook), not a bridge', () => {
    const r = check(arch(15, 8))
    const f = find(r, 'island')
    expect(f.severity).toBe('error'); expect(f.count).toBe(1); expect(f.params['height']).toBe(8); expect(f.params['area']).toBeCloseTo(240, 0); expect(f.triangles!.length).toBeGreaterThan(0)
    expect(r.verdict).toBe('not_printable')
    const h = find(check(hook()), 'island')
    expect(h.severity).toBe('error'); expect(h.params['height']).toBe(15); expect(h.params['area']).toBeCloseTo(200, 0)
    // the same arch with both feet on the plate has none
    expect(find(check(arch(15)), 'island').severity).toBe('ok')
  })

  it('a thin tip that starts in the air is a warning, not an error', () => {
    const spike = prism([[0, 0], [5, 0], [5, 25], [19.2, 25], [19.2, 15], [20, 15], [20, 30], [0, 30]], 1)
    const f = find(check(spike), 'island')
    expect(f.severity).toBe('warning'); expect(f.params['tips']).toBe(1)
  })

  it('is deterministic and does not touch the old findings', () => {
    const m = arch(15, 8)
    const strip = (r: PrintCheckResult): unknown => ({ ...r, ms: 0 })
    expect(strip(check(m))).toEqual(strip(check(m)))
    const r = check(onBed(30, 30, 30))
    expect(r.findings.map(f => f.name)).toEqual(expect.arrayContaining(['not_closed', 'islands', 'thin_walls', 'needs_support', 'long_bridges', 'tiny_base', 'too_tall', 'too_big_for_bed', 'needles', 'detail', ...NEW]))
    expect(r.thresholds.min_overhang_area).toBe(20)
  })

  it('a step from before (no min_overhang_area) still runs, and gives the new findings', async () => {
    const reg = new Registry().register(corePlugin()).register(printcheckPlugin())
    const step = makeStep({ id: 'p', plugin: { id: PRINTCHECK_PLUGIN_ID, version: '0.1.0' }, op: 'printability', params: { min_wall: 0.8 } })
    const out = await runWorkflow(addStep(emptyStepList(), step), { registry: reg, source: arch(15, 8), quality: 'export' })
    expect(out.ok).toBe(true)
    const rep = out.results[0]!.report as unknown as PrintCheckResult
    expect(find(rep, 'island').severity).toBe('error')
    expect((out.results[0]!.warnings ?? []).some(w => w.code === 'printcheck.island')).toBe(true)
  })

  it('has texts for its codes: a non-blocking warning, and a text with the numbers when a turn is suggested', () => {
    const r = check(tBeam(50))
    const f = find(r, 'overhang')
    const v = describeProblem(f.code, f.params as Record<string, unknown>)
    expect(v.kind).toBe('warning'); expect(v.blocks).toBe(false); expect(v.key).toBe('mesh.printcheck.overhang_turn'); expect(v.values).toMatchObject({ from_area: 1500, to_area: 0 })
    expect(describeProblem('printcheck.island', { turn: 0, height: 8 }).key).toBe('mesh.printcheck.island')
    expect(describeProblem('printcheck.floating_body', { bodies: 1 }).key).toBe('mesh.printcheck.floating_body')
    expect(describeProblem('printcheck.bridge', { turn: 1 }).key).toBe('mesh.printcheck.bridge_turn')
  })

  it('stays quick on a 200 000 triangle mesh', () => {
    const big = sphere(25, 7)
    expect(big.indices.length / 3).toBeGreaterThan(200000)
    const t = Date.now()
    const r = check(big, { quality: 'preview' })
    const ms = Date.now() - t
    quiet(r, ['floating_body', 'island', 'bridge'])
    expect(ms).toBeLessThan(12000)
    const t2 = Date.now()
    check(move(arch(15, 8), 0, 0, 0), { quality: 'preview' })
    expect(Date.now() - t2).toBeLessThan(2000)
  })

  it('the floor of a pocket and a thin raised lip are not a start in mid-air (a boat with a hollow hull and raised letters)', () => {
    // a block with a pocket in the top: the pocket floor is a minimum of the surface, but the material is below it
    const pocket = prism([[0, 0], [40, 0], [40, 25], [30, 25], [30, 8], [10, 8], [10, 25], [0, 25]], 40)
    expect(find(check(pocket), 'island').severity).toBe('ok')
    // the same block with a deep hollow inside (a closed cavity: its floor and its ceiling)
    const hollow = join(onBed(40, 40, 30), move(onBed(10, 10, 10), 60, 0, 0))
    expect(find(check(hollow), 'island').severity).toBe('ok')
    // a 0.4 mm strip that sticks out of a wall at 10 mm height, 30 mm long: its underside is a lip over the wall below, not a start in the air
    const wall = onBed(30, 4, 40)
    const lip = move(onBed(30, 0.4, 3), 0, -2.2, 10)
    const r = check(join(wall, lip))
    expect(find(r, 'island').severity).toBe('ok')
  })
})
