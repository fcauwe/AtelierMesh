// Splitting every triangle into four (midpoints of the edges): the shape does not change at all, a flat face just gets more vertices. Text needs vertices
// to map onto, so a model made of a few big triangles (a 12-triangle box) is refined before the letters are placed.
import type { Mesh } from '@ateliermesh/core'
import { closestOnTri, pointOf } from './adjacency'
import { vlen, vsub } from './vec'

/** One round of 1-to-4 splitting. The four children of triangle t are triangles 4t..4t+3, so body ranges and segment labels carry over exactly. */
export function refineOnce(m: Mesh): Mesh {
  const nv = m.positions.length / 3, nt = m.indices.length / 3
  const mid = new Map<number, number>()
  const pos: number[] = Array.from(m.positions)
  const midpoint = (a: number, b: number): number => {
    const lo = Math.min(a, b), hi = Math.max(a, b), key = lo * nv + hi
    let id = mid.get(key)
    if (id === undefined) {
      id = pos.length / 3
      pos.push(((m.positions[3 * a] as number) + (m.positions[3 * b] as number)) / 2, ((m.positions[3 * a + 1] as number) + (m.positions[3 * b + 1] as number)) / 2, ((m.positions[3 * a + 2] as number) + (m.positions[3 * b + 2] as number)) / 2)
      mid.set(key, id)
    }
    return id
  }
  const idx = new Uint32Array(12 * nt)
  for (let t = 0; t < nt; t++) {
    const a = m.indices[3 * t] as number, b = m.indices[3 * t + 1] as number, c = m.indices[3 * t + 2] as number
    const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a)
    idx.set([a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca], 12 * t)
  }
  const out: Mesh = { positions: Float64Array.from(pos), indices: idx }
  if (m.groups) out.groups = m.groups.map(g => ({ ...g, start: g.start * 4, count: g.count * 4 }))
  if (m.segments) {
    const labels = new Uint16Array(4 * nt)
    for (let t = 0; t < nt; t++) labels.fill(m.segments.labels[t] as number, 4 * t, 4 * t + 4)
    out.segments = { labels, table: m.segments.table }
  }
  return out
}

/** The longest edge among the triangles within `radius` of a point (a coarse area has long edges). */
export function longestEdgeNear(m: Mesh, point: [number, number, number], radius: number): number {
  let best = 0
  const P = m.positions
  for (let t = 0; t < m.indices.length / 3; t++) {
    const v = [0, 1, 2].map(k => 3 * (m.indices[3 * t + k] as number))
    const r = closestOnTri(point, pointOf(P, v[0] as number / 3), pointOf(P, v[1] as number / 3), pointOf(P, v[2] as number / 3))
    if (vlen(vsub(r.point, point)) > radius) continue
    for (let k = 0; k < 3; k++) { const a = v[k] as number, b = v[(k + 1) % 3] as number; best = Math.max(best, Math.hypot((P[a] as number) - (P[b] as number), (P[a + 1] as number) - (P[b + 1] as number), (P[a + 2] as number) - (P[b + 2] as number))) }
  }
  return best
}
