// Measurements of a mesh: counts, size, volume, area, and whether it is a closed oriented surface.
// Informational only: the Atelier prices on its server from its own measurement, never from these numbers.
import type { Mesh, Vec3 } from './types'
import { CHUNK, runAsync, runSync } from './progress'
import type { ProgressOptions } from './progress'

export interface Measurements {
  vertices: number
  triangles: number
  bbox: { min: Vec3; max: Vec3 }
  /** Size along x, y and z in millimetres. */
  size: Vec3
  /** Signed volume in mm³; positive for a closed surface with outward-facing triangles. Meaningless for an open mesh. */
  volume: number
  /** Surface area in mm². */
  surfaceArea: number
  /** Edges that belong to one triangle only. */
  boundaryEdges: number
  /** Edges shared by more than two triangles. */
  nonManifoldEdges: number
  /** Edges shared by two triangles that traverse them in the same direction (inconsistent orientation). */
  badOrientationEdges: number
  /** A closed, consistently oriented surface: no boundary, no non-manifold and no badly oriented edge. */
  watertight: boolean
}

export function measureMesh(mesh: Mesh): Measurements { return runSync(measureGen(mesh)) }

/** The same, letting the event loop run between chunks (for a page that shows a loader while it checks a big model). */
export function measureMeshAsync(mesh: Mesh, opts: ProgressOptions = {}): Promise<Measurements> { return runAsync(measureGen(mesh), opts) }

/** Only the size of the box around the mesh: one pass over the vertices, for when the rest is not needed (a unit check, a size label). */
export function boundingSize(mesh: Mesh): Vec3 {
  const P = mesh.positions
  if (P.length === 0) return [0, 0, 0]
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i] as number, y = P[i + 1] as number, z = P[i + 2] as number
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z
  }
  return [x1 - x0, y1 - y0, z1 - z0]
}

function* measureGen(mesh: Mesh): Generator<number, Measurements> {
  const P = mesh.positions, T = mesh.indices
  const nv = P.length / 3, nt = T.length / 3
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
  for (let i = 0; i < nv; i++) {
    const x = P[3 * i] as number, y = P[3 * i + 1] as number, z = P[3 * i + 2] as number
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z
  }
  if (nv === 0) { x0 = y0 = z0 = x1 = y1 = z1 = 0 }
  let vol = 0, area = 0
  for (let t = 0; t < nt; t++) {
    if (t > 0 && t % (2 * CHUNK) === 0) yield (0.3 * t) / nt
    const a = 3 * (T[3 * t] as number), b = 3 * (T[3 * t + 1] as number), c = 3 * (T[3 * t + 2] as number)
    const ax = P[a] as number, ay = P[a + 1] as number, az = P[a + 2] as number
    const bx = P[b] as number, by = P[b + 1] as number, bz = P[b + 2] as number
    const cx = P[c] as number, cy = P[c + 1] as number, cz = P[c + 2] as number
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    area += 0.5 * Math.hypot(nx, ny, nz)
    vol += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6
  }
  const eg = edgeStatsGen(T)
  let er = eg.next()
  while (!er.done) { yield 0.3 + 0.7 * er.value; er = eg.next() }
  const e = er.value
  return {
    vertices: nv, triangles: nt, bbox: { min: [x0, y0, z0], max: [x1, y1, z1] }, size: [x1 - x0, y1 - y0, z1 - z0],
    volume: vol, surfaceArea: area, ...e, watertight: nt > 0 && e.boundaryEdges === 0 && e.nonManifoldEdges === 0 && e.badOrientationEdges === 0,
  }
}

/** Edge bookkeeping with an open-addressing hash table on typed arrays (no strings, no Map: fast on millions of triangles). */
function* edgeStatsGen(T: Uint32Array): Generator<number, { boundaryEdges: number; nonManifoldEdges: number; badOrientationEdges: number }> {
  const n = T.length
  if (n === 0) return { boundaryEdges: 0, nonManifoldEdges: 0, badOrientationEdges: 0 }
  let size = 1; while (size < n * 2) size <<= 1
  const mask = size - 1
  const lo = new Int32Array(size).fill(-1), hi = new Uint32Array(size), cnt = new Uint8Array(size), fwd = new Uint8Array(size)
  for (let t = 0; t < n; t += 3) {
    if (t > 0 && t % (6 * CHUNK) === 0) yield (0.9 * t) / n
    for (let k = 0; k < 3; k++) {
      const a = T[t + k] as number, b = T[t + (k + 1) % 3] as number
      const l = a < b ? a : b, h = a < b ? b : a
      let s = (Math.imul(l, 0x9e3779b1) ^ Math.imul(h, 0x85ebca6b)) >>> 0 & mask
      for (;;) {
        if (lo[s] === -1) { lo[s] = l; hi[s] = h; break }
        if (lo[s] === l && hi[s] === h) break
        s = (s + 1) & mask
      }
      if ((cnt[s] as number) < 255) cnt[s] = (cnt[s] as number) + 1
      if (a < b) fwd[s] = (fwd[s] as number) + 1
    }
  }
  let boundary = 0, nonManifold = 0, bad = 0
  for (let s = 0; s < size; s++) {
    if (lo[s] === -1) continue
    const c = cnt[s] as number
    if (c === 1) boundary++
    else if (c > 2) nonManifold++
    else if ((fwd[s] as number) !== 1) bad++
  }
  return { boundaryEdges: boundary, nonManifoldEdges: nonManifold, badOrientationEdges: bad }
}
