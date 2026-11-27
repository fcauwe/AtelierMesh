// How far a point on the surface is from the nearest sharp edge, the border of the textured region or an open edge of the mesh. The texture fades out over this
// distance (`edge_falloff`), so edges stay crisp. The distance is the straight (Euclidean) distance to the edge segments: it makes a clean, straight ramp
// along an edge. (A distance along the mesh edges, the first version, runs in the directions of the mesh and leaves a rough, ridged band.)
import { adjacency } from './remesh'

export interface CreaseField {
  /** Cheap test: is the point possibly within about two cells (`falloff`) of an edge? */
  near(x: number, y: number, z: number): boolean
  /** The distance to the nearest edge segment, or Infinity when it is more than `falloff` away. */
  dist(x: number, y: number, z: number): number
  segments: number
}

export const CREASE_COS = Math.cos((30 * Math.PI) / 180)

export function makeCreaseField(P: ArrayLike<number>, I: ArrayLike<number>, region: Uint8Array | null, falloff: number): CreaseField | null {
  const nt = I.length / 3, nv = P.length / 3
  if (nt === 0 || !(falloff > 0)) return null
  const T = I instanceof Uint32Array ? I : Uint32Array.from(I as ArrayLike<number>)
  const adj = adjacency(T, nv)
  const fn = new Float64Array(3 * nt)
  for (let t = 0; t < nt; t++) {
    const a = T[3 * t]! * 3, b = T[3 * t + 1]! * 3, c = T[3 * t + 2]! * 3
    const ux = P[b]! - P[a]!, uy = P[b + 1]! - P[a + 1]!, uz = P[b + 2]! - P[a + 2]!, vx = P[c]! - P[a]!, vy = P[c + 1]! - P[a + 1]!, vz = P[c + 2]! - P[a + 2]!
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz) || 1
    fn[3 * t] = nx / l; fn[3 * t + 1] = ny / l; fn[3 * t + 2] = nz / l
  }
  const seg: number[] = []
  for (let t = 0; t < nt; t++) {
    const inT = region ? region[t]! : 1
    for (let k = 0; k < 3; k++) {
      const u = adj[3 * t + k]!
      const a = T[3 * t + k]!, b = T[3 * t + (k + 1) % 3]!
      let edge = false
      if (u < 0) edge = inT === 1                                   // an open edge of the textured region
      else if (u > t) edge = (region ? region[u]! : 1) !== inT || fn[3 * t]! * fn[3 * u]! + fn[3 * t + 1]! * fn[3 * u + 1]! + fn[3 * t + 2]! * fn[3 * u + 2]! < CREASE_COS
      if (edge) seg.push(P[3 * a]!, P[3 * a + 1]!, P[3 * a + 2]!, P[3 * b]!, P[3 * b + 1]!, P[3 * b + 2]!)
    }
  }
  const ns = seg.length / 6
  if (ns === 0) return null
  // a grid of cells of the size of the falloff; each segment is listed in every cell its box touches
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
  for (let s = 0; s < ns; s++) for (let e = 0; e < 2; e++) {
    const x = seg[6 * s + 3 * e]!, y = seg[6 * s + 3 * e + 1]!, z = seg[6 * s + 3 * e + 2]!
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z
  }
  const cs = falloff
  const nx = Math.floor((x1 - x0) / cs) + 4, ny = Math.floor((y1 - y0) / cs) + 4
  const cell = (x: number, y: number, z: number): number => (Math.floor((x - x0) / cs) + 1 + (Math.floor((y - y0) / cs) + 1) * nx + (Math.floor((z - z0) / cs) + 1) * nx * ny)
  const cells = new Map<number, number[]>()
  const dilated = new Set<number>()
  for (let s = 0; s < ns; s++) {
    const ax = seg[6 * s]!, ay = seg[6 * s + 1]!, az = seg[6 * s + 2]!, bx = seg[6 * s + 3]!, by = seg[6 * s + 4]!, bz = seg[6 * s + 5]!
    const i0 = Math.floor((Math.min(ax, bx) - x0) / cs) + 1, i1 = Math.floor((Math.max(ax, bx) - x0) / cs) + 1
    const j0 = Math.floor((Math.min(ay, by) - y0) / cs) + 1, j1 = Math.floor((Math.max(ay, by) - y0) / cs) + 1
    const k0 = Math.floor((Math.min(az, bz) - z0) / cs) + 1, k1 = Math.floor((Math.max(az, bz) - z0) / cs) + 1
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const key = i + j * nx + k * nx * ny
      const list = cells.get(key)
      if (list) list.push(s); else cells.set(key, [s])
    }
  }
  for (const key of cells.keys()) {
    const k = Math.floor(key / (nx * ny)), j = Math.floor((key - k * nx * ny) / nx), i = key - k * nx * ny - j * nx
    for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) dilated.add(i + di + (j + dj) * nx + (k + dk) * nx * ny)
  }
  const near = (x: number, y: number, z: number): boolean => dilated.has(cell(x, y, z))
  const dist = (x: number, y: number, z: number): number => {
    const ci = Math.floor((x - x0) / cs) + 1, cj = Math.floor((y - y0) / cs) + 1, ck = Math.floor((z - z0) / cs) + 1
    let best = Infinity
    for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const list = cells.get(ci + di + (cj + dj) * nx + (ck + dk) * nx * ny)
      if (!list) continue
      for (const s of list) {
        const ax = seg[6 * s]!, ay = seg[6 * s + 1]!, az = seg[6 * s + 2]!, ex = seg[6 * s + 3]! - ax, ey = seg[6 * s + 4]! - ay, ez = seg[6 * s + 5]! - az
        const l2 = ex * ex + ey * ey + ez * ez
        let t = l2 > 0 ? ((x - ax) * ex + (y - ay) * ey + (z - az) * ez) / l2 : 0
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const d = Math.hypot(x - (ax + t * ex), y - (ay + t * ey), z - (az + t * ez))
        if (d < best) best = d
      }
    }
    return best <= falloff ? best : Infinity
  }
  return { near, dist, segments: ns }
}
