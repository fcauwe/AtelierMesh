// Shared by the operations that make a surface from a field on a regular grid (the Voronoi shell, the hollow): marching tetrahedra, and the smoothing
// that follows it. Nothing here is random and nothing reads the clock.
//
// Marching tetrahedra: six tetrahedra per cube around one shared diagonal, so neighbouring cubes agree on every face; vertices are shared per grid edge,
// so the surface is closed by construction, and every triangle is turned to face towards increasing f (so the solid is where f < 0 and the normals point out).
import { MeshError } from '@ateliermesh/core'

/** The grid of a field: the position of voxel (0,0,0), the edge of a voxel (mm) and the number of voxels along each axis. The field is stored x fastest. */
export interface Grid { ox: number; oy: number; oz: number; vx: number; nx: number; ny: number; nz: number }

/** Voxels per block: the field is evaluated and meshed block by block, and a block with no surface in it is skipped. */
export const BS = 8

const cancelled = (o: { signal?: AbortSignal | undefined }): void => { if (o.signal?.aborted) throw new MeshError('run.cancelled') }

/** Smooth maximum (polynomial): the plain maximum when the two differ by more than k, rounded joints where they are close. */
export const smax = (a: number, b: number, k: number): number => {
  if (k <= 0) return a > b ? a : b
  const d = a > b ? a - b : b - a
  if (d >= k) return a > b ? a : b
  const h = (k - d) / k
  return (a > b ? a : b) + (h * h * k) / 4
}

// the six tetrahedra of a cube around the diagonal from corner 0 to corner 7 (corner bits: 1 = +x, 2 = +y, 4 = +z)
const TETS = [[0, 1, 3, 7], [0, 2, 3, 7], [0, 2, 6, 7], [0, 4, 6, 7], [0, 4, 5, 7], [0, 1, 5, 7]] as const

export interface MarchOptions {
  signal?: AbortSignal | undefined
  /** More triangles than this make the run fail with the error `tooHeavy` returns. */
  rawCap: number
  tooHeavy: (triangles: number) => Error
  onProgress?: (fraction: number) => void
}

/** The surface f = 0 of a field, in the blocks flagged (1) in `flags` (a block is `bs` x `bs` x `bs` voxels, 8 unless the caller says otherwise). */
export function marchTetrahedra(f: Float32Array, g: Grid, flags: Uint8Array, o: MarchOptions, bs = BS): { positions: Float64Array; indices: Uint32Array } {
  const { ox, oy, oz, vx, nx, ny, nz } = g
  const bnx = Math.ceil(nx / bs), bny = Math.ceil(ny / bs), bnz = Math.ceil(nz / bs)
  const nBlocks = bnx * bny * bnz
  const nxy = nx * ny
  const off = [0, 1, nx, nx + 1, nxy, nxy + 1, nxy + nx, nxy + nx + 1]
  const D = nxy + nx + 2
  const edgeId = new Map<number, number>()
  const pos: number[] = []
  const idx: number[] = []
  const cx = [0, 1, 0, 1, 0, 1, 0, 1], cy = [0, 0, 1, 1, 0, 0, 1, 1], cz = [0, 0, 0, 0, 1, 1, 1, 1]
  const inCorners = [0, 0, 0, 0], outCorners = [0, 0, 0, 0]
  // the cube being worked on, and the direction from its inside corners to its outside corners (for the orientation of the triangles)
  let base = 0, ci = 0, cj = 0, ck = 0, ux = 0, uy = 0, uz = 0
  // the vertex on the grid edge between corner a (inside) and corner b (outside) of the cube: one per edge, shared by every triangle that uses it
  const vertex = (a: number, b: number): number => {
    const ga = base + (off[a] as number), gb = base + (off[b] as number)
    const key = ga < gb ? ga * D + (gb - ga) : gb * D + (ga - gb)
    let id = edgeId.get(key)
    if (id === undefined) {
      const fa = f[ga] as number, fb = f[gb] as number
      let s = fa / (fa - fb)
      if (!(s > 0.001)) s = 0.001; else if (s > 0.999) s = 0.999
      id = pos.length / 3
      pos.push(ox + (ci + (cx[a] as number) + s * ((cx[b] as number) - (cx[a] as number))) * vx, oy + (cj + (cy[a] as number) + s * ((cy[b] as number) - (cy[a] as number))) * vx, oz + (ck + (cz[a] as number) + s * ((cz[b] as number) - (cz[a] as number))) * vx)
      edgeId.set(key, id)
    }
    return id
  }
  const emit = (a: number, b: number, c: number): void => {
    const ax = pos[3 * a] as number, ay = pos[3 * a + 1] as number, az = pos[3 * a + 2] as number
    const e1x = (pos[3 * b] as number) - ax, e1y = (pos[3 * b + 1] as number) - ay, e1z = (pos[3 * b + 2] as number) - az
    const e2x = (pos[3 * c] as number) - ax, e2y = (pos[3 * c + 1] as number) - ay, e2z = (pos[3 * c + 2] as number) - az
    const dot = (e1y * e2z - e1z * e2y) * ux + (e1z * e2x - e1x * e2z) * uy + (e1x * e2y - e1y * e2x) * uz
    if (dot < 0) idx.push(a, c, b); else idx.push(a, b, c)
  }
  let blockDone = 0
  for (let bk = 0; bk < bnz; bk++) for (let bj = 0; bj < bny; bj++) for (let bi = 0; bi < bnx; bi++) {
    if (!flags[bi + bnx * (bj + bny * bk)]) continue
    if ((blockDone++ & 31) === 0) { cancelled(o); o.onProgress?.(Math.min(0.99, (bk * bny * bnx + bj * bnx + bi) / nBlocks)) }
    const i0 = bi * bs, j0 = bj * bs, k0 = bk * bs
    const i1 = Math.min(nx - 1, i0 + bs), j1 = Math.min(ny - 1, j0 + bs), k1 = Math.min(nz - 1, k0 + bs)
    for (let k = k0; k < k1; k++) for (let j = j0; j < j1; j++) {
      let cube = i0 + nx * (j + ny * k)
      for (let i = i0; i < i1; i++, cube++) {
        // a cube is skipped when all eight corners are on one side
        let neg = 0
        for (let c = 0; c < 8; c++) if ((f[cube + (off[c] as number)] as number) < 0) neg++
        if (neg === 0 || neg === 8) continue
        base = cube; ci = i; cj = j; ck = k
        for (const tet of TETS) {
          let nIn = 0, nOut = 0
          for (let q = 0; q < 4; q++) {
            const c = tet[q] as number
            if ((f[cube + (off[c] as number)] as number) < 0) inCorners[nIn++] = c; else outCorners[nOut++] = c
          }
          if (nIn === 0 || nIn === 4) continue
          ux = 0; uy = 0; uz = 0
          for (let q = 0; q < nOut; q++) { const c = outCorners[q] as number; ux += (cx[c] as number) / nOut; uy += (cy[c] as number) / nOut; uz += (cz[c] as number) / nOut }
          for (let q = 0; q < nIn; q++) { const c = inCorners[q] as number; ux -= (cx[c] as number) / nIn; uy -= (cy[c] as number) / nIn; uz -= (cz[c] as number) / nIn }
          if (nIn === 1) { const a = inCorners[0] as number; emit(vertex(a, outCorners[0] as number), vertex(a, outCorners[1] as number), vertex(a, outCorners[2] as number)) }
          else if (nIn === 3) { const b = outCorners[0] as number; emit(vertex(inCorners[0] as number, b), vertex(inCorners[1] as number, b), vertex(inCorners[2] as number, b)) }
          else {
            const i0c = inCorners[0] as number, i1c = inCorners[1] as number, o0 = outCorners[0] as number, o1 = outCorners[1] as number
            const e00 = vertex(i0c, o0), e01 = vertex(i0c, o1), e11 = vertex(i1c, o1), e10 = vertex(i1c, o0)
            emit(e00, e01, e11); emit(e00, e11, e10)
          }
        }
        if (idx.length / 3 > o.rawCap) throw o.tooHeavy(idx.length / 3)
      }
    }
  }
  o.onProgress?.(1)
  return { positions: Float64Array.from(pos), indices: Uint32Array.from(idx) }
}

/**
 * Smooths the vertices and puts them back on the surface: each vertex moves halfway to the mean of its neighbours (which evens out the triangles and
 * the ridges of the grid), then one Newton step along the gradient of the field, taken from the trilinear interpolation of the grid, returns it to f = 0.
 * Neighbours are read from the previous round, so the result does not depend on the order of the vertices.
 */
export function relaxSurface(pos: Float64Array, idx: Uint32Array, f: Float32Array, g: Grid, steps: number, o: { signal?: AbortSignal | undefined }): void {
  const { ox, oy, oz, vx, nx, ny, nz } = g
  const nv = pos.length / 3, nt = idx.length / 3
  const deg = new Int32Array(nv + 1)
  for (let i = 0; i < idx.length; i++) deg[(idx[i] as number) + 1] = (deg[(idx[i] as number) + 1] as number) + 2
  for (let v = 0; v < nv; v++) deg[v + 1] = (deg[v + 1] as number) + (deg[v] as number)
  const nb = new Int32Array(deg[nv] as number)
  const fill = deg.slice(0, nv)
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const a = idx[3 * t + k] as number, b = idx[3 * t + (k + 1) % 3] as number, c = idx[3 * t + (k + 2) % 3] as number
      nb[fill[a] as number] = b; fill[a] = (fill[a] as number) + 1
      nb[fill[a] as number] = c; fill[a] = (fill[a] as number) + 1
    }
  }
  const nxy = nx * ny
  const maxStep = 0.5 * vx
  let cur: Float64Array = pos, next: Float64Array = new Float64Array(pos.length)
  for (let s = 0; s < steps; s++) {
    cancelled(o)
    for (let v = 0; v < nv; v++) {
      let sx = 0, sy = 0, sz = 0
      const lo = deg[v] as number, hi = deg[v + 1] as number
      for (let q = lo; q < hi; q++) { const u = 3 * (nb[q] as number); sx += cur[u] as number; sy += cur[u + 1] as number; sz += cur[u + 2] as number }
      const n = hi - lo
      let x = n > 0 ? 0.5 * (cur[3 * v] as number) + 0.5 * (sx / n) : (cur[3 * v] as number)
      let y = n > 0 ? 0.5 * (cur[3 * v + 1] as number) + 0.5 * (sy / n) : (cur[3 * v + 1] as number)
      let z = n > 0 ? 0.5 * (cur[3 * v + 2] as number) + 0.5 * (sz / n) : (cur[3 * v + 2] as number)
      // one Newton step onto f = 0
      const gx = (x - ox) / vx, gy = (y - oy) / vx, gz = (z - oz) / vx
      const i = Math.min(nx - 2, Math.max(0, Math.floor(gx))), j = Math.min(ny - 2, Math.max(0, Math.floor(gy))), k = Math.min(nz - 2, Math.max(0, Math.floor(gz)))
      const tx = Math.min(1, Math.max(0, gx - i)), ty = Math.min(1, Math.max(0, gy - j)), tz = Math.min(1, Math.max(0, gz - k))
      const b = i + nx * j + nxy * k
      const c000 = f[b] as number, c100 = f[b + 1] as number, c010 = f[b + nx] as number, c110 = f[b + nx + 1] as number
      const c001 = f[b + nxy] as number, c101 = f[b + nxy + 1] as number, c011 = f[b + nxy + nx] as number, c111 = f[b + nxy + nx + 1] as number
      const val = (c000 * (1 - tx) + c100 * tx) * (1 - ty) * (1 - tz) + (c010 * (1 - tx) + c110 * tx) * ty * (1 - tz) + (c001 * (1 - tx) + c101 * tx) * (1 - ty) * tz + (c011 * (1 - tx) + c111 * tx) * ty * tz
      const dx = ((c100 - c000) * (1 - ty) * (1 - tz) + (c110 - c010) * ty * (1 - tz) + (c101 - c001) * (1 - ty) * tz + (c111 - c011) * ty * tz) / vx
      const dy = ((c010 - c000) * (1 - tx) * (1 - tz) + (c110 - c100) * tx * (1 - tz) + (c011 - c001) * (1 - tx) * tz + (c111 - c101) * tx * tz) / vx
      const dz = ((c001 - c000) * (1 - tx) * (1 - ty) + (c101 - c100) * tx * (1 - ty) + (c011 - c010) * (1 - tx) * ty + (c111 - c110) * tx * ty) / vx
      const g2 = dx * dx + dy * dy + dz * dz
      if (g2 > 1e-12) {
        let m = -val / g2
        const len = Math.abs(m) * Math.sqrt(g2)
        if (len > maxStep) m *= maxStep / len
        x += m * dx; y += m * dy; z += m * dz
      }
      next[3 * v] = x; next[3 * v + 1] = y; next[3 * v + 2] = z
    }
    const t = cur; cur = next; next = t
  }
  if (cur !== pos) pos.set(cur)
}

// ------------------------------------------------------------------------------------------------------------------------------ refinement

/** A projection moves a vertex by at most this fraction of the mean length of its edges, so one step cannot throw it across the surface. */
const STEPF = 0.25

export interface RefineOptions {
  /** The exact field at any point (negative inside the solid). The surface is projected onto its zero set. */
  f: (x: number, y: number, z: number) => number
  /** An edge shorter than this (mm) is never split. */
  minEdge: number
  /** An edge is split when the field at its midpoint is further than this from zero (the surface sags between its ends). */
  tol: number
  /** The largest step of one projection (mm). */
  maxStep: number
  /** Splitting stops when the mesh would have more triangles than this. */
  maxTriangles: number
  /** Rounds of splitting (each at most halves the edges). */
  rounds: number
  /** Rounds of tangential smoothing with projection at the end. */
  relax: number
  signal?: AbortSignal | undefined
}

/** Vertex normals (area-weighted, not normalised by area: unit length). */
function vertexNormals(pos: Float64Array, idx: Uint32Array): Float64Array {
  const vn = new Float64Array(pos.length)
  for (let t = 0; t < idx.length; t += 3) {
    const a = 3 * (idx[t] as number), b = 3 * (idx[t + 1] as number), c = 3 * (idx[t + 2] as number)
    const ux = (pos[b] as number) - (pos[a] as number), uy = (pos[b + 1] as number) - (pos[a + 1] as number), uz = (pos[b + 2] as number) - (pos[a + 2] as number)
    const wx = (pos[c] as number) - (pos[a] as number), wy = (pos[c + 1] as number) - (pos[a + 1] as number), wz = (pos[c + 2] as number) - (pos[a + 2] as number)
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx
    for (const q of [a, b, c]) { vn[q] = (vn[q] as number) + nx; vn[q + 1] = (vn[q + 1] as number) + ny; vn[q + 2] = (vn[q + 2] as number) + nz }
  }
  for (let v = 0; v < vn.length; v += 3) {
    const l = Math.hypot(vn[v] as number, vn[v + 1] as number, vn[v + 2] as number)
    if (l > 1e-300) { vn[v] = (vn[v] as number) / l; vn[v + 1] = (vn[v + 1] as number) / l; vn[v + 2] = (vn[v + 2] as number) / l }
  }
  return vn
}



/** Triangles around each vertex: start offsets and the list. */
function vertexTriangles(nv: number, idx: Uint32Array): { start: Int32Array; list: Int32Array } {
  const start = new Int32Array(nv + 1)
  for (let i = 0; i < idx.length; i++) start[(idx[i] as number) + 1] = (start[(idx[i] as number) + 1] as number) + 1
  for (let v = 0; v < nv; v++) start[v + 1] = (start[v + 1] as number) + (start[v] as number)
  const fill = start.slice(0, nv), list = new Int32Array(idx.length)
  for (let i = 0; i < idx.length; i++) { const v = idx[i] as number; list[fill[v] as number] = Math.floor(i / 3); fill[v] = (fill[v] as number) + 1 }
  return { start, list }
}

/** The area normal of triangle t, with vertex v at (x, y, z) instead of where it is. */
function triNormal(pos: Float64Array, idx: Uint32Array, t: number, v: number, x: number, y: number, z: number, out: number[]): void {
  const p = (k: number, c: number): number => (idx[3 * t + k] === v ? (c === 0 ? x : c === 1 ? y : z) : (pos[3 * (idx[3 * t + k] as number) + c] as number))
  const ux = p(1, 0) - p(0, 0), uy = p(1, 1) - p(0, 1), uz = p(1, 2) - p(0, 2), wx = p(2, 0) - p(0, 0), wy = p(2, 1) - p(0, 1), wz = p(2, 2) - p(0, 2)
  out[0] = uy * wz - uz * wy; out[1] = uz * wx - ux * wz; out[2] = ux * wy - uy * wx
}


/** Mean length of the edges at vertex v. */
function localEdge(pos: Float64Array, idx: Uint32Array, vt: { start: Int32Array; list: Int32Array }, v: number): number {
  let sum = 0, n = 0
  for (let q = vt.start[v] as number; q < (vt.start[v + 1] as number); q++) {
    const t = vt.list[q] as number
    for (let k = 0; k < 3; k++) {
      const u = idx[3 * t + k] as number
      if (u === v) continue
      sum += Math.hypot((pos[3 * u] as number) - (pos[3 * v] as number), (pos[3 * u + 1] as number) - (pos[3 * v + 1] as number), (pos[3 * u + 2] as number) - (pos[3 * v + 2] as number)); n++
    }
  }
  return n > 0 ? sum / n : 0
}

/** Moves vertex v towards (x, y, z), keeping every triangle around it facing the way it did (no folds): the move is halved up to three times, else refused. */
function safeMove(pos: Float64Array, idx: Uint32Array, vt: { start: Int32Array; list: Int32Array }, v: number, x: number, y: number, z: number): void {
  const ox = pos[3 * v] as number, oy = pos[3 * v + 1] as number, oz = pos[3 * v + 2] as number
  const a = [0, 0, 0], b = [0, 0, 0]
  let f = 1
  for (let tries = 0; tries < 4; tries++, f *= 0.5) {
    const nx = ox + (x - ox) * f, ny = oy + (y - oy) * f, nz = oz + (z - oz) * f
    let ok = true
    for (let q = vt.start[v] as number; q < (vt.start[v + 1] as number) && ok; q++) {
      const t = vt.list[q] as number
      triNormal(pos, idx, t, v, ox, oy, oz, a); triNormal(pos, idx, t, v, nx, ny, nz, b)
      const la = Math.hypot(a[0] as number, a[1] as number, a[2] as number), lb = Math.hypot(b[0] as number, b[1] as number, b[2] as number)
      // the triangle must keep facing within about 60 degrees of where it faced (a triangle that is nearly flat already may do what it likes)
      if (la > 1e-12 && (lb < 1e-14 || ((a[0] as number) * (b[0] as number) + (a[1] as number) * (b[1] as number) + (a[2] as number) * (b[2] as number)) / (la * lb) < 0.5)) ok = false
    }
    if (ok) { pos[3 * v] = nx; pos[3 * v + 1] = ny; pos[3 * v + 2] = nz; return }
  }
}

/** One secant step of a point onto f = 0 along the unit direction n (the surface normal): two evaluations of the exact field. */
function project(f: RefineOptions['f'], x: number, y: number, z: number, nx: number, ny: number, nz: number, h: number, maxStep: number, out: number[]): void {
  const v = f(x, y, z)
  let slope = (f(x + h * nx, y + h * ny, z + h * nz) - v) / h
  if (!(slope > 0.25)) slope = 1 // a field that is flat or turns the wrong way here: assume a distance field
  let m = -v / slope
  if (m > maxStep) m = maxStep; else if (m < -maxStep) m = -maxStep
  out[0] = x + m * nx; out[1] = y + m * ny; out[2] = z + m * nz
}

/**
 * Adaptive refinement of an extracted surface against the exact field. The vertices are projected onto f = 0; then every edge that is long enough and
 * either sags (the field at its midpoint is not zero) or joins vertices whose normals differ by more than 20 degrees is split at its midpoint, and the
 * triangles are cut along their split edges (1, 2 or 3 per triangle, so no edge is split on one side only and the surface stays closed and manifold).
 * New vertices are projected; the process repeats `rounds` times, then the vertices are smoothed tangentially (the move along the normal is dropped)
 * and projected again, so the surface does not shrink. Deterministic: the edges are visited in the order of the triangles.
 */
export function refineSurface(pos0: Float64Array, idx0: Uint32Array, o: RefineOptions): { positions: Float64Array; indices: Uint32Array } {
  let pos = pos0, idx = idx0
  const h = Math.max(o.maxStep * 0.1, 1e-4)
  const tmp = [0, 0, 0]
  const projectAll = (from: number): void => {
    const vt = vertexTriangles(pos.length / 3, idx), vnn = vertexNormals(pos, idx)
    for (let v = from; v < pos.length / 3; v++) {
      if ((v & 1023) === 0 && o.signal?.aborted) throw new MeshError('run.cancelled')
      project(o.f, pos[3 * v] as number, pos[3 * v + 1] as number, pos[3 * v + 2] as number, vnn[3 * v] as number, vnn[3 * v + 1] as number, vnn[3 * v + 2] as number, h, Math.min(o.maxStep, STEPF * localEdge(pos, idx, vt, v)), tmp)
      safeMove(pos, idx, vt, v, tmp[0] as number, tmp[1] as number, tmp[2] as number)
    }
  }
  projectAll(0)
  const cosLimit = Math.cos((20 * Math.PI) / 180)
  for (let round = 0; round < o.rounds; round++) {
    const nt = idx.length / 3, nv = pos.length / 3
    const vn = vertexNormals(pos, idx)
    const marked = new Map<number, number>() // edge key -> index of the midpoint vertex (assigned below)
    const order: number[] = []
    const seen = new Set<number>()
    for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
      const a = idx[3 * t + k] as number, b = idx[3 * t + ((k + 1) % 3)] as number
      const key = a < b ? a * nv + b : b * nv + a
      if (seen.has(key)) continue
      seen.add(key)
      const dx = (pos[3 * a] as number) - (pos[3 * b] as number), dy = (pos[3 * a + 1] as number) - (pos[3 * b + 1] as number), dz = (pos[3 * a + 2] as number) - (pos[3 * b + 2] as number)
      const len = Math.hypot(dx, dy, dz)
      if (len < o.minEdge) continue
      const bend = (vn[3 * a] as number) * (vn[3 * b] as number) + (vn[3 * a + 1] as number) * (vn[3 * b + 1] as number) + (vn[3 * a + 2] as number) * (vn[3 * b + 2] as number)
      let split = bend < cosLimit
      if (!split) {
        const sag = o.f(((pos[3 * a] as number) + (pos[3 * b] as number)) / 2, ((pos[3 * a + 1] as number) + (pos[3 * b + 1] as number)) / 2, ((pos[3 * a + 2] as number) + (pos[3 * b + 2] as number)) / 2)
        split = Math.abs(sag) > o.tol
      }
      if (split) order.push(key)
    }
    if (order.length === 0) break
    // each split edge adds about two triangles
    const room = Math.floor((o.maxTriangles - nt) / 2)
    if (room <= 0) break
    if (order.length > room) order.length = room
    let nvNew = nv
    for (const key of order) marked.set(key, nvNew++)
    const np = new Float64Array(nvNew * 3)
    np.set(pos)
    for (const key of order) {
      const a = Math.floor(key / nv), b = key - a * nv, m = marked.get(key) as number
      np[3 * m] = ((pos[3 * a] as number) + (pos[3 * b] as number)) / 2; np[3 * m + 1] = ((pos[3 * a + 1] as number) + (pos[3 * b + 1] as number)) / 2; np[3 * m + 2] = ((pos[3 * a + 2] as number) + (pos[3 * b + 2] as number)) / 2
    }
    const out: number[] = []
    const mid = (a: number, b: number): number => { const m = marked.get(a < b ? a * nv + b : b * nv + a); return m === undefined ? -1 : m }
    const dist2 = (a: number, b: number): number => ((np[3 * a] as number) - (np[3 * b] as number)) ** 2 + ((np[3 * a + 1] as number) - (np[3 * b + 1] as number)) ** 2 + ((np[3 * a + 2] as number) - (np[3 * b + 2] as number)) ** 2
    for (let t = 0; t < nt; t++) {
      const v0 = idx[3 * t] as number, v1 = idx[3 * t + 1] as number, v2 = idx[3 * t + 2] as number
      const m0 = mid(v0, v1), m1 = mid(v1, v2), m2 = mid(v2, v0)
      const n = (m0 >= 0 ? 1 : 0) + (m1 >= 0 ? 1 : 0) + (m2 >= 0 ? 1 : 0)
      if (n === 0) { out.push(v0, v1, v2); continue }
      if (n === 3) { out.push(v0, m0, m2, m0, v1, m1, m2, m1, v2, m0, m1, m2); continue }
      if (n === 1) {
        if (m0 >= 0) out.push(v0, m0, v2, m0, v1, v2)
        else if (m1 >= 0) out.push(v1, m1, v0, m1, v2, v0)
        else out.push(v2, m2, v1, m2, v0, v1)
        continue
      }
      // two split edges: a corner triangle at the shared vertex and a quad cut along its shorter diagonal
      let c: number, p: number, q: number, mp: number, mq: number // c is the shared vertex, p and q the other two, mp on (c,p), mq on (c,q)
      if (m0 < 0) { c = v2; p = v0; q = v1; mp = m2; mq = m1 } // edges (v1,v2) and (v2,v0) are split
      else if (m1 < 0) { c = v0; p = v1; q = v2; mp = m0; mq = m2 } // edges (v0,v1) and (v2,v0)
      else { c = v1; p = v2; q = v0; mp = m1; mq = m0 } // edges (v1,v2) and (v0,v1)
      out.push(c, mp, mq)
      // the quad is p, q, mq, mp; the triangle (c,p,q) is wound c -> p -> q, which is the order of the original
      if (dist2(p, mq) <= dist2(q, mp)) out.push(mp, p, mq, p, q, mq)
      else out.push(mp, p, q, mp, q, mq)
    }
    pos = np
    idx = Uint32Array.from(out)
    projectAll(nv)
  }
  // tangential smoothing, then back onto the surface
  for (let s = 0; s < o.relax; s++) {
    const nv = pos.length / 3, vn = vertexNormals(pos, idx)
    const sum = new Float64Array(nv * 3), cnt = new Int32Array(nv)
    for (let t = 0; t < idx.length; t += 3) for (let k = 0; k < 3; k++) {
      const a = idx[t + k] as number, b = idx[t + ((k + 1) % 3)] as number, c = idx[t + ((k + 2) % 3)] as number
      for (const q of [b, c]) { sum[3 * a] = (sum[3 * a] as number) + (pos[3 * q] as number); sum[3 * a + 1] = (sum[3 * a + 1] as number) + (pos[3 * q + 1] as number); sum[3 * a + 2] = (sum[3 * a + 2] as number) + (pos[3 * q + 2] as number); cnt[a] = (cnt[a] as number) + 1 }
    }
    const vt = vertexTriangles(nv, idx)
    for (let v = 0; v < nv; v++) {
      const n = cnt[v] as number
      let x = pos[3 * v] as number, y = pos[3 * v + 1] as number, z = pos[3 * v + 2] as number
      if (n > 0) {
        let dx = (sum[3 * v] as number) / n - x, dy = (sum[3 * v + 1] as number) / n - y, dz = (sum[3 * v + 2] as number) / n - z
        const dn = dx * (vn[3 * v] as number) + dy * (vn[3 * v + 1] as number) + dz * (vn[3 * v + 2] as number)
        dx -= dn * (vn[3 * v] as number); dy -= dn * (vn[3 * v + 1] as number); dz -= dn * (vn[3 * v + 2] as number)
        x += 0.5 * dx; y += 0.5 * dy; z += 0.5 * dz
      }
      project(o.f, x, y, z, vn[3 * v] as number, vn[3 * v + 1] as number, vn[3 * v + 2] as number, h, Math.min(o.maxStep, STEPF * localEdge(pos, idx, vt, v)), tmp)
      safeMove(pos, idx, vt, v, tmp[0] as number, tmp[1] as number, tmp[2] as number)
    }
    if (o.signal?.aborted) throw new MeshError('run.cancelled')
  }
  return { positions: pos, indices: idx }
}
