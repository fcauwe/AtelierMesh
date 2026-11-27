import { describe, expect, it } from 'vitest'
import { Registry, addStep, assignSegment, emptyStepList, makeStep, measureMesh, runFixtures, runWorkflow, sha256Hex, validateManifest } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'
import { boxMesh, cylinderMesh, sphereMesh } from '@ateliermesh/core/testing'
import { deflateSync } from 'node:zlib'
import { TEXTURE_PATTERNS, TEXTURE_PLUGIN_ID, TEXTURE_PLUGIN_VERSION, corePlugin, decodeHeightImage, lowpolyPlugin, orderHints, patternHeight, textureFixtures, textureManifest, texturePlugin } from '../src'
import { CORE_PLUGIN_ID, CORE_PLUGIN_VERSION } from '../src/core-plugin'
import { LOWPOLY_PLUGIN_ID, LOWPOLY_PLUGIN_VERSION } from '../src/lowpoly-plugin'
import type { TexturePattern } from '../src'

const registry = (): Registry => new Registry().register(corePlugin()).register(lowpolyPlugin()).register(texturePlugin())
const tx = (id: string, params: Record<string, unknown>) => makeStep({ id, plugin: { id: TEXTURE_PLUGIN_ID, version: TEXTURE_PLUGIN_VERSION }, op: 'texture', params })
const run = (mesh: Mesh, params: Record<string, unknown>, extra: { signal?: AbortSignal; assets?: (id: string) => Promise<Uint8Array> } = {}) =>
  runWorkflow(addStep(emptyStepList(), tx('t', params)), { registry: registry(), source: mesh, ...(extra.signal ? { signal: extra.signal } : {}), ...(extra.assets ? { assets: extra.assets } : {}) })
const hashOf = (m: Mesh): string => sha256Hex(new Uint8Array(m.positions.buffer.slice(0)))
/** A plate whose top face is a segment called `top`. */
const plate = (w = 50, d = 50, h = 4): Mesh => {
  const m = boxMesh(w, d, h)
  const flags = new Uint8Array(m.indices.length / 3)
  for (let t = 0; t < flags.length; t++) flags[t] = [0, 1, 2].every(k => Math.abs((m.positions[3 * (m.indices[3 * t + k] as number) + 2] as number) - h) < 1e-9) ? 1 : 0
  return assignSegment(m, 'top', flags)
}

describe('texture patterns', () => {
  const names = TEXTURE_PATTERNS.filter(p => p !== 'image') as TexturePattern[]
  const params = { seed: 3, roughness: 0.6, octaves: 3, fill: 0.5 }
  for (const name of names) {
    it(`${name}: stays in 0..1, repeats every tile and is not flat`, () => {
      let lo = Infinity, hi = -Infinity
      for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) {
        const u = (i + 0.37) / 40, v = (j + 0.61) / 40
        const h = patternHeight(name, u, v, params)
        expect(h).toBeGreaterThanOrEqual(0); expect(h).toBeLessThanOrEqual(1)
        expect(Math.abs(patternHeight(name, u + 1, v, params) - h)).toBeLessThan(1e-9)
        expect(Math.abs(patternHeight(name, u, v + 2, params) - h)).toBeLessThan(1e-9)
        lo = Math.min(lo, h); hi = Math.max(hi, h)
      }
      expect(hi - lo).toBeGreaterThan(0.3)
    })
  }
  it('the seed changes a noise pattern and the same seed gives the same values', () => {
    expect(patternHeight('noise', 0.3, 0.4, { ...params, seed: 1 })).toBe(patternHeight('noise', 0.3, 0.4, { ...params, seed: 1 }))
    expect(patternHeight('noise', 0.3, 0.4, { ...params, seed: 1 })).not.toBe(patternHeight('noise', 0.3, 0.4, { ...params, seed: 2 }))
  })
})

describe('texture plugin', () => {
  it('has a valid manifest', () => { expect(validateManifest(textureManifest).ok).toBe(true) })

  it('an amplitude of 0 leaves the mesh as it was (no extra triangles)', async () => {
    const m = boxMesh(20, 20, 20)
    const r = await run(m, { amplitude: 0 })
    expect(r.ok).toBe(true)
    expect((r.mesh as Mesh).indices.length / 3).toBe(12)
    expect(hashOf(r.mesh as Mesh)).toBe(hashOf(m))
  })

  it('ridges on the top of a plate: displacement within the amplitude, one closed solid, volume gained = mean height x area x amplitude', async () => {
    const A = 1
    const m = plate()
    const r = await run(m, { pattern: 'ridges', amplitude: A, scale: 5, fill: 0.5, mapping: 'planar', axis: 'z', region: 'top', edge_falloff: 0, offset: 0 })
    expect(r.ok).toBe(true)
    const out = r.mesh as Mesh
    const me = measureMesh(out)
    expect(me.watertight).toBe(true)
    let zmax = -Infinity
    for (let i = 2; i < out.positions.length; i += 3) zmax = Math.max(zmax, out.positions[i] as number)
    expect(zmax).toBeLessThanOrEqual(4 + A + 1e-6)
    expect(zmax).toBeGreaterThan(4 + 0.9 * A)
    let sum = 0
    const N = 4000
    for (let i = 0; i < N; i++) sum += patternHeight('ridges', (i + 0.5) / N, 0.3, { seed: 1, roughness: 0.5, octaves: 3, fill: 0.5 })
    const expected = (sum / N) * A * 2500
    const gained = me.volume - 50 * 50 * 4
    expect(Math.abs(gained - expected) / expected).toBeLessThan(0.05)
    expect(r.results[0]?.report?.['closed']).toBe(true)
  })

  it('a texture on a cylinder and on a sphere (triplanar) keeps one closed solid', async () => {
    for (const m of [cylinderMesh(10, 30, 64), sphereMesh(15, 3)]) {
      const r = await run(m, { pattern: 'knurl', amplitude: 0.5, scale: 5 })
      expect(r.ok).toBe(true)
      expect(measureMesh(r.mesh as Mesh).watertight).toBe(true)
      expect((r.mesh as Mesh).indices.length / 3).toBeGreaterThan(m.indices.length / 3)
    }
  })

  it('cylindrical mapping closes the seam: a closed solid, and the turns round the cylinder are whole', async () => {
    const r = await run(cylinderMesh(10, 30, 96), { pattern: 'ridges', amplitude: 0.6, scale: 5, mapping: 'cylindrical', axis: 'z' })
    expect(r.ok).toBe(true)
    expect(measureMesh(r.mesh as Mesh).watertight).toBe(true)
  })

  it('a region leaves everything else alone: the bottom of the plate does not move', async () => {
    const m = plate()
    const out = (await run(m, { pattern: 'knurl', amplitude: 1, scale: 5, mapping: 'planar', region: 'top', edge_falloff: 0 })).mesh as Mesh
    const bottom: number[][] = []
    for (let i = 0; i < out.positions.length; i += 3) if (Math.abs(out.positions[i + 2] as number) < 1e-9) bottom.push([out.positions[i] as number, out.positions[i + 1] as number])
    expect(bottom.length).toBe(4)
    expect(bottom.every(p => Math.abs(Math.abs(p[0] as number) - 25) < 1e-9 && Math.abs(Math.abs(p[1] as number) - 25) < 1e-9)).toBe(true)
  })

  it('"leave the bottom smooth" textures every other face but not the one that looks down', async () => {
    const m = plate()
    const all = (await run(m, { pattern: 'knurl', amplitude: 1, scale: 5, mapping: 'triplanar', edge_falloff: 1 })).mesh as Mesh
    const skip = (await run(m, { pattern: 'knurl', amplitude: 1, scale: 5, mapping: 'triplanar', edge_falloff: 1, skip_bottom: true })).mesh as Mesh
    const zs = (x: Mesh): number[] => { const o: number[] = []; for (let i = 2; i < x.positions.length; i += 3) o.push(x.positions[i] as number); return o }
    const low = (x: Mesh): number => Math.min(...zs(x)), high = (x: Mesh): number => Math.max(...zs(x))
    expect(low(all)).toBeLessThan(-0.2)                 // the bottom is textured (cut into) without the option
    expect(low(skip)).toBeGreaterThan(-1e-6)            // and flat with it: nothing goes below the bottom plane
    expect(high(skip)).toBeGreaterThan(high(m as Mesh) + 0.2)   // the top is still textured
    expect(measureMesh(skip).watertight).toBe(true)
  })

  it('the edge fall-off keeps the sharp edges of a block where they were', async () => {
    const onEdge = (m: Mesh): number => {
      let n = 0
      for (let i = 0; i < m.positions.length; i += 3) {
        const x = Math.abs(m.positions[i] as number), y = Math.abs(m.positions[i + 1] as number)
        if (Math.abs(x - 10) < 1e-9 && Math.abs(y - 10) < 1e-9) n++
      }
      return n
    }
    const m = boxMesh(20, 20, 20)
    const flat = (await run(m, { pattern: 'waves', amplitude: 0.8, scale: 5, edge_falloff: 0 })).mesh as Mesh
    const faded = (await run(m, { pattern: 'waves', amplitude: 0.8, scale: 5, edge_falloff: 2 })).mesh as Mesh
    expect(onEdge(faded)).toBeGreaterThan(20)
    expect(onEdge(flat)).toBeLessThan(onEdge(faded) / 2)
    expect(measureMesh(faded).watertight).toBe(true)
  })

  it('is deterministic, and a different seed gives a different surface', async () => {
    const m = sphereMesh(12, 3)
    const a = await run(m, { pattern: 'noise', amplitude: 0.4, scale: 6, seed: 5 })
    const b = await run(m, { pattern: 'noise', amplitude: 0.4, scale: 6, seed: 5 })
    const c = await run(m, { pattern: 'noise', amplitude: 0.4, scale: 6, seed: 6 })
    expect(hashOf(a.mesh as Mesh)).toBe(hashOf(b.mesh as Mesh))
    expect(hashOf(a.mesh as Mesh)).not.toBe(hashOf(c.mesh as Mesh))
  })

  it('labels the textured triangles with a segment when asked', async () => {
    const out = (await run(plate(), { pattern: 'dots', amplitude: 0.6, scale: 5, mapping: 'planar', region: 'top', segment: 'grip' })).mesh as Mesh
    const grip = out.segments?.table.find(s => s.name === 'grip')
    expect(grip).toBeDefined()
    let n = 0
    for (const l of out.segments!.labels) if (l === grip!.id) n++
    expect(n).toBeGreaterThan(100)
    expect(out.segments!.table.some(s => s.name === 'top')).toBe(true)
  })

  it('refuses when the surface would need more triangles than the limit, with the numbers', async () => {
    const r = await run(boxMesh(40, 40, 10), { pattern: 'knurl', scale: 4, max_triangles: 2000 })
    expect(r.ok).toBe(false)
    expect(r.results[0]?.error?.code).toBe('texture.too_heavy')
    expect((r.results[0]?.error?.params as { limit: number }).limit).toBe(2000)
  })

  it('warns when the displacement is large against the bend of the surface', async () => {
    const r = await run(cylinderMesh(3, 20, 48), { pattern: 'waves', amplitude: 3.5, scale: 3, edge_falloff: 0.2 })
    expect(r.results[0]?.warnings?.some(w => w.code === 'texture.may_self_intersect')).toBe(true)
    const calm = await run(cylinderMesh(15, 20, 48), { pattern: 'waves', amplitude: 0.3, scale: 6 })
    expect(calm.results[0]?.warnings ?? []).toEqual([])
  })

  it('keeps bodies and segments', async () => {
    const a = boxMesh(20, 20, 20)
    const m: Mesh = assignSegment({ ...a, groups: [{ start: 0, count: 6, role: 'solid', name: 'lower' }, { start: 6, count: 6, role: 'solid', name: 'upper' }] }, 'side', Uint8Array.from({ length: 12 }, (_, i) => (i < 4 ? 1 : 0)))
    const out = (await run(m, { pattern: 'dots', amplitude: 0.4, scale: 5 })).mesh as Mesh
    const g = out.groups as NonNullable<Mesh['groups']>
    expect(g.length).toBe(2)
    expect(g[0]!.start).toBe(0)
    expect(g[0]!.start + g[0]!.count).toBe(g[1]!.start)
    expect(g[1]!.start + g[1]!.count).toBe(out.indices.length / 3)
    expect(g.map(x => x.name)).toEqual(['lower', 'upper'])
    expect(out.segments?.table.some(s => s.name === 'side')).toBe(true)
  })

  it('stops when cancelled', async () => {
    const ac = new AbortController(); ac.abort()
    const r = await run(boxMesh(40, 40, 10), { pattern: 'knurl', scale: 6 }, { signal: ac.signal })
    expect(r.ok).toBe(false)
  })

  it('order hints: a texture belongs above text steps, and reducing triangles after a texture is flagged', () => {
    const text = makeStep({ id: 'x', plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op: 'emboss', params: {} })
    const reduce = makeStep({ id: 'r', plugin: { id: LOWPOLY_PLUGIN_ID, version: LOWPOLY_PLUGIN_VERSION }, op: 'low_poly', params: {} })
    const list1 = addStep(addStep(emptyStepList(), text), tx('t', {}))
    expect(orderHints(list1).some(h => h.code === 'texture_before_text' && h.step === 't')).toBe(true)
    const list2 = addStep(addStep(emptyStepList(), tx('t', {})), reduce)
    const h = orderHints(list2).find(x => x.code === 'reduce_after_texture')
    expect(h?.step).toBe('r')
    expect(h?.fix).toEqual({ id: 'r', to: 0 })
    expect(orderHints(addStep(addStep(emptyStepList(), tx('t', {})), text)).some(x => x.code === 'texture_before_text')).toBe(false)
  })

  it('passes its conformance fixtures', async () => {
    const results = await runFixtures(textureFixtures, { registry: registry() })
    for (const r of results) expect(r.ok, `${r.name}: ${JSON.stringify(r.failures)}`).toBe(true)
  })
})

// ---- a picture as the height map. A small PNG is written here, so the decoder is tested without any file.
function crc32(buf: Uint8Array): number {
  let c, crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) { c = (crc ^ (buf[n] as number)) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c }
  return (crc ^ 0xffffffff) >>> 0
}
function png(w: number, h: number, gray: (x: number, y: number) => number): Uint8Array {
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer)
    dv.setUint32(0, data.length); for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i); out.set(data, 8)
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
    return out
  }
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer)
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 0   // 8 bit grey
  const raw = new Uint8Array((w + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = gray(x, y)
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

describe('texture from a picture', () => {
  it('reads a PNG as heights', async () => {
    const img = await decodeHeightImage(png(4, 2, (x, y) => (x + 4 * y) * 32))
    expect([img.width, img.height]).toEqual([4, 2])
    expect(img.data[0]).toBeCloseTo(0, 5)
    expect(img.data[7]).toBeCloseTo(224 / 255, 5)
  })

  it('displaces a plate by a picture, and says so when there is no picture', async () => {
    const bytes = png(8, 8, (x, y) => ((x + y) % 2 === 0 ? 255 : 0))
    const r = await run(plate(30, 30, 4), { pattern: 'image', image: 'checker', amplitude: 0.8, scale: 6, mapping: 'planar', region: 'top', edge_falloff: 0 }, { assets: async id => { if (id !== 'checker') throw new Error('no asset'); return bytes } })
    expect(r.ok).toBe(true)
    const out = r.mesh as Mesh
    expect(measureMesh(out).watertight).toBe(true)
    expect((r.results[0]?.report as { max_displacement_mm: number }).max_displacement_mm).toBeGreaterThan(0.5)
    const none = await run(plate(30, 30, 4), { pattern: 'image', amplitude: 0.8, scale: 6 })
    expect(none.results[0]?.error?.code).toBe('texture.no_image')
  })

  it('refuses a picture it cannot read', async () => {
    const r = await run(plate(30, 30, 4), { pattern: 'image', image: 'x', amplitude: 0.8 }, { assets: async () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]) })
    expect(r.results[0]?.error?.code).toBe('texture.image_unsupported')
  })
})

describe('texture timing', () => {
  it('a 50 x 50 mm plate at about 0.5 mm edges and a 25 mm sphere', async () => {
    const t0 = performance.now()
    const a = await run(plate(50, 50, 4), { pattern: 'knurl', scale: 5.7, amplitude: 0.5, mapping: 'planar', region: 'top' })
    const t1 = performance.now()
    const b = await run(sphereMesh(25, 4), { pattern: 'hexagons', scale: 6, amplitude: 0.5 })
    const t2 = performance.now()
    expect(a.ok && b.ok).toBe(true)
    console.log(`texture timing: plate ${((t1 - t0) / 1000).toFixed(2)} s (${(a.mesh as Mesh).indices.length / 3} triangles), sphere ${((t2 - t1) / 1000).toFixed(2)} s (${(b.mesh as Mesh).indices.length / 3} triangles)`)
    expect(t1 - t0).toBeLessThan(15000)
    expect(t2 - t1).toBeLessThan(20000)
  }, 60000)
})


// ---------------------------------------------------------------------------------------------------- the cheese, the edge fade and the quality of the cut
import { textureMesh } from '../src'
import { makeCreaseField } from '../src/texture/creases'
import { meanMinAngle } from '../src/texture/remesh'

const base = { amplitude: 0.8, scale: 10, offset: 0, pattern_params: { seed: 1, roughness: 0.5, octaves: 3, fill: 0.5 }, invert: false, tiling: 'tile' as const, mapping: 'planar' as const, axis: 'z' as const, blend: 4, rotation: 0, offsetU: 0, offsetV: 0, region: null, falloff: 1, segmentName: '', detail: 'auto' as const, maxTriangles: 3_000_000, smoothNormals: true }
/** The share of triangles whose smallest angle is under 20 degrees. */
const slivers = (m: Mesh): number => {
  let n = 0
  const T = m.indices, P = m.positions
  for (let t = 0; t < T.length / 3; t++) {
    const a = (T[3 * t] as number) * 3, b = (T[3 * t + 1] as number) * 3, c = (T[3 * t + 2] as number) * 3
    const v = [[P[a], P[a + 1], P[a + 2]], [P[b], P[b + 1], P[b + 2]], [P[c], P[c + 1], P[c + 2]]] as number[][]
    let mn = 180
    for (let k = 0; k < 3; k++) {
      const p = v[k] as number[], q = v[(k + 1) % 3] as number[], r = v[(k + 2) % 3] as number[]
      const u = [(q[0] as number) - (p[0] as number), (q[1] as number) - (p[1] as number), (q[2] as number) - (p[2] as number)], w = [(r[0] as number) - (p[0] as number), (r[1] as number) - (p[1] as number), (r[2] as number) - (p[2] as number)]
      const cos = ((u[0] as number) * (w[0] as number) + (u[1] as number) * (w[1] as number) + (u[2] as number) * (w[2] as number)) / ((Math.hypot(u[0] as number, u[1] as number, u[2] as number) * Math.hypot(w[0] as number, w[1] as number, w[2] as number)) || 1)
      mn = Math.min(mn, (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI)
    }
    if (mn < 20) n++
  }
  return n / (T.length / 3)
}


describe('the fade towards a sharp edge', () => {
  it('the distance to an edge is the straight distance, the same in every direction', () => {
    const m = boxMesh(40, 40, 10)
    const f = makeCreaseField(m.positions, m.indices, null, 3)!
    expect(f).not.toBeNull()
    expect(f.dist(-19, 0, 10)).toBeCloseTo(1, 9)           // 1 mm from the edge along the top face
    expect(f.dist(-19, -19, 10)).toBeCloseTo(1, 9)         // near a corner: the nearer of two edges
    expect(f.dist(-18.5, -18.5, 10)).toBeCloseTo(1.5, 9)
    expect(f.dist(0, 0, 10)).toBe(Infinity)                // far inside: no fade
    // along a diagonal of the mesh the straight distance is not stretched (a distance along mesh edges would be)
    expect(f.dist(-17.5, 3, 10)).toBeCloseTo(2.5, 9)
  })
  it('the surface rises smoothly from the edge: the displacement follows smooth(distance / fade) and never goes down on the way in', () => {
    const flat: { width: number; height: number; data: Float32Array } = { width: 2, height: 2, data: Float32Array.from([1, 1, 1, 1]) }   // a pattern that is 1 everywhere
    const m = boxMesh(40, 40, 10)
    const A = 0.8, FADE = 3
    const r = textureMesh(m, { ...base, pattern: 'image', image: flat, amplitude: A, falloff: FADE, scale: 40 })
    expect(measureMesh(r.mesh).watertight).toBe(true)
    const P = r.mesh.positions
    const samples: Array<[number, number]> = []
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i] as number, y = P[i + 1] as number, z = P[i + 2] as number
      if (z < 10 - 1e-9 || Math.abs(y) > 10) continue         // the top face, away from the other edges
      const d = x + 20                                       // distance from the edge at x = -20
      if (d > 0 && d < FADE) samples.push([d, z - 10])
    }
    expect(samples.length).toBeGreaterThan(5)
    for (const [d, rise] of samples) {
      const t = d / FADE, expected = A * t * t * (3 - 2 * t)
      expect(Math.abs(rise - expected)).toBeLessThan(0.02)
    }
    samples.sort((a, b) => a[0] - b[0])
    for (let i = 1; i < samples.length; i++) expect((samples[i] as [number, number])[1]).toBeGreaterThanOrEqual((samples[i - 1] as [number, number])[1] - 0.02)
  })
  it('with no fade the pattern runs to the edge', () => {
    const flat = { width: 2, height: 2, data: Float32Array.from([1, 1, 1, 1]) }
    const r = textureMesh(boxMesh(40, 40, 10), { ...base, pattern: 'image', image: flat, amplitude: 0.5, falloff: 0, scale: 40 })
    let zmax = -Infinity
    for (let i = 2; i < r.mesh.positions.length; i += 3) zmax = Math.max(zmax, r.mesh.positions[i] as number)
    expect(zmax).toBeGreaterThan(10 + 0.3)                   // the top face is raised right up to its edge
  })
})

describe('the quality of the cut triangles', () => {
  it('flipping and relaxing makes the triangles of a coarse plate round again', () => {
    const m = boxMesh(50, 50, 4)
    const o = { ...base, pattern: 'hexagons' as const, mapping: 'triplanar' as const }
    const raw = textureMesh(m, { ...o, improve: false }), fine = textureMesh(m, { ...o, improve: true })
    expect(slivers(raw.mesh)).toBeGreaterThan(0.1)
    expect(slivers(fine.mesh)).toBeLessThan(slivers(raw.mesh) * 0.3)
    expect(fine.minAngleAfter).toBeGreaterThan(fine.minAngleBefore + 4)
    expect(measureMesh(fine.mesh).watertight).toBe(true)
  })
  it('a cylinder, whose base triangles are long and thin, ends up with far fewer slivers', () => {
    const m = cylinderMesh(15, 40, 64)
    const o = { ...base, pattern: 'knurl' as const, mapping: 'cylindrical' as const, scale: 6, amplitude: 0.4 }
    const raw = textureMesh(m, { ...o, improve: false }), fine = textureMesh(m, { ...o, improve: true })
    expect(slivers(fine.mesh)).toBeLessThan(slivers(raw.mesh) * 0.3)
    expect(measureMesh(fine.mesh).watertight).toBe(true)
  })
  it('does not touch the shape of a flat patch: the same surface, the same volume, only the triangles differ', () => {
    const m = boxMesh(50, 50, 4)
    const o = { ...base, amplitude: 0, pattern: 'hexagons' as const }
    const a = textureMesh(m, { ...o, improve: false }), b = textureMesh(m, { ...o, improve: true })
    expect(a.identity && b.identity).toBe(true)                // amplitude 0: nothing is cut at all
    const c = textureMesh(m, { ...base, amplitude: 0.5, pattern: 'ridges', fill: 0.5 } as never)
    expect(Math.abs(measureMesh(c.mesh).volume - measureMesh(textureMesh(m, { ...base, amplitude: 0.5, pattern: 'ridges', improve: false } as never).mesh).volume) / measureMesh(c.mesh).volume).toBeLessThan(0.002)
  })
  it('keeps groups and segment labels (a flip never crosses a body or a segment)', async () => {
    const m = plate()
    const r = await run(m, { pattern: 'hexagons', amplitude: 0.5, scale: 6, mapping: 'planar', region: 'top', edge_falloff: 0 })
    expect(r.ok).toBe(true)
    const out = r.mesh as Mesh
    expect(out.segments).toBeDefined()
    expect(measureMesh(out).watertight).toBe(true)
    expect(meanMinAngle(out.positions as Float64Array, out.indices as Uint32Array)).toBeGreaterThan(25)
  })
})


describe('the cheese pattern is gone (cheese is a plugin of its own)', () => {
  it('is not in the pattern list or the manifest', async () => {
    const { PATTERNS } = await import('../src/texture/patterns')
    expect((PATTERNS as readonly string[]).includes('cheese')).toBe(false)
    const { textureManifest } = await import('../src')
    const pattern = textureManifest.operations[0]!.params.find(p => p.name === 'pattern') as { options: Array<string | { value: string }> }
    expect(pattern.options.map(o => (typeof o === 'string' ? o : o.value))).not.toContain('cheese')
    expect(textureManifest.operations[0]!.params.some(p => p.name === 'hole_size')).toBe(false)
  })
})

describe('the pattern is chosen from pictures', () => {
  it('gives every pattern a picture, and the manifest is still valid', () => {
    const pattern = textureManifest.operations[0]!.params.find(p => p.name === 'pattern') as { options: Array<{ value: string; shape?: string }> }
    expect(pattern.options.map(o => o.value).sort()).toEqual([...TEXTURE_PATTERNS].sort())
    for (const o of pattern.options) expect(o.shape && o.shape.length > 0 && o.shape.length <= 1000, o.value).toBe(true)
    const r = validateManifest(JSON.parse(JSON.stringify(textureManifest)))
    expect(r.errors).toEqual([])
  })
})
