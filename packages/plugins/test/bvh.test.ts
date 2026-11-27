import { describe, expect, it } from 'vitest'
import { sphereMesh } from '@ateliermesh/core/testing'
import { buildBvh } from '../src/emboss/bvh'
import { embossRings } from '../src/emboss/embosscore'
import { gridBox, rect } from './parts'

describe('bvh', () => {
  it('ray distances equal the brute-force answer, with and without skipped triangles', () => {
    const m = sphereMesh(10, 3)
    const bvh = buildBvh(m)
    const nt = m.indices.length / 3
    const brute = (o: number[], d: number[], skip?: Uint8Array): number => {
      let best = Infinity
      for (let t = 0; t < nt; t++) {
        if (skip?.[t]) continue
        const [a, b, c] = [0, 1, 2].map(k => 3 * m.indices[3 * t + k]!) as [number, number, number]
        const P = m.positions
        const e1 = [P[b]! - P[a]!, P[b + 1]! - P[a + 1]!, P[b + 2]! - P[a + 2]!], e2 = [P[c]! - P[a]!, P[c + 1]! - P[a + 1]!, P[c + 2]! - P[a + 2]!]
        const p = [d[1]! * e2[2]! - d[2]! * e2[1]!, d[2]! * e2[0]! - d[0]! * e2[2]!, d[0]! * e2[1]! - d[1]! * e2[0]!]
        const det = e1[0]! * p[0]! + e1[1]! * p[1]! + e1[2]! * p[2]!
        if (Math.abs(det) < 1e-12) continue
        const tt = [o[0]! - P[a]!, o[1]! - P[a + 1]!, o[2]! - P[a + 2]!]
        const u = (tt[0]! * p[0]! + tt[1]! * p[1]! + tt[2]! * p[2]!) / det
        if (u < 0 || u > 1) continue
        const q = [tt[1]! * e1[2]! - tt[2]! * e1[1]!, tt[2]! * e1[0]! - tt[0]! * e1[2]!, tt[0]! * e1[1]! - tt[1]! * e1[0]!]
        const v = (d[0]! * q[0]! + d[1]! * q[1]! + d[2]! * q[2]!) / det
        if (v < 0 || u + v > 1) continue
        const dist = (e2[0]! * q[0]! + e2[1]! * q[1]! + e2[2]! * q[2]!) / det
        if (dist > 1e-9 && dist < best) best = dist
      }
      return best
    }
    const skip = new Uint8Array(nt); for (let t = 0; t < nt; t += 3) skip[t] = 1
    let seed = 7
    const rnd = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
    for (let i = 0; i < 60; i++) {
      const o = [(rnd() - 0.5) * 30, (rnd() - 0.5) * 30, (rnd() - 0.5) * 30]
      const dir = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]; const l = Math.hypot(...dir); const d = dir.map(x => x / l)
      expect(bvh.rayDistance(o as [number, number, number], d as [number, number, number])).toBeCloseTo(brute(o, d), 9)
      expect(bvh.rayDistance(o as [number, number, number], d as [number, number, number], skip)).toBeCloseTo(brute(o, d, skip), 9)
    }
    expect(bvh.nodes).toBeLessThan(nt)
  })

  it('the engraving wall check on a large mesh uses it and still finds the wall', () => {
    const plate = gridBox(60, 30, 3, 300, 150, 2)   // about 100 000 triangles
    const t0 = performance.now()
    const r = embossRings({ mesh: plate, point: [0, 0, 3], rings: [rect(-5, -2, 5, 2)], bbox: [-5, -2, 5, 2], height: 1, mode: 'engraved' })
    expect(r.report.wall_behind).toBeCloseTo(3, 6)
    expect(performance.now() - t0).toBeLessThan(process.env['COVERAGE'] ? 600000 : 8000)
  })
})
