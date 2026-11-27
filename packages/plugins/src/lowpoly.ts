// Low poly: an artistic version of a model made of few, large, flat facets that still follow the shape.
//
// Two stages, both deterministic:
//  1. collapse: quadric edge collapse (decimate.ts / the WebAssembly twin) down to the target. Edges sharper than `sharpness` degrees and the open
//     borders are held by the decimator, so the crisp creases of the original stay crisp and the topology stays a closed manifold.
//  2. crystallise: every free vertex of the result moves towards the point that is closest to the planes of the ORIGINAL surface around it
//     (a 3 x 3 least-squares problem, regularised so it cannot slide along a flat area). On a flat face nothing moves; on a corner the vertex snaps to the
//     exact corner; on a rounded crease it sharpens it. The move is limited to a fraction of the shortest edge at the vertex and refused when it would fold
//     a triangle, so the solid stays valid. `amount` (0 to 1) scales the move; 0 gives the plain collapse.
// The planes come from the original, not from the result, because the planes of the faces around a vertex all pass through that vertex: fitting them
// would move nothing.
import { MeshError, measureMesh } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'
import { decimateAuto } from './decimate-wasm'

export interface LowPolyOptions {
  /** Target number of triangles. Ignored when `autoTolerance` is set. */
  triangles: number
  /**
   * Automatic mode: no target count. The collapse goes on as far as the quadric error allows and stops when the next collapse would pass this
   * distance (mm). The result is the smallest triangle count that stays within the tolerance. See `autoTolerance`.
   */
  autoTolerance?: number
  /** Edges whose faces meet at more than this angle (degrees) are kept as creases. 1 to 90. */
  sharpness: number
  /** 0 to 1: how far each vertex moves towards the planes of the original surface. */
  crystallise: number
  keepBorders: boolean
  engine?: 'auto' | 'wasm' | 'js'
  signal?: AbortSignal
  onProgress?: (stage: 'collapse' | 'crystallise', fraction: number) => void
}

export interface LowPolyResult {
  mesh: Mesh
  before: number
  after: number
  /** True when the model already had no more triangles than the target and came back unchanged. */
  unchanged: boolean
  /** Largest quadric error of the collapse (mm). */
  maxError: number
  engine: 'wasm' | 'js'
  /** Vertices on an edge sharper than `sharpness` in the result. */
  creases: number
  /** Vertices crystallise moved, and the longest move (mm). */
  moved: number
  maxMove: number
}

type V3 = [number, number, number]

/** The fewest triangles the automatic mode will go down to (the minimum of the `triangles` setting). */
export const AUTO_MIN_TRIANGLES = 12

/**
 * The distance (mm) the automatic mode may stray from the original surface, from the model size and the `detail` setting (0 to 1):
 * `diagonal * (0.08 * (1 - detail)^2 + 0.002)`. Detail 0 allows 8.2 % of the bounding-box diagonal (a very coarse, artistic result),
 * 0.5 allows 2.2 %, 1 allows 0.2 % (close to the original).
 */
export function autoTolerance(mesh: Mesh, detail: number): number {
  const P = mesh.positions
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { const v = P[i + k] as number; if (v < (lo[k] as number)) lo[k] = v; if (v > (hi[k] as number)) hi[k] = v }
  const diag = P.length === 0 ? 0 : Math.hypot((hi[0] as number) - (lo[0] as number), (hi[1] as number) - (lo[1] as number), (hi[2] as number) - (lo[2] as number))
  const d = Math.min(1, Math.max(0, detail))
  return diag * (0.08 * (1 - d) * (1 - d) + 0.002)
}

/** Distance from a point to a triangle (Ericson, Real-Time Collision Detection). */
function distPointTri(px: number, py: number, pz: number, a: V3, b: V3, c: V3): number {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2], acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2]
  const apx = px - a[0], apy = py - a[1], apz = pz - a[2]
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz
  const L = (x: number, y: number, z: number): number => Math.hypot(px - x, py - y, pz - z)
  if (d1 <= 0 && d2 <= 0) return L(a[0], a[1], a[2])
  const bpx = px - b[0], bpy = py - b[1], bpz = pz - b[2]
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz
  if (d3 >= 0 && d4 <= d3) return L(b[0], b[1], b[2])
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return L(a[0] + v * abx, a[1] + v * aby, a[2] + v * abz) }
  const cpx = px - c[0], cpy = py - c[1], cpz = pz - c[2]
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz
  if (d6 >= 0 && d5 <= d6) return L(c[0], c[1], c[2])
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return L(a[0] + w * acx, a[1] + w * acy, a[2] + w * acz) }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); return L(b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])) }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den
  return L(a[0] + abx * v + acx * w, a[1] + aby * v + acy * w, a[2] + abz * v + acz * w)
}

/** Solve the symmetric 3 x 3 system [h0 h1 h2; h1 h3 h4; h2 h4 h5] x = r by Cramer's rule; null when it is singular. */
function solve3(h: number[], r: V3): V3 | null {
  const a = h[0] as number, b = h[1] as number, c = h[2] as number, d = h[3] as number, e = h[4] as number, f = h[5] as number
  const det = a * (d * f - e * e) - b * (b * f - e * c) + c * (b * e - d * c)
  if (!(Math.abs(det) > 1e-18)) return null
  const x = (r[0] * (d * f - e * e) - b * (r[1] * f - e * r[2]) + c * (r[1] * e - d * r[2])) / det
  const y = (a * (r[1] * f - e * r[2]) - r[0] * (b * f - e * c) + c * (b * r[2] - r[1] * c)) / det
  const z = (a * (d * r[2] - r[1] * e) - b * (b * r[2] - r[1] * c) + r[0] * (b * e - d * c)) / det
  return [x, y, z]
}

/** The planes (unit normal, offset, area) of the triangles of one body of the original, in a grid so a ball query is cheap. */
class PlaneGrid {
  readonly n: Float64Array   // unit normals, 3 per triangle
  readonly d: Float64Array   // plane offsets
  readonly area: Float64Array
  private readonly tri: V3[][]
  private readonly cells = new Map<number, number[]>()
  private readonly big: number[] = []
  private readonly seen: Int32Array
  private stamp = 0
  private readonly x0: number; private readonly y0: number; private readonly z0: number
  private readonly cell: number; private readonly nx: number; private readonly ny: number; private readonly nz: number

  constructor(mesh: Mesh, start: number, count: number, cell: number) {
    const P = mesh.positions, T = mesh.indices
    this.n = new Float64Array(3 * count); this.d = new Float64Array(count); this.area = new Float64Array(count)
    this.tri = []
    const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < count; i++) {
      const t = start + i
      const pts: V3[] = []
      for (let k = 0; k < 3; k++) { const v = T[3 * t + k] as number; pts.push([P[3 * v] as number, P[3 * v + 1] as number, P[3 * v + 2] as number]) }
      this.tri.push(pts)
      const [a, b, c] = pts as [V3, V3, V3]
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
      const l = Math.hypot(nx, ny, nz)
      this.area[i] = l / 2
      if (l > 0) { this.n[3 * i] = nx / l; this.n[3 * i + 1] = ny / l; this.n[3 * i + 2] = nz / l; this.d[i] = -((nx / l) * a[0] + (ny / l) * a[1] + (nz / l) * a[2]) }
      for (const p of pts) for (let k = 0; k < 3; k++) { if ((p[k] as number) < (lo[k] as number)) lo[k] = p[k] as number; if ((p[k] as number) > (hi[k] as number)) hi[k] = p[k] as number }
    }
    // keep the grid to at most about 2^22 cells
    const ext = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-9)
    this.cell = Math.max(cell, ext / 160)
    this.x0 = lo[0]; this.y0 = lo[1]; this.z0 = lo[2]
    this.nx = Math.floor((hi[0] - lo[0]) / this.cell) + 1; this.ny = Math.floor((hi[1] - lo[1]) / this.cell) + 1; this.nz = Math.floor((hi[2] - lo[2]) / this.cell) + 1
    this.seen = new Int32Array(count)
    for (let i = 0; i < count; i++) {
      if ((this.area[i] as number) <= 0) continue
      const pts = this.tri[i] as V3[]
      const bl: V3 = [Infinity, Infinity, Infinity], bh: V3 = [-Infinity, -Infinity, -Infinity]
      for (const p of pts) for (let k = 0; k < 3; k++) { if ((p[k] as number) < (bl[k] as number)) bl[k] = p[k] as number; if ((p[k] as number) > (bh[k] as number)) bh[k] = p[k] as number }
      const [i0, j0, k0] = this.at(bl[0], bl[1], bl[2]), [i1, j1, k1] = this.at(bh[0], bh[1], bh[2])
      if ((i1 - i0 + 1) * (j1 - j0 + 1) * (k1 - k0 + 1) > 125) { this.big.push(i); continue }
      for (let a = i0; a <= i1; a++) for (let b = j0; b <= j1; b++) for (let c = k0; c <= k1; c++) {
        const key = a + this.nx * (b + this.ny * c)
        const list = this.cells.get(key)
        if (list) list.push(i); else this.cells.set(key, [i])
      }
    }
  }

  private at(x: number, y: number, z: number): [number, number, number] {
    return [Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.x0) / this.cell))), Math.min(this.ny - 1, Math.max(0, Math.floor((y - this.y0) / this.cell))), Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.z0) / this.cell)))]
  }

  /**
   * The least-squares point for the planes of the triangles within `r` of `p` that `p` nearly lies on (at most `tau` away): the 3 x 3 normal matrix, the gradient
   * at `p`, how many triangles took part, and every triangle within `r` (for `nearest`). A plane the point is far from belongs to another sheet of the surface
   * (the face next to a crease, the other side of a thin wall) and must not pull it. Each triangle weighs its area (at most r squared, so one huge
   * triangle does not decide) times a falloff to the edge of the ball.
   */
  gather(p: V3, r: number, tau: number, maxTris: number): { h: number[]; g: V3; count: number; near: number[] } {
    const [i0, j0, k0] = this.at(p[0] - r, p[1] - r, p[2] - r), [i1, j1, k1] = this.at(p[0] + r, p[1] + r, p[2] + r)
    const stamp = ++this.stamp
    const found: number[] = []
    const consider = (i: number): void => {
      if (this.seen[i] === stamp) return
      this.seen[i] = stamp
      const [a, b, c] = this.tri[i] as [V3, V3, V3]
      if (distPointTri(p[0], p[1], p[2], a, b, c) <= r) found.push(i)
    }
    for (let c = k0; c <= k1; c++) for (let b = j0; b <= j1; b++) for (let a = i0; a <= i1; a++) { const l = this.cells.get(a + this.nx * (b + this.ny * c)); if (l) for (const i of l) consider(i) }
    for (const i of this.big) consider(i)
    found.sort((x, y) => x - y)
    const usable = found.filter(i => Math.abs((this.n[3 * i] as number) * p[0] + (this.n[3 * i + 1] as number) * p[1] + (this.n[3 * i + 2] as number) * p[2] + (this.d[i] as number)) <= tau)
    const stride = usable.length > maxTris ? Math.ceil(usable.length / maxTris) : 1
    const h = [0, 0, 0, 0, 0, 0], g: V3 = [0, 0, 0]
    let count = 0
    for (let q = 0; q < usable.length; q += stride) {
      const i = usable[q] as number
      const nx = this.n[3 * i] as number, ny = this.n[3 * i + 1] as number, nz = this.n[3 * i + 2] as number
      const [a, b, c] = this.tri[i] as [V3, V3, V3]
      const dist = distPointTri(p[0], p[1], p[2], a, b, c)
      const fall = 1 - (dist / r) * (dist / r)
      const w = Math.min(this.area[i] as number, r * r) * fall * stride
      const res = nx * p[0] + ny * p[1] + nz * p[2] + (this.d[i] as number)
      h[0] += w * nx * nx; h[1] += w * nx * ny; h[2] += w * nx * nz; h[3] += w * ny * ny; h[4] += w * ny * nz; h[5] += w * nz * nz
      g[0] += w * res * nx; g[1] += w * res * ny; g[2] += w * res * nz
      count++
    }
    return { h, g, count, near: found }
  }

  /** Distance from `p` to the nearest of the given triangles (indices from `gather`). */
  nearest(p: V3, tris: number[]): number {
    let best = Infinity
    for (const i of tris) { const [a, b, c] = this.tri[i] as [V3, V3, V3]; const d = distPointTri(p[0], p[1], p[2], a, b, c); if (d < best) best = d }
    return best
  }
}

/** Move the free vertices of `mesh` towards the planes of `original` (see the file comment). Returns a new mesh; the inputs are not changed. */
export function crystallise(original: Mesh, mesh: Mesh, opts: { amount: number; sharpness: number; keepBorders: boolean; signal?: AbortSignal; onProgress?: (f: number) => void }): { mesh: Mesh; creases: number; moved: number; maxMove: number } {
  const nv = mesh.positions.length / 3, nt = mesh.indices.length / 3
  const P = Float64Array.from(mesh.positions), T = mesh.indices
  const cosCrease = Math.cos((opts.sharpness * Math.PI) / 180)
  const px = (v: number): V3 => [P[3 * v] as number, P[3 * v + 1] as number, P[3 * v + 2] as number]

  // face normals of the result
  const N0 = new Float64Array(3 * nt)
  const normalOf = (t: number, out: Float64Array, o: number, sub?: number, at?: V3): number => {
    const ia = T[3 * t] as number, ib = T[3 * t + 1] as number, ic = T[3 * t + 2] as number
    const a = ia === sub && at ? at : px(ia), b = ib === sub && at ? at : px(ib), c = ic === sub && at ? at : px(ic)
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz)
    if (l > 0) { out[o] = nx / l; out[o + 1] = ny / l; out[o + 2] = nz / l } else { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0 }
    return l / 2
  }
  for (let t = 0; t < nt; t++) normalOf(t, N0, 3 * t)

  // edges, incident triangles, the vertices that must not move
  const key = (a: number, b: number): number => (a < b ? a * nv + b : b * nv + a)
  const edgeTris = new Map<number, number[]>()
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
    const kk = key(T[3 * t + k] as number, T[3 * t + ((k + 1) % 3)] as number)
    const l = edgeTris.get(kk)
    if (l) l.push(t); else edgeTris.set(kk, [t])
  }
  const labels = mesh.segments?.labels
  const locked = new Uint8Array(nv), crease = new Uint8Array(nv)
  const minEdge = new Float64Array(nv).fill(Infinity), sumEdge = new Float64Array(nv), degree = new Uint32Array(nv)
  for (const [k, ts] of edgeTris) {
    const a = Math.floor(k / nv), b = k - a * nv
    const len = Math.hypot((P[3 * a] as number) - (P[3 * b] as number), (P[3 * a + 1] as number) - (P[3 * b + 1] as number), (P[3 * a + 2] as number) - (P[3 * b + 2] as number))
    for (const v of [a, b]) { if (len < (minEdge[v] as number)) minEdge[v] = len; sumEdge[v] = (sumEdge[v] as number) + len; degree[v] = (degree[v] as number) + 1 }
    if (ts.length === 1) { if (opts.keepBorders) { locked[a] = 1; locked[b] = 1 } continue }
    if (ts.length !== 2) { locked[a] = 1; locked[b] = 1; continue }   // not a manifold edge: leave it alone
    const t0 = ts[0] as number, t1 = ts[1] as number
    if (labels && labels[t0] !== labels[t1]) { locked[a] = 1; locked[b] = 1 }
    const dot = (N0[3 * t0] as number) * (N0[3 * t1] as number) + (N0[3 * t0 + 1] as number) * (N0[3 * t1 + 1] as number) + (N0[3 * t0 + 2] as number) * (N0[3 * t1 + 2] as number)
    if (dot < cosCrease) { crease[a] = 1; crease[b] = 1 }
  }
  let creases = 0
  for (let v = 0; v < nv; v++) if (crease[v]) creases++
  if (opts.amount <= 0 || nv === 0) return { mesh: { ...mesh, positions: P }, creases, moved: 0, maxMove: 0 }

  // which body each vertex belongs to, and the planes of that body of the original
  const og = original.groups && original.groups.length > 0 ? original.groups : null
  const mg = mesh.groups && mesh.groups.length > 0 ? mesh.groups : null
  const bodies = og && mg && og.length === mg.length ? og.map(g => ({ start: g.start, count: g.count })) : [{ start: 0, count: original.indices.length / 3 }]
  const vbody = new Uint32Array(nv)
  if (og && mg && og.length === mg.length) mg.forEach((g, gi) => { for (let t = g.start; t < g.start + g.count; t++) for (let k = 0; k < 3; k++) vbody[T[3 * t + k] as number] = gi })
  const edges: number[] = []
  for (const k of edgeTris.keys()) { const a = Math.floor(k / nv), b = k - a * nv; edges.push(Math.hypot((P[3 * a] as number) - (P[3 * b] as number), (P[3 * a + 1] as number) - (P[3 * b + 1] as number), (P[3 * a + 2] as number) - (P[3 * b + 2] as number))) }
  edges.sort((x, y) => x - y)
  const cell = Math.max(1e-6, 0.8 * (edges[edges.length >> 1] ?? 1))
  const grids = bodies.map(b => new PlaneGrid(original, b.start, b.count, cell))

  const vt: number[][] = Array.from({ length: nv }, () => [])
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) (vt[T[3 * t + k] as number] as number[]).push(t)

  const tmp = new Float64Array(3)
  let moved = 0, maxMove = 0
  const passes = 2
  for (let pass = 0; pass < passes; pass++) {
    for (let v = 0; v < nv; v++) {
      if ((v & 255) === 0) {
        if (opts.signal?.aborted) throw new MeshError('run.cancelled')
        opts.onProgress?.((pass + v / nv) / passes)
      }
      if (locked[v] || degree[v] === 0) continue
      const x0 = px(v)
      const mean = (sumEdge[v] as number) / (degree[v] as number)
      const r = 0.9 * mean
      const grid = grids[vbody[v] as number] as PlaneGrid
      const { h, g, count, near } = grid.gather(x0, r, 0.3 * mean, 600)
      if (count === 0) continue
      const dist0 = grid.nearest(x0, near)
      const lam = 0.05 * ((h[0] as number) + (h[3] as number) + (h[5] as number)) / 3 + 1e-12
      const d = solve3([(h[0] as number) + lam, h[1] as number, h[2] as number, (h[3] as number) + lam, h[4] as number, (h[5] as number) + lam], [-g[0], -g[1], -g[2]])
      if (!d) continue
      let dx = opts.amount * d[0], dy = opts.amount * d[1], dz = opts.amount * d[2]
      const len = Math.hypot(dx, dy, dz)
      const limit = 0.35 * (minEdge[v] as number)
      if (len > limit) { const s = limit / len; dx *= s; dy *= s; dz *= s }
      // refuse a move that folds a triangle over: halve it up to three times
      let scale = 1, ok = false
      for (let tries = 0; tries < 4 && !ok; tries++) {
        const at: V3 = [x0[0] + dx * scale, x0[1] + dy * scale, x0[2] + dz * scale]
        ok = grid.nearest(at, near) <= dist0 + 0.02 * mean   // never drift away from the original surface
        if (ok) for (const t of vt[v] as number[]) {
          const area = normalOf(t, tmp, 0, v, at)
          if (area < 1e-12 || (tmp[0] as number) * (N0[3 * t] as number) + (tmp[1] as number) * (N0[3 * t + 1] as number) + (tmp[2] as number) * (N0[3 * t + 2] as number) < 0.2) { ok = false; break }
        }
        if (!ok) scale *= 0.5
      }
      if (!ok) continue
      const step = Math.hypot(dx, dy, dz) * scale
      if (step < 1e-12) continue
      P[3 * v] = x0[0] + dx * scale; P[3 * v + 1] = x0[1] + dy * scale; P[3 * v + 2] = x0[2] + dz * scale
      if (pass === 0) moved++
      if (step > maxMove) maxMove = step
    }
  }
  opts.onProgress?.(1)
  return { mesh: { ...mesh, positions: P }, creases, moved, maxMove }
}

/** The whole operation: check the input, collapse, crystallise. */
export async function lowPoly(mesh: Mesh, opts: LowPolyOptions): Promise<LowPolyResult> {
  const nv = mesh.positions.length / 3, nt = mesh.indices.length / 3
  if (!Number.isInteger(nt) || nt < 4 || nv < 4 || mesh.indices.length % 3 !== 0) throw new MeshError('lowpoly.bad_input', { reason: 'too_few_triangles', triangles: nt })
  for (let i = 0; i < mesh.indices.length; i++) if ((mesh.indices[i] as number) >= nv) throw new MeshError('lowpoly.bad_input', { reason: 'index_out_of_range' })
  for (let i = 0; i < mesh.positions.length; i++) if (!Number.isFinite(mesh.positions[i] as number)) throw new MeshError('lowpoly.bad_input', { reason: 'not_finite' })
  const auto = opts.autoTolerance !== undefined
  const target = auto ? AUTO_MIN_TRIANGLES : Math.max(4, Math.floor(opts.triangles))
  if (nt <= target) return { mesh, before: nt, after: nt, unchanged: true, maxError: 0, engine: 'js', creases: 0, moved: 0, maxMove: 0 }
  let d
  try {
    d = await decimateAuto(mesh, { targetTriangles: target, ...(auto ? { maxError: opts.autoTolerance } : {}), preserveBoundary: opts.keepBorders, preserveCreases: true, creaseAngle: Math.min(179, Math.max(1, opts.sharpness)), signal: opts.signal, onProgress: f => opts.onProgress?.('collapse', f) }, opts.engine ?? 'auto')
    // Held creases can stop one pass early (a dense box keeps many points along its edges). The next pass sees the thinned mesh and can go on: repeat while it helps.
    // In automatic mode every extra pass may only spend what is left of the tolerance, so the errors of the passes add up to at most the tolerance.
    for (let again = 0; again < (auto ? 8 : 3) && d.after > target; again++) {
      const left = auto ? (opts.autoTolerance as number) - d.maxError : 0
      if (auto && left <= 0.05 * (opts.autoTolerance as number)) break
      const next = await decimateAuto(d.mesh, { targetTriangles: target, ...(auto ? { maxError: left } : {}), preserveBoundary: opts.keepBorders, preserveCreases: true, creaseAngle: Math.min(179, Math.max(1, opts.sharpness)), signal: opts.signal }, opts.engine ?? 'auto')
      if (next.after >= d.after * 0.98) break
      d = { ...next, before: nt, maxError: auto ? d.maxError + next.maxError : Math.max(d.maxError, next.maxError), collapses: d.collapses + next.collapses }
    }
  } catch (e) {
    if (e instanceof MeshError && e.code === 'decimate.groups_unsupported') throw new MeshError('lowpoly.groups_unsupported', e.params, e.path)
    if (e instanceof MeshError && e.code === 'decimate.bad_input') throw new MeshError('lowpoly.bad_input', { reason: 'decimator_refused' })
    throw e
  }
  if (opts.signal?.aborted) throw new MeshError('run.cancelled')
  const c = crystallise(mesh, d.mesh, { amount: opts.crystallise, sharpness: opts.sharpness, keepBorders: opts.keepBorders, ...(opts.signal ? { signal: opts.signal } : {}), onProgress: f => opts.onProgress?.('crystallise', f) })
  return { mesh: c.mesh, before: nt, after: d.after, unchanged: false, maxError: d.maxError, engine: d.engine, creases: c.creases, moved: c.moved, maxMove: c.maxMove }
}

/** Volume change in percent, or null when either mesh is not a closed solid (the volume is then not meaningful). */
export function volumeChangePercent(before: Mesh, after: Mesh): { before: number; after: number; percent: number } | null {
  const a = measureMesh(before), b = measureMesh(after)
  if (!a.watertight || !b.watertight || !(a.volume > 0)) return null
  return { before: a.volume, after: b.volume, percent: ((b.volume - a.volume) / a.volume) * 100 }
}
