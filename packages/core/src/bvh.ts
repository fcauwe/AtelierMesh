// A static bounding-volume hierarchy over the triangles of a mesh, for ray queries. Built by median split on triangle centres.
// Used where many rays are cast against a big mesh: the wall check behind engraved letters, and picking in the viewer.
// Both sides of a triangle are hit. A single query on a small mesh does not pay for the build.
import type { Mesh } from './types'

export interface Bvh {
  /** Distance along the ray to the nearest triangle not skipped, or Infinity. */
  rayDistance(o: [number, number, number], d: [number, number, number], skip?: Uint8Array): number
  /** The nearest triangle hit and its distance (d need not be unit length: the distance is in units of d), or null. */
  raycast(o: [number, number, number], d: [number, number, number], skip?: Uint8Array): { distance: number; triangle: number } | null
  nodes: number
}

const LEAF = 8

export function buildBvh(m: Mesh): Bvh {
  const P = m.positions, T = m.indices
  const nt = T.length / 3
  const order = new Uint32Array(nt)
  const cx = new Float64Array(nt), cy = new Float64Array(nt), cz = new Float64Array(nt)
  for (let t = 0; t < nt; t++) {
    order[t] = t
    const a = 3 * (T[3 * t] as number), b = 3 * (T[3 * t + 1] as number), c = 3 * (T[3 * t + 2] as number)
    cx[t] = ((P[a] as number) + (P[b] as number) + (P[c] as number)) / 3; cy[t] = ((P[a + 1] as number) + (P[b + 1] as number) + (P[c + 1] as number)) / 3; cz[t] = ((P[a + 2] as number) + (P[b + 2] as number) + (P[c + 2] as number)) / 3
  }
  const maxNodes = Math.max(1, Math.ceil(nt / (LEAF / 2)) * 2)
  let box = new Float64Array(6 * maxNodes), left = new Int32Array(maxNodes).fill(-1), right = new Int32Array(maxNodes).fill(-1), start = new Int32Array(maxNodes), count = new Int32Array(maxNodes)
  let n = 0
  const bounds = (lo: number, hi: number, node: number): void => {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
    for (let i = lo; i < hi; i++) {
      const t = order[i] as number
      for (let k = 0; k < 3; k++) {
        const v = 3 * (T[3 * t + k] as number)
        const x = P[v] as number, y = P[v + 1] as number, z = P[v + 2] as number
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z
      }
    }
    box[6 * node] = x0; box[6 * node + 1] = y0; box[6 * node + 2] = z0; box[6 * node + 3] = x1; box[6 * node + 4] = y1; box[6 * node + 5] = z1
  }
  // iterative build with an explicit stack
  const stack: Array<[number, number, number]> = []
  const root = n++
  stack.push([root, 0, nt])
  while (stack.length > 0) {
    const [node, lo, hi] = stack.pop() as [number, number, number]
    bounds(lo, hi, node)
    start[node] = lo; count[node] = hi - lo
    if (hi - lo <= LEAF) continue
    const ex = (box[6 * node + 3] as number) - (box[6 * node] as number), ey = (box[6 * node + 4] as number) - (box[6 * node + 1] as number), ez = (box[6 * node + 5] as number) - (box[6 * node + 2] as number)
    const axis = ex >= ey && ex >= ez ? cx : ey >= ez ? cy : cz
    const mid = (lo + hi) >> 1
    select(order, axis, lo, hi - 1, mid)
    const l = n++, r = n++
    left[node] = l; right[node] = r; count[node] = 0
    stack.push([l, lo, mid], [r, mid, hi])
  }
  // the arrays were sized for the worst case; keep only the nodes that exist (about half the memory)
  box = box.slice(0, 6 * n); left = left.slice(0, n); right = right.slice(0, n); start = start.slice(0, n); count = count.slice(0, n)
  const trace = (o: [number, number, number], d: [number, number, number], skip?: Uint8Array): { distance: number; triangle: number } => {
      const inv = [1 / (d[0] || 1e-300), 1 / (d[1] || 1e-300), 1 / (d[2] || 1e-300)]
      let best = Infinity, bestTri = -1
      const todo = [root]
      while (todo.length > 0) {
        const node = todo.pop() as number
        // slab test against the node's box, limited to the best hit so far
        let t0 = 0, t1 = best
        for (let k = 0; k < 3; k++) {
          const a = ((box[6 * node + k] as number) - o[k]!) * (inv[k] as number), b = ((box[6 * node + 3 + k] as number) - o[k]!) * (inv[k] as number)
          const lo = Math.min(a, b), hi = Math.max(a, b)
          if (lo > t0) t0 = lo; if (hi < t1) t1 = hi
          if (t0 > t1) break
        }
        if (t0 > t1) continue
        if (left[node] >= 0) { todo.push(left[node] as number, right[node] as number); continue }
        for (let i = start[node] as number; i < (start[node] as number) + (count[node] as number); i++) {
          const t = order[i] as number
          if (skip?.[t]) continue
          const a = 3 * (T[3 * t] as number), b = 3 * (T[3 * t + 1] as number), c = 3 * (T[3 * t + 2] as number)
          const e1x = (P[b] as number) - (P[a] as number), e1y = (P[b + 1] as number) - (P[a + 1] as number), e1z = (P[b + 2] as number) - (P[a + 2] as number)
          const e2x = (P[c] as number) - (P[a] as number), e2y = (P[c + 1] as number) - (P[a + 1] as number), e2z = (P[c + 2] as number) - (P[a + 2] as number)
          const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x
          const det = e1x * px + e1y * py + e1z * pz
          if (Math.abs(det) < 1e-12) continue
          const idet = 1 / det
          const tx = o[0] - (P[a] as number), ty = o[1] - (P[a + 1] as number), tz = o[2] - (P[a + 2] as number)
          const u = (tx * px + ty * py + tz * pz) * idet
          if (u < 0 || u > 1) continue
          const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x
          const v = (d[0] * qx + d[1] * qy + d[2] * qz) * idet
          if (v < 0 || u + v > 1) continue
          const dist = (e2x * qx + e2y * qy + e2z * qz) * idet
          if (dist > 1e-9 && dist < best) { best = dist; bestTri = t }
        }
      }
    return { distance: best, triangle: bestTri }
  }
  return {
    nodes: n,
    rayDistance: (o, d, skip) => trace(o, d, skip).distance,
    raycast: (o, d, skip) => { const r = trace(o, d, skip); return r.triangle < 0 ? null : r },
  }
}

/** Reorders order[lo..hi] so that order[k] holds the element of rank k by key, smaller keys before it (quickselect, no allocation). */
function select(order: Uint32Array, key: Float64Array, lo: number, hi: number, k: number): void {
  while (hi > lo) {
    const pivot = key[order[(lo + hi) >> 1] as number] as number
    let i = lo, j = hi
    while (i <= j) {
      while ((key[order[i] as number] as number) < pivot) i++
      while ((key[order[j] as number] as number) > pivot) j--
      if (i <= j) { const t = order[i] as number; order[i] = order[j] as number; order[j] = t; i++; j-- }
    }
    if (k <= j) hi = j
    else if (k >= i) lo = i
    else return
  }
}
