// A hollow Voronoi shell: the wall of a closed model, cut into a lattice of struts around irregular openings.
//
// The method is an implicit surface, so it works on any closed mesh and always gives a closed, manifold solid:
//   1. d(p), the signed distance to the model (negative inside), on a regular voxel grid, evaluated only where it can matter (blocks of 8 voxels
//      are skipped when their centre is further from the wall than the block is large).
//   2. shell(p) = max(d, -d - thickness): the layer of `thickness` mm below the outer surface.
//   3. rib(p): `cells` seeds are placed on the surface (a seeded Poisson-disk start, then Lloyd relaxation on the surface). rib is the distance to the
//      nearest cell border, minus half the strut width: negative inside the struts. It is the exact distance to the bisector planes of the nearest seeds.
//   4. f = smoothmax(shell, rib), and an optional cylindrical opening along Z through the top and/or the bottom. The solid is where f < 0.
//   5. Marching tetrahedra (six tetrahedra per cube, one shared diagonal, so neighbouring cubes agree on every face) turn f into triangles. Vertices
//      are shared per grid edge, so the surface is closed by construction, and every triangle is turned to face towards increasing f.
// Nothing here is random except the seeded generator, and nothing reads the clock except the timings in the report.
import { MeshError, measureMesh } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'
import { rng } from './pattern'
import { MeshDistance } from './sdf'
import { BS, marchTetrahedra, refineSurface, relaxSurface, smax } from '../implicit/iso'

export type ShellStage = 'pattern' | 'field' | 'surface'

export interface ShellOptions {
  thickness: number
  cells: number
  seed: number
  irregularity: number
  ribWidth: number
  /** Rounding of the joints between struts and wall, mm (a polynomial smooth maximum). 0 keeps them sharp. */
  smooth: number
  /** An optional round opening along the vertical (Z) axis through the top and/or the bottom, with a collar one strut wide round its edge. */
  opening: 'none' | 'bottom' | 'top' | 'both'
  openingDiameter: number
  /** Edge of a voxel, mm. */
  voxel: number
  /** When set, the surface is refined against the exact field after marching: edges are split down to about this size (mm) where the surface needs it.
   *  Off by default: it did not beat a finer grid (see SPEC), it only costs time. */
  refineTo?: number
  /** The most triangles the refinement may reach. Default 1.5 million. */
  refineCap?: number
  /** The most voxels in the grid; above it the run is refused. Default 60 million. */
  gridCap?: number
  /** The most triangles marching tetrahedra may produce before the run is refused. Default 12 million. */
  rawCap?: number
  signal?: AbortSignal
  onProgress?: (stage: ShellStage, fraction: number) => void
}

export interface ShellResult {
  mesh: Mesh
  voxel: number
  grid: [number, number, number]
  gridCells: number
  /** Voxels at which the distance was evaluated. */
  bandVoxels: number
  seeds: number
  /** Mean distance between neighbouring seeds on the surface, about, mm. */
  spacing: number
  area: number
  rawTriangles: number
  /** The deepest point found inside the model, sampled once per block of 8 voxels (so within about a block of the true value), mm. */
  maxDepth: number
  /** True when the model is certainly too thin for a cavity of this thickness: even the deepest sampled point plus the size of a block is less than the thickness. */
  noCavity: boolean
  ms: { pattern: number; field: number; surface: number }
}

/** Rounds of smoothing and re-projection onto the surface after the marching tetrahedra: it removes the ridges that the grid leaves. */
const RELAX_STEPS = 3
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())
const cancelled = (o: { signal?: AbortSignal | undefined }): void => { if (o.signal?.aborted) throw new MeshError('run.cancelled') }

// ------------------------------------------------------------------------------------------------------------------------------ the seeds

/** A grid of points for nearest-neighbour searches. */
class PointGrid {
  private readonly nx: number
  private readonly ny: number
  private readonly nz: number
  private readonly x0: number
  private readonly y0: number
  private readonly z0: number
  private readonly start: Int32Array
  private readonly items: Int32Array
  constructor(readonly pts: Float64Array, private readonly h: number) {
    const n = pts.length / 3
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
    for (let i = 0; i < n; i++) {
      const x = pts[3 * i] as number, y = pts[3 * i + 1] as number, z = pts[3 * i + 2] as number
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z
    }
    this.x0 = x0; this.y0 = y0; this.z0 = z0
    this.nx = Math.floor((x1 - x0) / h) + 1; this.ny = Math.floor((y1 - y0) / h) + 1; this.nz = Math.floor((z1 - z0) / h) + 1
    const cells = this.nx * this.ny * this.nz
    const cellOf = new Int32Array(n)
    const counts = new Int32Array(cells + 1)
    for (let i = 0; i < n; i++) {
      const c = this.cell(pts[3 * i] as number, pts[3 * i + 1] as number, pts[3 * i + 2] as number)
      cellOf[i] = c; counts[c + 1] = (counts[c + 1] as number) + 1
    }
    for (let c = 0; c < cells; c++) counts[c + 1] = (counts[c + 1] as number) + (counts[c] as number)
    this.start = counts
    this.items = new Int32Array(n)
    const fill = counts.slice(0, cells)
    for (let i = 0; i < n; i++) { const c = cellOf[i] as number; this.items[fill[c] as number] = i; fill[c] = (fill[c] as number) + 1 }
  }
  private cell(x: number, y: number, z: number): number {
    const i = Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.x0) / this.h)))
    const j = Math.min(this.ny - 1, Math.max(0, Math.floor((y - this.y0) / this.h)))
    const k = Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.z0) / this.h)))
    return i + this.nx * (j + this.ny * k)
  }
  /** The K nearest points, nearest first: indices in `outI`, squared distances in `outD`. Returns how many were found. */
  knn(px: number, py: number, pz: number, K: number, outI: Int32Array, outD: Float64Array): number {
    const { nx, ny, nz, h, pts, start, items } = this
    const ci = Math.min(nx - 1, Math.max(0, Math.floor((px - this.x0) / h))), cj = Math.min(ny - 1, Math.max(0, Math.floor((py - this.y0) / h))), ck = Math.min(nz - 1, Math.max(0, Math.floor((pz - this.z0) / h)))
    let found = 0
    const maxR = Math.max(nx, ny, nz)
    for (let r = 0; r <= maxR; r++) {
      for (let dk = -r; dk <= r; dk++) {
        const k = ck + dk
        if (k < 0 || k >= nz) continue
        for (let dj = -r; dj <= r; dj++) {
          const j = cj + dj
          if (j < 0 || j >= ny) continue
          const edge = Math.abs(dk) === r || Math.abs(dj) === r
          for (let di = -r; di <= r; di += edge || r === 0 ? 1 : 2 * r) {
            const i = ci + di
            if (i < 0 || i >= nx) continue
            const c = i + nx * (j + ny * k)
            for (let q = start[c] as number; q < (start[c + 1] as number); q++) {
              const id = items[q] as number
              const dx = (pts[3 * id] as number) - px, dy = (pts[3 * id + 1] as number) - py, dz = (pts[3 * id + 2] as number) - pz
              const d = dx * dx + dy * dy + dz * dz
              if (found < K || d < (outD[K - 1] as number)) {
                let s = found < K ? found++ : K - 1
                while (s > 0 && (outD[s - 1] as number) > d) { outD[s] = outD[s - 1] as number; outI[s] = outI[s - 1] as number; s-- }
                outD[s] = d; outI[s] = id
              }
            }
          }
        }
      }
      // anything in the next ring is at least r cells away
      if (found >= K && (outD[K - 1] as number) <= r * h * r * h) break
    }
    return found
  }
}

interface Seeds { pts: Float64Array; spacing: number; area: number }

/** `cells` seeds on the surface: a Poisson-disk start from an area-weighted cloud, then Lloyd steps on the cloud (more steps for a lower irregularity). */
function placeSeeds(mesh: Mesh, cells: number, seed: number, irregularity: number, o: ShellOptions): Seeds {
  const P = mesh.positions, T = mesh.indices
  const nt = T.length / 3
  const cum = new Float64Array(nt)
  let area = 0
  for (let t = 0; t < nt; t++) {
    const a = 3 * (T[3 * t] as number), b = 3 * (T[3 * t + 1] as number), c = 3 * (T[3 * t + 2] as number)
    const ux = (P[b] as number) - (P[a] as number), uy = (P[b + 1] as number) - (P[a + 1] as number), uz = (P[b + 2] as number) - (P[a + 2] as number)
    const vx = (P[c] as number) - (P[a] as number), vy = (P[c + 1] as number) - (P[a + 1] as number), vz = (P[c + 2] as number) - (P[a + 2] as number)
    area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
    cum[t] = area
  }
  const spacing = Math.sqrt(area / cells)
  const rand = rng(Math.imul(seed | 0, 7919) + 13)
  const cloudN = Math.min(150000, Math.max(4000, cells * 40))
  const cloud = new Float64Array(3 * cloudN)
  for (let i = 0; i < cloudN; i++) {
    const r = rand() * area
    let lo = 0, hi = nt - 1
    while (lo < hi) { const mid = (lo + hi) >> 1; if ((cum[mid] as number) < r) lo = mid + 1; else hi = mid }
    const a = 3 * (T[3 * lo] as number), b = 3 * (T[3 * lo + 1] as number), c = 3 * (T[3 * lo + 2] as number)
    const s1 = Math.sqrt(rand()), u = 1 - s1, v = rand() * s1, w = 1 - u - v
    cloud[3 * i] = u * (P[a] as number) + v * (P[b] as number) + w * (P[c] as number)
    cloud[3 * i + 1] = u * (P[a + 1] as number) + v * (P[b + 1] as number) + w * (P[c + 1] as number)
    cloud[3 * i + 2] = u * (P[a + 2] as number) + v * (P[b + 2] as number) + w * (P[c + 2] as number)
  }
  // Poisson-disk start: take cloud points that keep a minimum distance from the seeds so far; relax the distance until there are enough
  const pts = new Float64Array(3 * cells)
  const taken = new Uint8Array(cloudN)
  let n = 0
  let rmin = spacing * (0.35 + 0.35 * (1 - irregularity))
  for (let pass = 0; pass < 40 && n < cells; pass++) {
    const r2 = rmin * rmin
    for (let i = 0; i < cloudN && n < cells; i++) {
      if (taken[i]) continue
      const x = cloud[3 * i] as number, y = cloud[3 * i + 1] as number, z = cloud[3 * i + 2] as number
      let ok = true
      for (let j = 0; j < n; j++) {
        const dx = (pts[3 * j] as number) - x, dy = (pts[3 * j + 1] as number) - y, dz = (pts[3 * j + 2] as number) - z
        if (dx * dx + dy * dy + dz * dz < r2) { ok = false; break }
      }
      if (ok) { pts[3 * n] = x; pts[3 * n + 1] = y; pts[3 * n + 2] = z; n++; taken[i] = 1 }
    }
    cancelled(o)
    rmin *= 0.85
  }
  for (let i = 0; i < cloudN && n < cells; i++) if (!taken[i]) { pts[3 * n] = cloud[3 * i] as number; pts[3 * n + 1] = cloud[3 * i + 1] as number; pts[3 * n + 2] = cloud[3 * i + 2] as number; n++ }
  // Lloyd relaxation on the surface: each seed moves to the cloud point of its cell that is nearest to the centre of the cell
  const steps = Math.round((1 - irregularity) * 8)
  const I = new Int32Array(1), D = new Float64Array(1)
  const owner = new Int32Array(cloudN)
  for (let s = 0; s < steps; s++) {
    const grid = new PointGrid(pts, Math.max(spacing * 1.3, 1e-6))
    const sum = new Float64Array(3 * n), cnt = new Int32Array(n)
    for (let i = 0; i < cloudN; i++) {
      grid.knn(cloud[3 * i] as number, cloud[3 * i + 1] as number, cloud[3 * i + 2] as number, 1, I, D)
      const c = I[0] as number
      owner[i] = c; cnt[c] = (cnt[c] as number) + 1
      sum[3 * c] = (sum[3 * c] as number) + (cloud[3 * i] as number); sum[3 * c + 1] = (sum[3 * c + 1] as number) + (cloud[3 * i + 1] as number); sum[3 * c + 2] = (sum[3 * c + 2] as number) + (cloud[3 * i + 2] as number)
    }
    const best = new Float64Array(n).fill(Infinity), pick = new Int32Array(n).fill(-1)
    for (let i = 0; i < cloudN; i++) {
      const c = owner[i] as number, k = cnt[c] as number
      const dx = (cloud[3 * i] as number) - (sum[3 * c] as number) / k, dy = (cloud[3 * i + 1] as number) - (sum[3 * c + 1] as number) / k, dz = (cloud[3 * i + 2] as number) - (sum[3 * c + 2] as number) / k
      const d = dx * dx + dy * dy + dz * dz
      if (d < (best[c] as number)) { best[c] = d; pick[c] = i }
    }
    for (let c = 0; c < n; c++) { const i = pick[c] as number; if (i >= 0) { pts[3 * c] = cloud[3 * i] as number; pts[3 * c + 1] = cloud[3 * i + 1] as number; pts[3 * c + 2] = cloud[3 * i + 2] as number } }
    cancelled(o)
    o.onProgress?.('pattern', 0.3 + 0.7 * ((s + 1) / Math.max(1, steps)))
  }
  return { pts, spacing, area }
}

// ------------------------------------------------------------------------------------------------------------------------------ the field

/**
 * Which triangles of the input the outer face may be pulled onto: those of a flat patch (neighbours within 10 degrees) and those along a deliberate sharp
 * edge (a neighbour more than 40 degrees away). A triangle next to a bend of 10 to 40 degrees is a facet of a coarse curved surface (a low-poly ball or
 * cone): the shell follows the field there, with its own, finer triangles, instead of copying the facets of the input.
 */
function snapTriangles(mesh: Mesh): Uint8Array {
  const P = mesh.positions, I = mesh.indices, nt = I.length / 3
  const key = (v: number): string => `${Math.round((P[3 * v] as number) * 1e5)},${Math.round((P[3 * v + 1] as number) * 1e5)},${Math.round((P[3 * v + 2] as number) * 1e5)}`
  const keys = new Map<number, string>()
  const kOf = (v: number): string => { let k = keys.get(v); if (k === undefined) { k = key(v); keys.set(v, k) } return k }
  const N = new Float64Array(nt * 3)
  for (let t = 0; t < nt; t++) {
    const a = 3 * (I[3 * t] as number), b = 3 * (I[3 * t + 1] as number), c = 3 * (I[3 * t + 2] as number)
    const ux = (P[b] as number) - (P[a] as number), uy = (P[b + 1] as number) - (P[a + 1] as number), uz = (P[b + 2] as number) - (P[a + 2] as number)
    const vx = (P[c] as number) - (P[a] as number), vy = (P[c + 1] as number) - (P[a + 1] as number), vz = (P[c + 2] as number) - (P[a + 2] as number)
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz) || 1
    N[3 * t] = nx / l; N[3 * t + 1] = ny / l; N[3 * t + 2] = nz / l
  }
  const first = new Map<string, number>()
  const ok = new Uint8Array(nt).fill(1)
  const bend = (t: number, o: number): void => {
    const d = (N[3 * t] as number) * (N[3 * o] as number) + (N[3 * t + 1] as number) * (N[3 * o + 1] as number) + (N[3 * t + 2] as number) * (N[3 * o + 2] as number)
    if (d < 0.985 && d > 0.766) { ok[t] = 0; ok[o] = 0 }
  }
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
    const a = kOf(I[3 * t + k] as number), b = kOf(I[3 * t + ((k + 1) % 3)] as number)
    const e = a < b ? `${a}|${b}` : `${b}|${a}`
    const o = first.get(e)
    if (o === undefined) first.set(e, t); else bend(t, o)
  }
  return ok
}

export function voronoiShell(mesh: Mesh, o: ShellOptions): ShellResult {
  const t0 = now()
  const m = measureMesh(mesh)
  const sd = MeshDistance.create(mesh, m.volume < 0 ? -1 : 1)
  if (!sd) throw new MeshError('voronoi_shell.bad_input', { reason: 'not_closed' })
  const t = o.thickness
  const vx = o.voxel
  const snapOk = snapTriangles(mesh)
  // ---- the grid
  const P = mesh.positions
  let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i] as number, y = P[i + 1] as number, z = P[i + 2] as number
    if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; if (z < bz0) bz0 = z; if (z > bz1) bz1 = z
  }
  const pad = 2 * vx
  const ox = bx0 - pad, oy = by0 - pad, oz = bz0 - pad
  const nx = Math.ceil((bx1 - bx0 + 2 * pad) / vx) + 1, ny = Math.ceil((by1 - by0 + 2 * pad) / vx) + 1, nz = Math.ceil((bz1 - bz0 + 2 * pad) / vx) + 1
  const gridCells = nx * ny * nz
  const cap = o.gridCap ?? 60_000_000
  if (gridCells > cap) throw new MeshError('voronoi_shell.too_heavy', { cells: gridCells, limit: cap, voxel: Math.round(vx * 1000) / 1000 })

  // ---- the seeds
  o.onProgress?.('pattern', 0)
  const seeds = placeSeeds(mesh, o.cells, o.seed, o.irregularity, o)
  const ns = o.cells
  // openings need room: the gap between two struts is about the spacing of the seeds minus the width of a strut
  if (seeds.spacing < o.ribWidth + 1) throw new MeshError('voronoi_shell.cells_too_small', { cells: o.cells, max_cells: Math.max(2, Math.floor(seeds.area / ((o.ribWidth + 1) * (o.ribWidth + 1)))), rib_width: o.ribWidth })
  const grid = new PointGrid(seeds.pts, Math.max(seeds.spacing * 1.3, vx))
  const t1 = now()
  o.onProgress?.('pattern', 1)

  // ---- the field, block by block
  const T = 2.2 * vx
  const hw = o.ribWidth / 2
  const cutoff = hw + T + o.smooth
  const f = new Float32Array(gridCells).fill(T)
  const bnx = Math.ceil(nx / BS), bny = Math.ceil(ny / BS), bnz = Math.ceil(nz / BS)
  const flags = new Uint8Array(bnx * bny * bnz)
  const K = 10
  const kI = new Int32Array(K), kD = new Float64Array(K)
  const sp = seeds.pts
  const R = (Math.sqrt(3) * BS * vx) / 2
  const axisX = (bx0 + bx1) / 2, axisY = (by0 + by1) / 2, zc = (bz0 + bz1) / 2
  const r0 = o.openingDiameter / 2
  const wantBottom = o.opening === 'bottom' || o.opening === 'both', wantTop = o.opening === 'top' || o.opening === 'both'
  let maxDepth = 0, band = 0, hint = -1
  /** The field at any point, exactly (no grid): the grid is filled from it, and the refined surface is projected onto its zero set. */
  const evalField = (x: number, y: number, z: number): number => {
  const d = sd.signed(x, y, z, hint)
  hint = sd.lastTriangle
  const shell = d > -d - t ? d : -d - t
  if (shell >= T) return shell
  // the struts: the distance to the nearest cell border, minus half the strut width
  const found = grid.knn(x, y, z, K, kI, kD)
  let rib: number
  if (found < 2) rib = 1e9
  else {
    const d1sq = kD[0] as number, d1 = Math.sqrt(d1sq)
    const lower = (Math.sqrt(kD[1] as number) - d1) * 0.5
    if (lower >= cutoff) rib = lower - hw
    else {
      const s1 = 3 * (kI[0] as number)
      let bestPd = Infinity
      for (let q = 1; q < found; q++) {
        const sk = 3 * (kI[q] as number)
        const ex = (sp[sk] as number) - (sp[s1] as number), ey = (sp[sk + 1] as number) - (sp[s1 + 1] as number), ez = (sp[sk + 2] as number) - (sp[s1 + 2] as number)
        const el = Math.sqrt(ex * ex + ey * ey + ez * ez)
        if (el === 0) continue
        const pd = ((kD[q] as number) - d1sq) / (2 * el)
        // a smooth minimum, so the corners of the openings (where three cells meet) are rounded like the joints with the wall, not sharp
        bestPd = bestPd === Infinity ? pd : -smax(-bestPd, -pd, o.smooth)
      }
      rib = bestPd - hw
    }
  }
  // the opening: a collar of one strut width round its edge, so no strut ends free there; then the hole itself
  let g = -1e9
  if (wantBottom || wantTop) {
    const rxy = Math.hypot(x - axisX, y - axisY)
    const inZone = (wantBottom && z < zc) || (wantTop && z > zc)
    if (inZone) {
      const rim = Math.abs(rxy - r0 - hw) - hw
      if (rim < rib) rib = rim
      g = r0 - rxy
    }
  }
  let v = smax(shell, rib, o.smooth)
  if (g > -1e8) v = smax(v, g, o.smooth)
  return v
  }
  const nBlocks = bnx * bny * bnz
  let doneBlocks = 0
  for (let bk = 0; bk < bnz; bk++) for (let bj = 0; bj < bny; bj++) for (let bi = 0; bi < bnx; bi++) {
    const bidx = bi + bnx * (bj + bny * bk)
    if ((doneBlocks++ & 63) === 0) { cancelled(o); o.onProgress?.('field', doneBlocks / nBlocks) }
    const i0 = bi * BS, j0 = bj * BS, k0 = bk * BS
    const dc = sd.signed(ox + (i0 + BS / 2) * vx, oy + (j0 + BS / 2) * vx, oz + (k0 + BS / 2) * vx, hint)
    hint = sd.lastTriangle
    if (-dc > maxDepth) maxDepth = -dc
    if (dc + R < -t - T || dc - R > T) continue
    flags[bidx] = 1
    const i1 = Math.min(nx, i0 + BS), j1 = Math.min(ny, j0 + BS), k1 = Math.min(nz, k0 + BS)
    for (let k = k0; k < k1; k++) {
      const z = oz + k * vx
      for (let j = j0; j < j1; j++) {
        const y = oy + j * vx
        let at = i0 + nx * (j + ny * k)
        for (let i = i0; i < i1; i++, at++) {
          const x = ox + i * vx
          band++
          f[at] = evalField(x, y, z)
        }
      }
    }
  }
  const t2 = now()
  o.onProgress?.('field', 1)

  // ---- the surface: marching tetrahedra, then smoothing
  const surface = marchTetrahedra(f, { ox, oy, oz, vx, nx, ny, nz }, flags, {
    signal: o.signal, rawCap: o.rawCap ?? 12_000_000, onProgress: fr => o.onProgress?.('surface', fr),
    tooHeavy: triangles => new MeshError('voronoi_shell.too_heavy', { triangles, limit: o.rawCap ?? 12_000_000, voxel: Math.round(vx * 1000) / 1000 }),
  })
  const t3 = now()
  o.onProgress?.('surface', 1)
  let positions = surface.positions
  let indices = surface.indices
  relaxSurface(positions, indices, f, { ox, oy, oz, vx, nx, ny, nz }, RELAX_STEPS, o)
  if (o.refineTo && o.refineTo > 0) {
    const ref = o.refineTo
    const r = refineSurface(positions, indices, { f: evalField, minEdge: 0.4 * ref, tol: 0.05 * ref, maxStep: 0.5 * vx, maxTriangles: o.refineCap ?? 1_500_000, rounds: 1, relax: 1, signal: o.signal })
    positions = r.positions; indices = r.indices
  }
  // the outer face of the struts lies on the model's own surface: a vertex of that face goes back onto it, so flat faces stay flat and an edge or corner
  // of the model is not rounded off by the grid. Only vertices whose own normal agrees with the direction to the surface move, and the pull fades in
  // with that agreement: the side walls of a strut also come within a voxel of the surface, and pulling those onto it squashes the top of every wall
  // into a ridge of slivers (the saw-tooth along the edges).
  {
    const nv = positions.length / 3
    const vn = new Float64Array(nv * 3)
    for (let t = 0; t < indices.length; t += 3) {
      const a = 3 * (indices[t] as number), b = 3 * (indices[t + 1] as number), c = 3 * (indices[t + 2] as number)
      const ux = (positions[b] as number) - (positions[a] as number), uy = (positions[b + 1] as number) - (positions[a + 1] as number), uz = (positions[b + 2] as number) - (positions[a + 2] as number)
      const wx = (positions[c] as number) - (positions[a] as number), wy = (positions[c + 1] as number) - (positions[a + 1] as number), wz = (positions[c + 2] as number) - (positions[a + 2] as number)
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx
      for (const q of [a, b, c]) { vn[q] = (vn[q] as number) + nx; vn[q + 1] = (vn[q + 1] as number) + ny; vn[q + 2] = (vn[q + 2] as number) + nz }
    }
    const moved = new Float64Array(positions.length)
    moved.set(positions)
    let h = -1
    for (let v = 0; v < positions.length; v += 3) {
      const x = positions[v] as number, y = positions[v + 1] as number, z = positions[v + 2] as number
      const d = sd.signed(x, y, z, h); h = sd.lastTriangle
      if (Math.abs(d) >= 0.75 * vx || snapOk[sd.lastTriangle] === 0) continue
      const mx = sd.lastX - x, my = sd.lastY - y, mz = sd.lastZ - z
      const ml = Math.hypot(mx, my, mz), nl = Math.hypot(vn[v] as number, vn[v + 1] as number, vn[v + 2] as number)
      if (ml < 1e-9 || nl < 1e-12) continue
      const c = Math.abs(mx * (vn[v] as number) + my * (vn[v + 1] as number) + mz * (vn[v + 2] as number)) / (ml * nl)
      const u = Math.min(1, Math.max(0, (c - 0.7) / 0.25))
      const w = u * u * (3 - 2 * u)
      if (w <= 0) continue
      moved[v] = x + mx * w; moved[v + 1] = y + my * w; moved[v + 2] = z + mz * w
    }
    positions.set(moved)
  }
  const out: Mesh = { positions, indices }
  return {
    mesh: out, voxel: vx, grid: [nx, ny, nz], gridCells, bandVoxels: band, seeds: ns, spacing: seeds.spacing, area: seeds.area, rawTriangles: indices.length / 3,
    maxDepth, noCavity: maxDepth + R < t, ms: { pattern: Math.round(t1 - t0), field: Math.round(t2 - t1), surface: Math.round(t3 - t2) },
  }
}
