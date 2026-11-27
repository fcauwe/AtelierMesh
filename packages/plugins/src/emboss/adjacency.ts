// Triangle adjacency through an open-addressing hash of edges.
import type { Mesh } from '@ateliermesh/core'
import { vcross, vlen, vnorm, vsub } from './vec'
import type { V3 } from './vec'

export const pointOf = (P: ArrayLike<number>, i: number): V3 => [P[3 * i] as number, P[3 * i + 1] as number, P[3 * i + 2] as number]

export interface Adjacency {
  /** adj[3t+e] = triangle across edge e (vertex e to e+1) of triangle t; -1 on a boundary; -2 on a non-manifold edge. */
  adj: Int32Array
  nonManifold: number
  badOrientation: number
}

export function buildAdjacency(T: Uint32Array): Adjacency {
  const nt = T.length / 3
  let size = 1
  while (size < nt * 6) size <<= 1
  const slot = new Int32Array(size).fill(-1)
  const adj = new Int32Array(3 * nt).fill(-1)
  const used = new Uint8Array(3 * nt)
  let nonManifold = 0, badOrientation = 0
  const mask = size - 1
  for (let h = 0; h < 3 * nt; h++) {
    const t = (h / 3) | 0, e = h - 3 * t
    const a = T[3 * t + e] as number, b = T[3 * t + ((e + 1) % 3)] as number
    const lo = a < b ? a : b, hi = a < b ? b : a
    let s = ((Math.imul(lo, 0x9e3779b1) ^ Math.imul(hi, 0x85ebca6b)) >>> 0) & mask
    for (;;) {
      const g = slot[s] as number
      if (g < 0) { slot[s] = h; break }
      const gt = (g / 3) | 0, ge = g - 3 * gt
      const ga = T[3 * gt + ge] as number, gb = T[3 * gt + ((ge + 1) % 3)] as number
      const glo = ga < gb ? ga : gb, ghi = ga < gb ? gb : ga
      if (glo === lo && ghi === hi) {
        if (used[g] || used[h]) { nonManifold++; adj[g] = -2; adj[h] = -2; used[g] = used[h] = 1; break }
        if (!(ga === b && gb === a)) badOrientation++
        adj[h] = gt; adj[g] = t; used[g] = used[h] = 1
        break
      }
      s = (s + 1) & mask
    }
  }
  return { adj, nonManifold, badOrientation }
}

export function faceNormal(m: Mesh, t: number): V3 {
  const a = pointOf(m.positions, m.indices[3 * t] as number), b = pointOf(m.positions, m.indices[3 * t + 1] as number), c = pointOf(m.positions, m.indices[3 * t + 2] as number)
  return vnorm(vcross(vsub(b, a), vsub(c, a)))
}

export function triArea3(m: Mesh, t: number): number {
  const a = pointOf(m.positions, m.indices[3 * t] as number), b = pointOf(m.positions, m.indices[3 * t + 1] as number), c = pointOf(m.positions, m.indices[3 * t + 2] as number)
  return 0.5 * vlen(vcross(vsub(b, a), vsub(c, a)))
}

/** Nearest point on a triangle: the point and its barycentric coordinates. */
export function closestOnTri(p: V3, a: V3, b: V3, c: V3): { point: V3; bary: V3 } {
  const ab = vsub(b, a), ac = vsub(c, a), ap = vsub(p, a)
  const dot = (x: V3, y: V3): number => x[0] * y[0] + x[1] * y[1] + x[2] * y[2]
  const add = (x: V3, y: V3): V3 => [x[0] + y[0], x[1] + y[1], x[2] + y[2]]
  const sc = (x: V3, s: number): V3 => [x[0] * s, x[1] * s, x[2] * s]
  const d1 = dot(ab, ap), d2 = dot(ac, ap)
  if (d1 <= 0 && d2 <= 0) return { point: a, bary: [1, 0, 0] }
  const bp = vsub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp)
  if (d3 >= 0 && d4 <= d3) return { point: b, bary: [0, 1, 0] }
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return { point: add(a, sc(ab, v)), bary: [1 - v, v, 0] } }
  const cp = vsub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp)
  if (d6 >= 0 && d5 <= d6) return { point: c, bary: [0, 0, 1] }
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return { point: add(a, sc(ac, w)), bary: [1 - w, 0, w] } }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); return { point: add(b, sc(vsub(c, b), w)), bary: [0, 1 - w, w] } }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den
  return { point: add(a, add(sc(ab, v), sc(ac, w))), bary: [1 - v - w, v, w] }
}
