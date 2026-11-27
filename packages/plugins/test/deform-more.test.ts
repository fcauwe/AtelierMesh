import { describe, expect, it } from 'vitest'
import { Registry, addStep, assignSegment, emptyStepList, makeStep, measureMesh, runFixtures, runWorkflow, sha256Hex, validateManifest, validateParams } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'
import { boxMesh } from '@ateliermesh/core/testing'
import { DEFORM_PLUGIN_ID, DEFORM_PLUGIN_VERSION, corePlugin, deformFixtures, deformManifest, deformPlugin, gridBox, orderHints } from '../src'
import { CORE_PLUGIN_ID, CORE_PLUGIN_VERSION } from '../src/core-plugin'

type Op = 'bend' | 'wave' | 'ripple'
const registry = (): Registry => new Registry().register(corePlugin()).register(deformPlugin())
const step = (id: string, op: string, params: Record<string, unknown>) => makeStep({ id, plugin: { id: DEFORM_PLUGIN_ID, version: DEFORM_PLUGIN_VERSION }, op, params })
const run = (mesh: Mesh, op: Op, params: Record<string, unknown>, signal?: AbortSignal) =>
  runWorkflow(addStep(emptyStepList(), step('d', op, params)), { registry: registry(), source: mesh, ...(signal ? { signal } : {}) })
const bar = (): Mesh => boxMesh(10, 10, 40)         // x, y centred, z from 0 to 40
const plate = (): Mesh => gridBox(60, 40, 4, 2, 2, 1) // x, y centred, z from 0 to 4
const hash = (m: Mesh): string => sha256Hex(Array.from(m.positions).join(',') + '|' + Array.from(m.indices).join(','))
const has = (m: Mesh, x: number, y: number, z: number, tol = 1e-9): boolean => {
  for (let i = 0; i < m.positions.length; i += 3) if (Math.abs((m.positions[i] as number) - x) < tol && Math.abs((m.positions[i + 1] as number) - y) < tol && Math.abs((m.positions[i + 2] as number) - z) < tol) return true
  return false
}

describe('deform: bend, wave and ripple (manifest)', () => {
  it('has a valid manifest with the three new operations in the shape group', () => {
    expect(validateManifest(deformManifest).ok).toBe(true)
    for (const id of ['bend', 'wave', 'ripple']) {
      const op = deformManifest.operations.find(o => o.id === id)!
      expect(op.category).toBe('shape'); expect(op.kind).toBe('modifier'); expect(op.icon).toBe(id)
    }
  })
  it('the version is 0.3.0 and a stored 0.2 twist step still validates and runs', async () => {
    expect(DEFORM_PLUGIN_VERSION).toBe('0.3.0')
    const old = makeStep({ id: 't', plugin: { id: DEFORM_PLUGIN_ID, version: '0.2.0' }, op: 'twist', params: { angle: 90 } })
    const r = await runWorkflow(addStep(emptyStepList(), old), { registry: registry(), source: bar() })
    expect(r.ok).toBe(true)
  })
  it('only the main amounts can be handed to the customer', () => {
    for (const [id, name] of [['bend', 'angle'], ['wave', 'amplitude'], ['ripple', 'amplitude']] as const) {
      const op = deformManifest.operations.find(o => o.id === id)!
      expect(op.params.filter(p => p.personalisable).map(p => p.name)).toContain(name)
      expect(op.params.find(p => p.name === 'detail')?.personalisable).toBeFalsy()
    }
    const op = deformManifest.operations.find(o => o.id === 'bend')!
    expect(validateParams(op, { angle: 400 }).ok).toBe(false)   // 360 at most
  })
})

describe('bend', () => {
  it('bends a bar by 90 degrees: closed, the volume of the straight bar (Pappus), the corners where the closed form says', async () => {
    const r = await run(bar(), 'bend', { angle: 90 })   // folds towards +x, along z
    expect(r.ok).toBe(true)
    const out = r.mesh as Mesh
    const me = measureMesh(out)
    expect(me.watertight).toBe(true)
    expect(Math.abs(me.volume - 4000) / 4000).toBeLessThan(0.02)
    // radius R = length / angle = 40 / (pi / 2); the inner top corner (d = +5 towards the centre): w = (R - 5) sin 90, x = R (1 - cos 90) + 5 cos 90
    const R = 40 / (Math.PI / 2)
    expect(has(out, R, 5, R - 5)).toBe(true)
    expect(has(out, R, -5, R - 5)).toBe(true)
    // the outer top corner (d = -5): w = (R + 5), x = R
    expect(has(out, R, 5, R + 5)).toBe(true)
    // the bottom stays
    expect(has(out, 5, 5, 0)).toBe(true); expect(has(out, -5, -5, 0)).toBe(true)
    expect(out.indices.length / 3).toBeGreaterThan(12)
  })

  it('a negative angle bends the other way and bending towards another axis moves the other coordinate', async () => {
    const R = 40 / (Math.PI / 2)
    const neg = (await run(bar(), 'bend', { angle: -90 })).mesh as Mesh
    expect(has(neg, -R, 5, R - 5)).toBe(true)
    const towardsY = (await run(bar(), 'bend', { angle: 90, bend_axis: 'y' })).mesh as Mesh
    expect(has(towardsY, 5, R, R - 5)).toBe(true)
    expect(measureMesh(towardsY).watertight).toBe(true)
  })

  it('a bend along x folding towards z works on the plate (any pair of axes)', async () => {
    const out = (await run(plate(), 'bend', { angle: 60, axis: 'x', bend_axis: 'z' })).mesh as Mesh
    expect(measureMesh(out).watertight).toBe(true)
    expect(Math.abs(measureMesh(out).volume - 60 * 40 * 4) / (60 * 40 * 4)).toBeLessThan(0.02)
  })

  it('only the range bends: below it the bar stays, above it the bar is carried on rigidly', async () => {
    const out = (await run(bar(), 'bend', { angle: 90, from: 0.25, to: 0.75 })).mesh as Mesh
    expect(has(out, 5, 5, 0)).toBe(true); expect(has(out, 5, 5, 10)).toBe(true)   // below the range: untouched
    // the bend runs from z = 10 to z = 30 (length 20, radius R = 20 / (pi / 2)); the top (z = 40) is carried on along the tangent, which now points along +x:
    // the corner (5, 5, 40) is at w = 10 + (R - 5) sin 90 = 10 + R - 5 and x = R (1 - cos 90) + 5 cos 90 + (40 - 30) = R + 10
    const R = 20 / (Math.PI / 2)
    expect(has(out, R + 10, 5, 10 + R - 5)).toBe(true)
    expect(has(out, R + 10, 5, 10 + R + 5)).toBe(true)
    expect(measureMesh(out).watertight).toBe(true)
  })

  it('a bend of 0 degrees leaves the bar as it was, and the same bend twice gives the same mesh', async () => {
    const same = (await run(bar(), 'bend', { angle: 0 })).mesh as Mesh
    expect(same.indices.length / 3).toBe(12)
    const a = (await run(bar(), 'bend', { angle: 120 })).mesh as Mesh, b = (await run(bar(), 'bend', { angle: 120 })).mesh as Mesh
    expect(hash(a)).toBe(hash(b))
  })

  it('warns when the inside is squeezed hard and refuses when the model folds into itself', async () => {
    const hard = await run(bar(), 'bend', { angle: 360 })              // R = 6.4 mm against a half-width of 5 mm
    expect(hard.ok).toBe(true)
    expect(hard.results[0]?.warnings?.some(w => w.code === 'deform.may_fold')).toBe(true)
    const folds = await run(boxMesh(20, 10, 40), 'bend', { angle: 360 })  // half-width 10 mm is beyond the centre of the circle
    expect(folds.ok).toBe(false)
    expect(folds.results[0]?.error?.code).toBe('deform.folds')
    const gentle = await run(bar(), 'bend', { angle: 45 })
    expect(gentle.results[0]?.warnings ?? []).toEqual([])
  })

  it('refuses the same axis for the length and the fold', async () => {
    const r = await run(bar(), 'bend', { angle: 90, axis: 'z', bend_axis: 'z' })
    expect(r.ok).toBe(false)
    expect(r.results[0]?.error?.code).toBe('deform.bad_axes')
  })

  it('keeps bodies and colour parts', async () => {
    const a = boxMesh(10, 10, 40)
    const m: Mesh = assignSegment({ ...a, groups: [{ start: 0, count: 6, role: 'solid', name: 'lower' }, { start: 6, count: 6, role: 'solid', name: 'upper' }] }, 'side', Uint8Array.from({ length: 12 }, (_, i) => (i < 4 ? 1 : 0)))
    const out = (await run(m, 'bend', { angle: 90 })).mesh as Mesh
    const g = out.groups as NonNullable<Mesh['groups']>
    expect(g.length).toBe(2)
    expect(g[0]!.start).toBe(0); expect(g[0]!.start + g[0]!.count).toBe(g[1]!.start); expect(g[1]!.start + g[1]!.count).toBe(out.indices.length / 3)
    const side = out.segments!.table.find(s => s.name === 'side')!.id
    let n = 0; out.segments!.labels.forEach(l => { if (l === side) n++ })
    expect(n).toBeGreaterThanOrEqual(4)
  })

  it('refuses a result that is too heavy, and stops when cancelled', async () => {
    const heavy = await run(bar(), 'bend', { angle: 360, detail: 'extra_fine', max_triangles: 1000 })
    expect(heavy.results[0]?.error?.code).toBe('deform.too_heavy')
    const ac = new AbortController(); ac.abort()
    expect((await run(bar(), 'bend', { angle: 90 }, ac.signal)).ok).toBe(false)
  })

  it('a finer detail gives more triangles', async () => {
    const fine = (await run(bar(), 'bend', { angle: 180, detail: 'extra_fine' })).mesh as Mesh
    const coarse = (await run(bar(), 'bend', { angle: 180, detail: 'coarse' })).mesh as Mesh
    expect(fine.indices.length).toBeGreaterThan(coarse.indices.length)
    expect(measureMesh(fine).watertight && measureMesh(coarse).watertight).toBe(true)
  })
})

describe('wave', () => {
  it('moves the plate up and down by the amplitude, keeps it closed and keeps its volume (a shear)', async () => {
    const r = await run(plate(), 'wave', { amplitude: 2, wavelength: 20 })   // along x, moving z
    expect(r.ok).toBe(true)
    const out = r.mesh as Mesh, me = measureMesh(out)
    expect(me.watertight).toBe(true)
    expect(Math.abs(me.volume - 60 * 40 * 4)).toBeLessThan(1e-6 * 60 * 40 * 4 + 1e-3)
    // the displacement never exceeds the amplitude: z stays within [-2, 6]
    let lo = Infinity, hi = -Infinity
    for (let i = 2; i < out.positions.length; i += 3) { lo = Math.min(lo, out.positions[i] as number); hi = Math.max(hi, out.positions[i] as number) }
    expect(lo).toBeGreaterThanOrEqual(-2 - 1e-9); expect(hi).toBeLessThanOrEqual(6 + 1e-9)
    expect(hi - 4).toBeGreaterThan(1.9)                        // and the crests really reach it
  })

  it('is periodic: points a wavelength apart along the travel axis are displaced by the same amount, in the right phase', async () => {
    const out = (await run(plate(), 'wave', { amplitude: 1.5, wavelength: 30, phase: 90 })).mesh as Mesh
    // the top face at y = 20: z - 4 is the displacement. The wave starts at x = -30 with phase 90 degrees, so it is A cos(2 pi (x + 30) / 30)
    const dz = (x: number): number => { for (let i = 0; i < out.positions.length; i += 3) if (Math.abs((out.positions[i] as number) - x) < 1e-9 && Math.abs((out.positions[i + 1] as number) - 20) < 1e-9 && (out.positions[i + 2] as number) > 2) return (out.positions[i + 2] as number) - 4; return NaN }
    expect(dz(-30)).toBeCloseTo(1.5, 9); expect(dz(0)).toBeCloseTo(1.5, 9); expect(dz(30)).toBeCloseTo(1.5, 9)   // a wavelength apart
    expect(dz(-15)).toBeCloseTo(-1.5, 9)                                                                          // half a wavelength: the trough
    expect(dz(-22.5)).toBeCloseTo(0, 9)                                                                           // a quarter: back through zero
  })

  it('a phase shifts the wave and a falloff fades it in and out at the ends of the range', async () => {
    const shifted = (await run(plate(), 'wave', { amplitude: 1, wavelength: 20, phase: 90 })).mesh as Mesh
    let atStart = NaN
    for (let i = 0; i < shifted.positions.length; i += 3) if (Math.abs((shifted.positions[i] as number) + 30) < 1e-9 && (shifted.positions[i + 2] as number) > 3) atStart = (shifted.positions[i + 2] as number) - 4
    expect(atStart).toBeCloseTo(1, 9)
    const faded = (await run(plate(), 'wave', { amplitude: 1, wavelength: 20, phase: 90, falloff: 10 })).mesh as Mesh
    let fadedStart = NaN
    for (let i = 0; i < faded.positions.length; i += 3) if (Math.abs((faded.positions[i] as number) + 30) < 1e-9 && (faded.positions[i + 2] as number) > 3) fadedStart = (faded.positions[i + 2] as number) - 4
    expect(fadedStart).toBeCloseTo(0, 9)
  })

  it('moves along the surface normal when asked, and along another axis', async () => {
    const normal = (await run(plate(), 'wave', { amplitude: 0.5, wavelength: 20, direction: 'normal' })).mesh as Mesh
    expect(measureMesh(normal).watertight).toBe(true)
    const sideways = (await run(plate(), 'wave', { amplitude: 1, wavelength: 20, direction: 'y' })).mesh as Mesh
    expect(measureMesh(sideways).watertight).toBe(true)
    let ymax = -Infinity; for (let i = 1; i < sideways.positions.length; i += 3) ymax = Math.max(ymax, sideways.positions[i] as number)
    expect(ymax).toBeGreaterThan(20.9)
  })

  it('a wave along its own axis that would fold the model is refused; a big wave along the normal warns', async () => {
    const folds = await run(plate(), 'wave', { amplitude: 4, wavelength: 10, direction: 'x' })   // A * k = 2.5: x folds back
    expect(folds.ok).toBe(false); expect(folds.results[0]?.error?.code).toBe('deform.folds')
    const big = await run(plate(), 'wave', { amplitude: 3, wavelength: 20, direction: 'normal' })
    expect(big.results[0]?.warnings?.some(w => w.code === 'deform.wave_too_big')).toBe(true)
  })

  it('an amplitude of 0 returns the model untouched, and the same wave twice gives the same mesh', async () => {
    const m = plate()
    expect(((await run(m, 'wave', { amplitude: 0, wavelength: 20 })).mesh as Mesh).indices.length / 3).toBe(m.indices.length / 3)
    const a = (await run(plate(), 'wave', { amplitude: 2, wavelength: 20 })).mesh as Mesh, b = (await run(plate(), 'wave', { amplitude: 2, wavelength: 20 })).mesh as Mesh
    expect(hash(a)).toBe(hash(b))
  })

  it('keeps bodies and colour parts; refuses a too heavy result; a coarser detail has fewer triangles', async () => {
    const a = boxMesh(60, 40, 4)
    const m: Mesh = assignSegment({ ...a, groups: [{ start: 0, count: 6, role: 'solid', name: 'a' }, { start: 6, count: 6, role: 'solid', name: 'b' }] }, 'face', Uint8Array.from({ length: 12 }, (_, i) => (i < 2 ? 1 : 0)))
    const out = (await run(m, 'wave', { amplitude: 1, wavelength: 20 })).mesh as Mesh
    const g = out.groups as NonNullable<Mesh['groups']>
    expect(g[0]!.start + g[0]!.count).toBe(g[1]!.start); expect(g[1]!.start + g[1]!.count).toBe(out.indices.length / 3)
    expect(out.segments!.table.map(s => s.name)).toContain('face')
    const heavy = await run(plate(), 'wave', { amplitude: 2, wavelength: 20, max_triangles: 1000 })
    expect(heavy.results[0]?.error?.code).toBe('deform.too_heavy')
    const fine = (await run(plate(), 'wave', { amplitude: 2, wavelength: 20, detail: 'fine' })).mesh as Mesh
    const coarse = (await run(plate(), 'wave', { amplitude: 2, wavelength: 20, detail: 'coarse' })).mesh as Mesh
    expect(fine.indices.length).toBeGreaterThan(coarse.indices.length)
  })
})

describe('ripple', () => {
  const heightAt = (m: Mesh, x: number, y: number): number => {
    let z = NaN
    for (let i = 0; i < m.positions.length; i += 3) if (Math.abs((m.positions[i] as number) - x) < 1e-6 && Math.abs((m.positions[i + 1] as number) - y) < 1e-6 && (m.positions[i + 2] as number) > 3) z = m.positions[i + 2] as number
    return z - 4
  }
  it('rings the top and the bottom of a plate together: closed, the same volume (the thickness stays)', async () => {
    const r = await run(plate(), 'ripple', { amplitude: 1, wavelength: 10, detail: 'coarse' })
    expect(r.ok).toBe(true)
    const out = r.mesh as Mesh, me = measureMesh(out)
    expect(me.watertight).toBe(true)
    expect(Math.abs(me.volume - 60 * 40 * 4)).toBeLessThan(1e-3)
    // the thickness at a point is still 4 mm: the top and the bottom vertex above each other moved the same
    let top = NaN, bottom = NaN
    for (let i = 0; i < out.positions.length; i += 3) if (Math.abs((out.positions[i] as number) - 30) < 1e-9 && Math.abs((out.positions[i + 1] as number) - 20) < 1e-9) { if ((out.positions[i + 2] as number) > 2) top = out.positions[i + 2] as number; else bottom = out.positions[i + 2] as number }
    expect(top - bottom).toBeCloseTo(4, 9)
  })

  it('is radially symmetric: points at the same distance from the centre move by the same amount', async () => {
    const out = (await run(plate(), 'ripple', { amplitude: 1, wavelength: 10, phase: 0, center: 'origin', detail: 'coarse' })).mesh as Mesh
    // the four corners (+-30, +-20) are all at r = 36.06 from the origin
    const hs = [heightAt(out, 30, 20), heightAt(out, -30, 20), heightAt(out, 30, -20), heightAt(out, -30, -20)]
    for (const h of hs) expect(h).toBeCloseTo(hs[0]!, 9)
    // and the value is A sin(2 pi r / lambda)
    expect(hs[0]!).toBeCloseTo(Math.sin((2 * Math.PI * Math.hypot(30, 20)) / 10), 9)
  })

  it('a decay lowers the rings with the distance and a radius ends them', async () => {
    const out = (await run(plate(), 'ripple', { amplitude: 2, wavelength: 10, phase: 0, center: 'origin', decay: 10, radius: 25, detail: 'coarse' })).mesh as Mesh
    // beyond the radius (the corners are at 36 mm) nothing moves
    expect(heightAt(out, 30, 20)).toBeCloseTo(0, 9)
    // inside, the amplitude falls off: the largest displacement within 6 mm of the centre is larger than within 15 to 20 mm
    let near = 0, far = 0
    for (let i = 0; i < out.positions.length; i += 3) {
      const x = out.positions[i] as number, y = out.positions[i + 1] as number, z = (out.positions[i + 2] as number) - 4, r = Math.hypot(x, y)
      if ((out.positions[i + 2] as number) < 2) continue
      if (r < 6) near = Math.max(near, Math.abs(z)); else if (r > 15 && r < 20) far = Math.max(far, Math.abs(z))
    }
    expect(near).toBeGreaterThan(far)
  })

  it('moves along another axis, and an amplitude of 0 returns the model untouched', async () => {
    const side = (await run(plate(), 'ripple', { amplitude: 1, wavelength: 10, axis: 'x', detail: 'coarse' })).mesh as Mesh
    expect(measureMesh(side).watertight).toBe(true)
    expect(((await run(plate(), 'ripple', { amplitude: 0, wavelength: 10 })).mesh as Mesh).indices.length / 3).toBe(plate().indices.length / 3)
  })

  it('keeps bodies and colour parts, is deterministic, stops when cancelled and refuses a result that is too heavy', async () => {
    const a = boxMesh(60, 40, 4)
    const m: Mesh = assignSegment({ ...a, groups: [{ start: 0, count: 6, role: 'solid', name: 'a' }, { start: 6, count: 6, role: 'solid', name: 'b' }] }, 'face', Uint8Array.from({ length: 12 }, (_, i) => (i < 2 ? 1 : 0)))
    const out = (await run(m, 'ripple', { amplitude: 1, wavelength: 10, detail: 'coarse' })).mesh as Mesh
    const g = out.groups as NonNullable<Mesh['groups']>
    expect(g[0]!.start + g[0]!.count).toBe(g[1]!.start); expect(g[1]!.start + g[1]!.count).toBe(out.indices.length / 3)
    expect(out.segments!.table.map(s => s.name)).toContain('face')
    const h1 = hash((await run(plate(), 'ripple', { amplitude: 1, wavelength: 10, detail: 'coarse' })).mesh as Mesh), h2 = hash((await run(plate(), 'ripple', { amplitude: 1, wavelength: 10, detail: 'coarse' })).mesh as Mesh)
    expect(h1).toBe(h2)
    const ac = new AbortController(); ac.abort()
    expect((await run(plate(), 'ripple', { amplitude: 1, wavelength: 10 }, ac.signal)).ok).toBe(false)
    expect((await run(plate(), 'ripple', { amplitude: 1, wavelength: 10, max_triangles: 1000 })).results[0]?.error?.code).toBe('deform.too_heavy')
  })

  it('refines a 100 x 100 mm plate with 8 mm rings in reasonable time', async () => {
    const big = gridBox(100, 100, 4, 2, 2, 1)
    const t0 = performance.now()
    const r = await run(big, 'ripple', { amplitude: 1.5, wavelength: 8, detail: 'coarse' })
    const ms = performance.now() - t0
    expect(r.ok).toBe(true)
    expect(measureMesh(r.mesh as Mesh).watertight).toBe(true)
    console.log(`ripple 8 mm on 100 x 100 mm (coarse): ${(r.mesh as Mesh).indices.length / 3} triangles in ${Math.round(ms)} ms`)
    expect(ms).toBeLessThan(15000)
  })
})

describe('deform: order and fixtures', () => {
  it('bend, wave and ripple belong above the text steps and a smoothing step belongs below them', () => {
    const text = makeStep({ id: 'e', plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op: 'emboss', params: {} })
    for (const op of ['bend', 'wave', 'ripple']) {
      const list = addStep(addStep(emptyStepList(), text), step('d', op, {}))
      expect(orderHints(list).some(h => h.step === 'd' && h.code === 'deform_after_text')).toBe(true)
      const smooth = addStep(addStep(emptyStepList(), step('s', 'smooth', {})), step('d', op, {}))
      expect(orderHints(smooth).some(h => h.step === 's' && h.code === 'smooth_before_surface')).toBe(true)
    }
  })
  it('passes its conformance fixtures', async () => {
    const results = await runFixtures(deformFixtures, { registry: registry() })
    for (const r of results) expect(r.ok, `${r.name}: ${JSON.stringify(r.failures)}`).toBe(true)
  })
})

describe('ripple: the start phase', () => {
  it('starts with a smooth crest in the middle by default (no cone): the height next to the centre is almost the height at it', async () => {
    const out = (await run(gridBox(40, 40, 4, 2, 2, 1), 'ripple', { amplitude: 1, wavelength: 20, center: 'origin', detail: 'fine' })).mesh as Mesh
    let atCentre = -Infinity, near = NaN, rNear = NaN
    for (let i = 0; i < out.positions.length; i += 3) {
      const x = out.positions[i] as number, y = out.positions[i + 1] as number, z = out.positions[i + 2] as number
      if (z < 2) continue
      if (Math.hypot(x, y) < 1e-9) atCentre = z - 4
      if (Math.abs(Math.hypot(x, y) - 1.25) < 0.3 && Number.isNaN(near)) { near = z - 4; rNear = Math.hypot(x, y) }
    }
    expect(atCentre).toBeCloseTo(1, 9)           // a crest of height A at the middle
    expect(atCentre - near).toBeCloseTo(1 - Math.cos((2 * Math.PI * rNear) / 20), 6)   // it falls like 1 - cos(k r): flat at the centre, no cone
  })
})
