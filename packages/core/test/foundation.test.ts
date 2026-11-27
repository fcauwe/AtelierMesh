import { describe, expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020'
import { canonicalJson, hashJson, sha256Hex, measureMesh, validateManifest, validateParams, operationParamsSchema, meshKey, MemoryCache } from '../src'
import { boxMesh, cylinderMesh, lBracketMesh, sphereMesh, testManifest } from '../src/testing'

describe('canonical json and hashing', () => {
  it('sorts keys and normalises numbers', () => {
    expect(canonicalJson({ b: 1, a: [1, 2, { z: 0, y: -0 }] })).toBe('{"a":[1,2,{"y":0,"z":0}],"b":1}')
  })
  it('rejects non-finite numbers', () => { expect(() => canonicalJson({ a: NaN })).toThrow() })
  it('sha256 matches known vectors', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ b: 2, a: 1 }))
  })
})

describe('measureMesh', () => {
  it('box', () => { const m = measureMesh(boxMesh(10, 20, 30)); expect(m.volume).toBeCloseTo(6000); expect(m.watertight).toBe(true); expect(m.triangles).toBe(12) })
  it('cylinder', () => { const m = measureMesh(cylinderMesh(5, 10, 64)); expect(m.watertight).toBe(true); expect(m.volume).toBeCloseTo(0.5 * 64 * 25 * Math.sin(2 * Math.PI / 64) * 10, 6) })
  it('sphere', () => { const m = measureMesh(sphereMesh(10, 3)); expect(m.watertight).toBe(true); expect(m.volume / ((4 / 3) * Math.PI * 1000)).toBeGreaterThan(0.97) })
  it('l bracket', () => { const m = measureMesh(lBracketMesh()); expect(m.volume).toBeCloseTo(6000); expect(m.watertight).toBe(true) })
  it('detects an open mesh', () => { const b = boxMesh(1, 1, 1); b.indices = b.indices.slice(0, 33); expect(measureMesh(b).watertight).toBe(false) })
})

describe('meshKey', () => {
  it('is stable and sensitive', () => {
    expect(meshKey(boxMesh(1, 2, 3))).toBe(meshKey(boxMesh(1, 2, 3)))
    expect(meshKey(boxMesh(1, 2, 3))).not.toBe(meshKey(boxMesh(1, 2, 3.0001)))
  })
})

describe('MemoryCache', () => {
  it('evicts least recently used by entries', () => {
    const c = new MemoryCache({ maxEntries: 2 })
    c.set('a', {}); c.set('b', {}); c.get('a'); c.set('c', {})
    expect(c.get('b')).toBeUndefined(); expect(c.get('a')).toBeDefined(); expect(c.get('c')).toBeDefined()
  })
})

describe('manifest validation', () => {
  it('accepts the test manifest', () => { expect(validateManifest(testManifest()).ok).toBe(true) })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bad = (mut: (m: Record<string, any>) => void) => { const m = JSON.parse(JSON.stringify(testManifest())) as Record<string, any>; mut(m); return validateManifest(m) }
  it('refuses broken manifests', () => {
    expect(bad(m => { m.id = 'Bad' }).ok).toBe(false)
    expect(bad(m => { m.version = '1.0' }).ok).toBe(false)
    expect(bad(m => { m.operations[0].params[0].type = 'wibble' }).ok).toBe(false)
    expect(bad(m => { m.operations[0].params[0].default = 99 }).ok).toBe(false)
    expect(bad(m => { m.operations[0].params[1].default = 'nope' }).ok).toBe(false)
    expect(bad(m => { m.operations[0].params[0].min = 20 }).ok).toBe(false)
    expect(bad(m => { m.operations[0].params.push({ ...m.operations[0].params[0] }) }).ok).toBe(false)
    expect(bad(m => { m.operations.push({ ...m.operations[0] }) }).ok).toBe(false)
    expect(validateManifest(null).ok).toBe(false)
  })
  it('ignores unknown extra fields', () => { expect(bad(m => { m.x_future = 1 }).ok).toBe(true) })
})

describe('parameter validation', () => {
  const op = testManifest().operations[0]!
  it('fills defaults and rejects unknown', () => {
    expect(validateParams(op, {}).value).toEqual({ factor: 1, mode: 'uniform', label: '' })
    expect(validateParams(op, { nope: 1 }).errors[0]?.code).toBe('param.unknown')
  })
  it('range, enum, length', () => {
    expect(validateParams(op, { factor: 11 }).errors[0]?.code).toBe('param.out_of_range')
    expect(validateParams(op, { mode: 'z' }).errors[0]?.code).toBe('param.not_enum')
    expect(validateParams(op, { label: 'x'.repeat(13) }).errors[0]?.code).toBe('param.too_long')
    expect(validateParams(op, { factor: '2' }).errors[0]?.code).toBe('param.type')
  })
  it('customer may change only personalisable params', () => {
    const base = { factor: 1, mode: 'uniform', label: '' }
    expect(validateParams(op, { ...base, factor: 2 }, { role: 'customer', base, personalisableParams: ['factor'] }).ok).toBe(true)
    expect(validateParams(op, { ...base, mode: 'xy' }, { role: 'customer', base, personalisableParams: ['factor'] }).errors[0]?.code).toBe('param.not_editable')
    expect(validateParams(op, { ...base, factor: 2 }, { role: 'customer', base, personalisableParams: [] }).errors[0]?.code).toBe('param.not_editable')
  })
})

describe('JSON Schema agrees with the TS validator', () => {
  const op = testManifest().operations[0]!
  const ajv = new Ajv2020({ strict: false })
  const validate = ajv.compile(operationParamsSchema({ id: 'test.core', version: '1.0.0' }, op))
  const cases: unknown[] = [{}, { factor: 2 }, { factor: 0.05 }, { factor: 11 }, { factor: '2' }, { mode: 'xy' }, { mode: 'q' }, { label: 'abc' }, { label: 'x'.repeat(13) }, { extra: 1 }, { factor: 1, mode: 'uniform', label: '' }, { label: 5 }]
  it.each(cases.map((c, i) => [i, c] as const))('case %i', (_i, c) => {
    expect(validate(c)).toBe(validateParams(op, c).ok)
  })
})

describe('vector, asset and placement parameters', () => {
  const op = { id: 'p', kind: 'modifier' as const, params: [
    { name: 'v', type: 'vector' as const, size: 3 as const, default: [0, 0, 0], min: -5, max: 5 },
    { name: 'font', type: 'asset' as const, default: null },
    { name: 'at', type: 'placement' as const, default: null },
    { name: 'n', type: 'int' as const, default: 1, min: 1, max: 3 },
    { name: 'rot', type: 'angle' as const, default: 0, min: -180, max: 180 },
    { name: 'flag', type: 'bool' as const, default: false },
  ] }
  const ajv = new Ajv2020({ strict: false })
  const validate = ajv.compile(operationParamsSchema({ id: 'x.y', version: '1.0.0' }, op))
  const place = { anchor: { point: [1, 2, 3], normal: [0, 0, 1], tri: 4 }, up_ref: 'y', direction: 90, offset: [0, 0], align: { h: 'center', v: 'middle' } }
  const cases: unknown[] = [
    {}, { v: [1, 2, 3] }, { v: [1, 2] }, { v: [1, 2, 9] }, { v: [1, 'a', 3] }, { font: 'roboto' }, { font: '' }, { font: 5 },
    { at: place }, { at: { anchor: { point: [1, 2], normal: [0, 0, 1] } } }, { at: { anchor: { point: [1, 2, 3], normal: [0, 0, 1] }, up_ref: 'q' } },
    { n: 2 }, { n: 2.5 }, { n: 4 }, { rot: 200 }, { flag: 1 }, { flag: true },
  ]
  it.each(cases.map((c, i) => [i, c] as const))('case %i agrees', (_i, c) => {
    expect(validate(c)).toBe(validateParams(op, c).ok)
  })
})

describe('bvh raycast', () => {
  it('finds the same nearest triangle and distance as testing every triangle', async () => {
    const { buildBvh } = await import('../src/bvh')
    const { sphereMesh } = await import('../src/testing/meshes')
    const m = sphereMesh(10, 3), nt = m.indices.length / 3
    const bvh = buildBvh(m)
    let seed = 11
    const rnd = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
    const P = m.positions, T = m.indices
    let hits = 0
    for (let r = 0; r < 80; r++) {
      const o: [number, number, number] = [(rnd() - 0.5) * 40, (rnd() - 0.5) * 40, (rnd() - 0.5) * 40]
      const dd = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5], l = Math.hypot(...dd) * (r % 2 ? 1 : 3) // non-unit directions too
      const d: [number, number, number] = [dd[0]! / l, dd[1]! / l, dd[2]! / l]
      let best = Infinity, bt = -1
      for (let t = 0; t < nt; t++) {
        const a = 3 * T[3 * t]!, b = 3 * T[3 * t + 1]!, c = 3 * T[3 * t + 2]!
        const e1 = [P[b]! - P[a]!, P[b + 1]! - P[a + 1]!, P[b + 2]! - P[a + 2]!], e2 = [P[c]! - P[a]!, P[c + 1]! - P[a + 1]!, P[c + 2]! - P[a + 2]!]
        const p = [d[1] * e2[2]! - d[2] * e2[1]!, d[2] * e2[0]! - d[0] * e2[2]!, d[0] * e2[1]! - d[1] * e2[0]!]
        const det = e1[0]! * p[0]! + e1[1]! * p[1]! + e1[2]! * p[2]!
        if (Math.abs(det) < 1e-12) continue
        const tt = [o[0] - P[a]!, o[1] - P[a + 1]!, o[2] - P[a + 2]!]
        const u = (tt[0]! * p[0]! + tt[1]! * p[1]! + tt[2]! * p[2]!) / det
        if (u < 0 || u > 1) continue
        const q = [tt[1]! * e1[2]! - tt[2]! * e1[1]!, tt[2]! * e1[0]! - tt[0]! * e1[2]!, tt[0]! * e1[1]! - tt[1]! * e1[0]!]
        const v = (d[0] * q[0]! + d[1] * q[1]! + d[2] * q[2]!) / det
        if (v < 0 || u + v > 1) continue
        const dist = (e2[0]! * q[0]! + e2[1]! * q[1]! + e2[2]! * q[2]!) / det
        if (dist > 1e-9 && dist < best) { best = dist; bt = t }
      }
      const hit = bvh.raycast(o, d)
      if (bt < 0) expect(hit).toBeNull()
      else { hits++; expect(hit!.triangle).toBe(bt); expect(hit!.distance).toBeCloseTo(best, 9) }
    }
    expect(hits).toBeGreaterThan(10)
  })

  it('builds a million-triangle index in a reasonable time', async () => {
    const { buildBvh } = await import('../src/bvh')
    const nt = 1_000_000, positions = new Float64Array(9 * nt), indices = new Uint32Array(3 * nt)
    let s = 3; const rnd = (): number => { s = (s * 16807) % 2147483647; return s / 2147483647 }
    for (let t = 0; t < nt; t++) { const x = rnd() * 100, y = rnd() * 100, z = rnd() * 100; for (let k = 0; k < 3; k++) { positions[9 * t + 3 * k] = x + rnd(); positions[9 * t + 3 * k + 1] = y + rnd(); positions[9 * t + 3 * k + 2] = z + rnd(); indices[3 * t + k] = 3 * t + k } }
    const t0 = performance.now()
    const bvh = buildBvh({ positions, indices })
    const ms = performance.now() - t0
    expect(bvh.nodes).toBeGreaterThan(1000)
    console.log(`bvh build, 1M triangles: ${Math.round(ms)} ms`)
    expect(ms).toBeLessThan(process.env['COVERAGE'] ? 120000 : 15000)
  })
})

describe('customer fields make a step personalisable', () => {
  it('follows the ticked fields, and makeStep derives it', async () => {
    const { setPersonalisableParams, makeStep, addStep, emptyStepList, stepPersonalisable } = await import('../src')
    const base = makeStep({ id: 'a', plugin: { id: 'x.y', version: '1.0.0' }, op: 'o', personalisable: true })
    expect(base.personalisable).toBe(false)                      // a flag without fields does not count
    let list = addStep(emptyStepList(), base)
    list = setPersonalisableParams(list, 'a', ['text', 'text', 'size'])
    expect(list.steps[0]).toMatchObject({ personalisable: true, personalisable_params: ['text', 'size'] })
    expect(stepPersonalisable(list.steps[0]!)).toBe(true)
    list = setPersonalisableParams(list, 'a', [])
    expect(list.steps[0]).toMatchObject({ personalisable: false, personalisable_params: [] })
    expect(() => setPersonalisableParams(list, 'nope', ['x'])).toThrow()
  })
})

describe('asset hints in a manifest', () => {
  const man = (extra: Record<string, unknown>) => ({ manifest_version: 1, id: 'x.y', name: 'X', version: '1.0.0', operations: [{ id: 'o', kind: 'modifier', params: [{ name: 'f', type: 'asset', default: null, ...extra }] }] })
  it('accepts widget font or gallery and preview text, and refuses anything else', () => {
    expect(validateManifest(man({ widget: 'font', preview: 'text', library: 'fonts', accept: ['font'] })).ok).toBe(true)
    expect(validateManifest(man({ widget: 'gallery' })).ok).toBe(true)
    expect(validateManifest(man({ widget: 'carousel' })).errors[0]?.params).toMatchObject({ reason: 'bad_widget' })
    expect(validateManifest(man({ preview: 'image' })).errors[0]?.params).toMatchObject({ reason: 'bad_preview' })
  })
})
