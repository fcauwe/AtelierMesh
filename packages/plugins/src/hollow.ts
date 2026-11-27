// Hollow: a closed model gets a cavity inside, so the part has a wall of `thickness` mm and the rest is air.
//
// The method is a signed distance field on a regular voxel grid (the same field code as the Voronoi shell, see implicit/iso.ts and voronoi/sdf.ts):
//
//   A. Without an opening the OUTER SURFACE IS NOT TOUCHED: every vertex and triangle of the input (letters, textures, segments, bodies) stays as it is.
//      The cavity is the surface d = -thickness of the signed distance d (negative inside), found by marching tetrahedra on the narrow band around it,
//      smoothed and put back onto the surface, and added to the mesh with its triangles facing into the void. The result is the outer surface plus an
//      inner closed surface: one closed manifold solid with an internal void.
//   B. With an opening (a round hole along Z through the top and/or the bottom) the outer surface has to be cut, so the whole result is made again from
//      the field: wall = max(d, -d - thickness), the hole is subtracted with a rounded joint, and the surface is extracted and smoothed. The outer
//      surface is then a new mesh of about the same shape (the report says so).
//
// Nothing here is random and nothing reads the clock except the timings in the report.
import { MeshError, measureMesh } from '@ateliermesh/core'
import type { Mesh, SegmentInfo } from '@ateliermesh/core'
import { BS, marchTetrahedra, relaxSurface, smax } from './implicit/iso'
import type { Grid } from './implicit/iso'
import { MeshDistance } from './voronoi/sdf'
import { HoleFailure, crossSection, cutOnce, nudged } from './holes'
import type { Cutter } from './holes'

export type HollowStage = 'field' | 'surface' | 'cavity'

export interface HollowOptions {
  thickness: number
  opening: 'none' | 'bottom' | 'top' | 'both'
  openingDiameter: number
  /** Rounding, mm: how much the cavity is smoothed (and, with an opening, the rounding of the rim). 0 keeps the raw result of the grid. */
  smooth: number
  /** Edge of a voxel, mm. */
  voxel: number
  /** The name of the segment given to the cavity's triangles; empty for none. */
  cavitySegment: string
  /** The most voxels in the grid; above it the run is refused. Default 60 million. */
  gridCap?: number
  /** The most triangles marching tetrahedra may produce before the run is refused. Default 12 million. */
  rawCap?: number
  signal?: AbortSignal
  onProgress?: (stage: HollowStage, fraction: number) => void
}

export interface HollowResult {
  mesh: Mesh
  /** False when no cavity could be made (the model is thinner than the wall everywhere): the mesh is then the input. */
  hollowed: boolean
  /** True with an opening: the outer surface was made again from the field. */
  remeshed: boolean
  voxel: number
  grid: [number, number, number]
  gridCells: number
  /** Voxels at which the distance was evaluated. */
  bandVoxels: number
  cavityTriangles: number
  /** The volume of the cavity, mm3 (with an opening the cavity is open and there is no such number: null). */
  cavityVolume: number | null
  /** Closed pieces of the cavity that were left out because they are only noise of the grid (a few voxels wide). */
  droppedBubbles: number
  /** The deepest point found inside the model, sampled once per block, mm. */
  maxDepth: number
  /** The wall measured at up to 1500 points of the cavity: thinnest and mean, mm. */
  wall: { min: number; mean: number } | null
  ms: { field: number; surface: number; cavity: number }
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())
const cancelled = (o: { signal?: AbortSignal | undefined }): void => { if (o.signal?.aborted) throw new MeshError('run.cancelled') }
/** Rounds of smoothing after marching tetrahedra for a rounding of `smooth` mm: three at the default (0.6 mm with a voxel a third of a 2 mm wall). */
const relaxSteps = (smooth: number, voxel: number): number => (smooth <= 0 ? 0 : Math.min(8, Math.max(1, Math.round((smooth / voxel) * 3))))

/** Which body a triangle is in, for a mesh whose groups cover it, or null (no groups). Throws for what cannot be hollowed. */
function bodies(mesh: Mesh): { starts: number[]; order: number[] } | null {
  const g = mesh.groups
  if (!g || g.length === 0) return null
  const nt = mesh.indices.length / 3
  if (g.some(x => x.role === 'negative')) throw new MeshError('hollow.groups_unsupported', { reason: 'negative_body', groups: g.length })
  const order = g.map((_, i) => i).sort((a, b) => (g[a] as { start: number }).start - (g[b] as { start: number }).start)
  let at = 0
  for (const i of order) { const x = g[i] as { start: number; count: number }; if (x.start !== at) { at = -1; break } at += x.count }
  if (at !== nt) {
    if (g.length === 1) return null   // one group that does not cover the mesh is not a reason to refuse: it is treated as one body
    throw new MeshError('hollow.groups_unsupported', { reason: 'not_covering', groups: g.length })
  }
  return { starts: g.map(x => x.start), order }
}

interface Cavity { positions: Float64Array; indices: Uint32Array; dropped: number }

/** Drops the closed pieces that are only a few voxels wide (noise at the thin places where the cavity almost vanishes), and numbers the vertices again. */
function dropBubbles(pos: Float64Array, idx: Uint32Array, voxel: number): Cavity {
  const nv = pos.length / 3, nt = idx.length / 3
  const parent = new Int32Array(nv); for (let i = 0; i < nv; i++) parent[i] = i
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a] as number] as number; a = parent[a] as number } return a }
  for (let t = 0; t < nt; t++) {
    const a = find(idx[3 * t] as number), b = find(idx[3 * t + 1] as number), c = find(idx[3 * t + 2] as number)
    if (a !== b) parent[b] = a
    const r = find(a); if (find(c) !== r) parent[find(c)] = r
  }
  const x0 = new Float64Array(nv).fill(Infinity), y0 = new Float64Array(nv).fill(Infinity), z0 = new Float64Array(nv).fill(Infinity)
  const x1 = new Float64Array(nv).fill(-Infinity), y1 = new Float64Array(nv).fill(-Infinity), z1 = new Float64Array(nv).fill(-Infinity)
  const tris = new Int32Array(nv)
  for (let v = 0; v < nv; v++) {
    const r = find(v)
    const x = pos[3 * v] as number, y = pos[3 * v + 1] as number, z = pos[3 * v + 2] as number
    if (x < (x0[r] as number)) x0[r] = x; if (x > (x1[r] as number)) x1[r] = x
    if (y < (y0[r] as number)) y0[r] = y; if (y > (y1[r] as number)) y1[r] = y
    if (z < (z0[r] as number)) z0[r] = z; if (z > (z1[r] as number)) z1[r] = z
  }
  for (let t = 0; t < nt; t++) { const r = find(idx[3 * t] as number); tris[r] = (tris[r] as number) + 1 }
  const keep = new Uint8Array(nv); let dropped = 0
  const seen = new Set<number>()
  for (let v = 0; v < nv; v++) {
    const r = find(v)
    const ext = Math.max((x1[r] as number) - (x0[r] as number), (y1[r] as number) - (y0[r] as number), (z1[r] as number) - (z0[r] as number))
    const small = (tris[r] as number) < 24 || ext < 3 * voxel
    keep[v] = small ? 0 : 1
    if (small && !seen.has(r)) { seen.add(r); dropped++ }
  }
  if (dropped === 0) return { positions: pos, indices: idx, dropped: 0 }
  const map = new Int32Array(nv).fill(-1); let n = 0
  for (let v = 0; v < nv; v++) if (keep[v]) map[v] = n++
  const p2 = new Float64Array(3 * n)
  for (let v = 0; v < nv; v++) if (keep[v]) { const m = (map[v] as number) * 3; p2[m] = pos[3 * v] as number; p2[m + 1] = pos[3 * v + 1] as number; p2[m + 2] = pos[3 * v + 2] as number }
  const out: number[] = []
  for (let t = 0; t < nt; t++) { const a = idx[3 * t] as number; if (keep[a]) out.push(map[a] as number, map[idx[3 * t + 1] as number] as number, map[idx[3 * t + 2] as number] as number) }
  return { positions: p2, indices: Uint32Array.from(out), dropped }
}

/** The connected pieces of a mesh: a piece number per triangle and how many pieces there are. */
function pieces(idx: Uint32Array, nv: number): { of: Int32Array; count: number; firstVertex: number[] } {
  const nt = idx.length / 3
  const parent = new Int32Array(nv); for (let i = 0; i < nv; i++) parent[i] = i
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a] as number] as number; a = parent[a] as number } return a }
  for (let t = 0; t < nt; t++) {
    const a = find(idx[3 * t] as number), b = find(idx[3 * t + 1] as number)
    if (a !== b) parent[b] = a
    const c = find(idx[3 * t + 2] as number), r = find(a)
    if (c !== r) parent[c] = r
  }
  const id = new Map<number, number>(), of = new Int32Array(nt), firstVertex: number[] = []
  for (let t = 0; t < nt; t++) {
    const r = find(idx[3 * t] as number)
    let k = id.get(r)
    if (k === undefined) { k = id.size; id.set(r, k); firstVertex.push(idx[3 * t] as number) }
    of[t] = k
  }
  return { of, count: id.size, firstVertex }
}

/**
 * An opening by an exact cut: the hollow is made without an opening (the outside stays as it was, every edge sharp), and a round cutter along Z is subtracted
 * from the top and/or the bottom, down into the void. Null when that does not work (no void under the axis, a cut that is not closed): the caller then
 * makes the whole result from the field.
 */
function hollowThenCut(mesh: Mesh, o: HollowOptions): HollowResult | null {
  const first = hollowMesh(mesh, { ...o, opening: 'none' })
  if (!first.hollowed) return first
  const m = measureMesh(mesh)
  const sd = MeshDistance.create(mesh, m.volume < 0 ? -1 : 1)
  if (!sd) return null
  const P = mesh.positions
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i] as number, y = P[i + 1] as number, z = P[i + 2] as number
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z
  }
  const ax = (x0 + x1) / 2, ay = (y0 + y1) / 2, t = o.thickness
  // the first point on the axis, seen from the end, that is clearly in the void (further from the outside than the wall); the cutter stops there
  const voidAt = (fromTop: boolean): number | null => {
    const step = Math.max(o.voxel / 2, 0.05)
    let h = -1
    for (let z = fromTop ? z1 : z0; fromTop ? z >= z0 : z <= z1; z += fromTop ? -step : step) {
      const d = sd.signed(ax, ay, z, h); h = sd.lastTriangle
      if (-d > 1.5 * t) return z
    }
    return null
  }
  const section = crossSection('round', o.openingDiameter, 0, 0, 96)
  const cutters: Cutter[] = []
  for (const top of [true, false]) {
    if (top ? !(o.opening === 'top' || o.opening === 'both') : !(o.opening === 'bottom' || o.opening === 'both')) continue
    const zv = voidAt(top)
    if (zv === null) return null
    const end = top ? z1 - zv : zv - z0   // how far along the axis, from the end of the model, the cutter goes
    cutters.push({ origin: [ax, ay, top ? z1 : z0], axis: [0, 0, top ? -1 : 1], e1: [1, 0, 0], e2: [0, top ? 1 : -1, 0], section, zTop: -1, scaleTop: 1, zBottom: end, scaleBottom: 1 })
  }
  let cur: { positions: Float64Array; indices: Uint32Array; labels?: Uint16Array } = { positions: first.mesh.positions, indices: first.mesh.indices, ...(first.mesh.segments ? { labels: first.mesh.segments.labels } : {}) }
  for (const c of cutters) {
    let done: ReturnType<typeof cutOnce> | null = null
    for (let a = 0; a < 5 && !done; a++) {
      try {
        const r = cutOnce(cur, nudged(c, a), { signal: o.signal })
        if (measureMesh({ positions: r.positions, indices: r.indices }).watertight) done = r
      } catch (e) { if (!(e instanceof HoleFailure)) throw e }
    }
    if (!done) return null
    cur = { positions: done.positions, indices: done.indices, ...(done.labels ? { labels: done.labels } : {}) }
  }
  const out: Mesh = { positions: cur.positions, indices: cur.indices }
  if (first.mesh.segments && cur.labels) out.segments = { labels: cur.labels, table: first.mesh.segments.table }
  if (first.mesh.groups && first.mesh.groups.length === 1) out.groups = [{ ...first.mesh.groups[0]!, start: 0, count: cur.indices.length / 3 }]
  return { ...first, mesh: out, remeshed: false, cavityVolume: null }
}

export function hollowMesh(mesh: Mesh, o: HollowOptions): HollowResult {
  if (o.opening !== 'none' && !(mesh.groups && mesh.groups.length > 1)) { const r = hollowThenCut(mesh, o); if (r) return r }
  const t0 = now()
  const body = bodies(mesh)
  const m = measureMesh(mesh)
  const outward = m.volume < 0 ? -1 : 1
  const sd = MeshDistance.create(mesh, outward)
  if (!sd) throw new MeshError('hollow.bad_input', { reason: 'not_closed' })
  const t = o.thickness
  const vx = o.voxel
  const remesh = o.opening !== 'none'
  if (remesh && mesh.groups && mesh.groups.length > 1) throw new MeshError('hollow.groups_unsupported', { reason: 'opening_needs_one_body', groups: mesh.groups.length })

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
  if (gridCells > cap) throw new MeshError('hollow.too_heavy', { cells: gridCells, limit: cap, voxel: Math.round(vx * 1000) / 1000 })
  const grid: Grid = { ox, oy, oz, vx, nx, ny, nz }

  // ---- the field, in blocks. A block of 8 voxels is looked at first, by one distance at its centre: the distance changes by no more than the distance
  // moved, so when the surface we want is further from the centre than the block is large, the whole block has one sign and one constant fills it.
  // A block that may hold the surface is split into eight of 4 voxels and the same test is made again, and only the voxels of a block of 4 that may
  // hold the surface are measured one by one (the far ones are the expensive ones: many triangles are about as near).
  // A: f = -d - t (negative in the wall and outside, positive in the void), so the surface f = 0 is the cavity and marching tetrahedra turn its
  // triangles towards the void. B: f = the wall with the hole taken out of it.
  const T = 2.2 * vx
  const FB = 4
  const f = new Float32Array(gridCells)
  const bnx = Math.ceil(nx / BS), bny = Math.ceil(ny / BS), bnz = Math.ceil(nz / BS)
  const fnx = Math.ceil(nx / FB), fny = Math.ceil(ny / FB), fnz = Math.ceil(nz / FB)
  const flags = new Uint8Array(fnx * fny * fnz)
  const nBlocks = bnx * bny * bnz
  const axisX = (bx0 + bx1) / 2, axisY = (by0 + by1) / 2, zc = (bz0 + bz1) / 2
  const r0 = o.openingDiameter / 2
  const wantBottom = o.opening === 'bottom' || o.opening === 'both', wantTop = o.opening === 'top' || o.opening === 'both'
  let maxDepth = 0, band = 0, hint = -1, doneBlocks = 0
  const voxelsOf = (i0: number, j0: number, k0: number, size: number): void => {
    const i1 = Math.min(nx, i0 + size), j1 = Math.min(ny, j0 + size), k1 = Math.min(nz, k0 + size)
    for (let k = k0; k < k1; k++) {
      const z = oz + k * vx
      for (let j = j0; j < j1; j++) {
        const y = oy + j * vx
        let at = i0 + nx * (j + ny * k)
        for (let i = i0; i < i1; i++, at++) {
          const x = ox + i * vx
          const d = sd.signed(x, y, z, hint)
          hint = sd.lastTriangle
          band++
          if (!remesh) { f[at] = -d - t; continue }
          let v = d > -d - t ? d : -d - t
          if (wantBottom || wantTop) {
            const inZone = (wantBottom && z < zc) || (wantTop && z > zc)
            if (inZone) v = smax(v, r0 - Math.hypot(x - axisX, y - axisY), o.smooth)
          }
          f[at] = v
        }
      }
    }
  }
  const block = (i0: number, j0: number, k0: number, size: number): void => {
    if (i0 >= nx || j0 >= ny || k0 >= nz) return
    const dc = sd.signed(ox + (i0 + size / 2) * vx, oy + (j0 + size / 2) * vx, oz + (k0 + size / 2) * vx, hint)
    hint = sd.lastTriangle
    if (-dc > maxDepth) maxDepth = -dc
    const Rb = (Math.sqrt(3) * size * vx) / 2
    // is anything of the surface we want near this block?
    const near = remesh ? !(dc + Rb < -t - T || dc - Rb > T) : Math.abs(dc + t) <= Rb + T
    if (!near) {
      const outside = remesh ? T : (-dc - t > 0 ? T : -T)
      const i1 = Math.min(nx, i0 + size), j1 = Math.min(ny, j0 + size), k1 = Math.min(nz, k0 + size)
      for (let k = k0; k < k1; k++) for (let j = j0; j < j1; j++) { const at = i0 + nx * (j + ny * k); f.fill(outside, at, at + (i1 - i0)) }
      return
    }
    if (size > FB) {
      const h = size / 2
      for (let dk = 0; dk < 2; dk++) for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) block(i0 + di * h, j0 + dj * h, k0 + dk * h, h)
      return
    }
    flags[i0 / FB + fnx * (j0 / FB + fny * (k0 / FB))] = 1
    voxelsOf(i0, j0, k0, size)
  }
  o.onProgress?.('field', 0)
  for (let bk = 0; bk < bnz; bk++) for (let bj = 0; bj < bny; bj++) for (let bi = 0; bi < bnx; bi++) {
    if ((doneBlocks++ & 63) === 0) { cancelled(o); o.onProgress?.('field', doneBlocks / nBlocks) }
    block(bi * BS, bj * BS, bk * BS, BS)
  }
  const t1 = now()
  o.onProgress?.('field', 1)

  // ---- the surface
  const raw = marchTetrahedra(f, grid, flags, {
    signal: o.signal, rawCap: o.rawCap ?? 12_000_000, onProgress: fr => o.onProgress?.('surface', fr),
    tooHeavy: triangles => new MeshError('hollow.too_heavy', { triangles, limit: o.rawCap ?? 12_000_000, voxel: Math.round(vx * 1000) / 1000 }),
  }, FB)
  const t2 = now()
  const steps = relaxSteps(o.smooth, vx)
  if (steps > 0 && raw.indices.length > 0) relaxSurface(raw.positions, raw.indices, f, grid, steps, o)
  cancelled(o)
  o.onProgress?.('cavity', 0)
  const base = { voxel: vx, grid: [nx, ny, nz] as [number, number, number], gridCells, bandVoxels: band, maxDepth }
  const ms = (): HollowResult['ms'] => ({ field: Math.round(t1 - t0), surface: Math.round(t2 - t1), cavity: Math.round(now() - t2) })

  // ---- B: the whole result is the new surface
  if (remesh) {
    const indices = raw.indices
    const out: Mesh = { positions: raw.positions, indices: outward < 0 ? flipped(indices) : indices }
    if (indices.length === 0) return { ...base, mesh, hollowed: false, remeshed: false, cavityTriangles: 0, cavityVolume: null, droppedBubbles: 0, wall: null, ms: ms() }
    // the cavity's triangles get their segment: a triangle is cavity when it is nearer to the surface d = -t than to the outer surface d = 0
    if (o.cavitySegment !== '') {
      const positions = out.positions
      const nv = positions.length / 3
      const isCavity = new Uint8Array(nv)
      let h = -1
      for (let v = 0; v < nv; v++) { const d = sd.signed(positions[3 * v] as number, positions[3 * v + 1] as number, positions[3 * v + 2] as number, h); h = sd.lastTriangle; isCavity[v] = d < -t / 2 ? 1 : 0 }
      const nt = out.indices.length / 3
      const labels = new Uint16Array(nt)
      const table: SegmentInfo[] = [{ id: 0, name: 'body' }, { id: 1, name: o.cavitySegment }]
      let any = 0
      for (let q = 0; q < nt; q++) { const c = (isCavity[out.indices[3 * q] as number] as number) + (isCavity[out.indices[3 * q + 1] as number] as number) + (isCavity[out.indices[3 * q + 2] as number] as number); if (c >= 2) { labels[q] = 1; any++ } }
      if (any > 0) out.segments = { labels, table }
    }
    return { ...base, mesh: out, hollowed: true, remeshed: true, cavityTriangles: 0, cavityVolume: null, droppedBubbles: 0, wall: wallStats(sd, out.positions, t, true), ms: ms() }
  }

  // ---- A: the cavity is added to the untouched outer surface
  const cav = dropBubbles(raw.positions, raw.indices, vx)
  if (cav.indices.length === 0) return { ...base, mesh, hollowed: false, remeshed: false, cavityTriangles: 0, cavityVolume: null, droppedBubbles: cav.dropped, wall: null, ms: ms() }
  const cavIdx = outward < 0 ? flipped(cav.indices) : cav.indices
  const nvOuter = P.length / 3, ntOuter = mesh.indices.length / 3, nvCav = cav.positions.length / 3, ntCav = cavIdx.length / 3
  const positions = new Float64Array(P.length + cav.positions.length)
  positions.set(P); positions.set(cav.positions, P.length)
  // which body each piece of the cavity belongs to: the body of the outer triangle nearest to it
  const pcs = pieces(cavIdx, nvCav)
  const bodyOfPiece = new Int32Array(pcs.count)
  let groupOfTri: Int32Array | null = null
  if (body) {
    groupOfTri = new Int32Array(ntOuter)
    ;(mesh.groups ?? []).forEach((g, gi) => { for (let q = g.start; q < g.start + g.count; q++) groupOfTri![q] = gi })
    for (let k = 0; k < pcs.count; k++) {
      const v = 3 * (pcs.firstVertex[k] as number)
      sd.signed(cav.positions[v] as number, cav.positions[v + 1] as number, cav.positions[v + 2] as number)
      bodyOfPiece[k] = groupOfTri[sd.lastTriangle] as number
    }
  }
  // the triangle order: the outer triangles as they were; with bodies, each body's cavity right after its own triangles so every body stays one range
  const ntAll = ntOuter + ntCav
  const indices = new Uint32Array(3 * ntAll)
  const src = new Int32Array(ntAll)   // for each new triangle: the outer triangle it is, or -1 for a cavity triangle
  const cavityOf = (q: number): [number, number, number] => [(cavIdx[3 * q] as number) + nvOuter, (cavIdx[3 * q + 1] as number) + nvOuter, (cavIdx[3 * q + 2] as number) + nvOuter]
  let groups: Mesh['groups']
  let at = 0
  const putOuter = (q: number): void => { indices[3 * at] = mesh.indices[3 * q] as number; indices[3 * at + 1] = mesh.indices[3 * q + 1] as number; indices[3 * at + 2] = mesh.indices[3 * q + 2] as number; src[at++] = q }
  const putCavity = (q: number): void => { const c = cavityOf(q); indices[3 * at] = c[0]; indices[3 * at + 1] = c[1]; indices[3 * at + 2] = c[2]; src[at++] = -1 }
  if (body && mesh.groups) {
    const g = mesh.groups
    const next = g.map(x => ({ ...x }))
    for (const gi of body.order) {
      const gg = g[gi] as { start: number; count: number }
      const start = at
      for (let q = gg.start; q < gg.start + gg.count; q++) putOuter(q)
      for (let q = 0; q < ntCav; q++) if (bodyOfPiece[pcs.of[q] as number] === gi) putCavity(q)
      next[gi] = { ...(next[gi] as object), start, count: at - start } as (typeof next)[number]
    }
    groups = next
  } else {
    for (let q = 0; q < ntOuter; q++) putOuter(q)
    for (let q = 0; q < ntCav; q++) putCavity(q)
  }
  const out: Mesh = { positions, indices }
  if (groups) out.groups = groups
  // segments: the outer triangles keep their labels, the cavity gets its own part
  const wantSeg = o.cavitySegment !== ''
  if (mesh.segments || wantSeg) {
    const table: SegmentInfo[] = mesh.segments ? mesh.segments.table.map(s => ({ ...s })) : [{ id: 0, name: 'body' }]
    let cid = -1
    if (wantSeg) {
      const found = table.find(s => s.name === o.cavitySegment)
      if (found) cid = found.id
      else { cid = table.reduce((mx, s) => Math.max(mx, s.id), 0) + 1; if (cid > 65535) throw new MeshError('segment.too_many'); table.push({ id: cid, name: o.cavitySegment }) }
    }
    const labels = new Uint16Array(ntAll)
    for (let q = 0; q < ntAll; q++) { const s = src[q] as number; labels[q] = s >= 0 ? (mesh.segments ? (mesh.segments.labels[s] as number) : 0) : (cid >= 0 ? cid : 0) }
    out.segments = { labels, table }
  }
  // the cavity volume and the wall, measured on what was made
  let vol = 0
  for (let q = 0; q < ntCav; q++) {
    const a = 3 * (cavIdx[3 * q] as number), b = 3 * (cavIdx[3 * q + 1] as number), c = 3 * (cavIdx[3 * q + 2] as number)
    const ax = cav.positions[a] as number, ay = cav.positions[a + 1] as number, az = cav.positions[a + 2] as number
    const bxv = cav.positions[b] as number, byv = cav.positions[b + 1] as number, bzv = cav.positions[b + 2] as number
    const cxv = cav.positions[c] as number, cyv = cav.positions[c + 1] as number, czv = cav.positions[c + 2] as number
    vol += (ax * (byv * czv - bzv * cyv) - ay * (bxv * czv - bzv * cxv) + az * (bxv * cyv - byv * cxv)) / 6
  }
  o.onProgress?.('cavity', 1)
  return { ...base, mesh: out, hollowed: true, remeshed: false, cavityTriangles: ntCav, droppedBubbles: cav.dropped, wall: wallStats(sd, cav.positions, t, false), cavityVolume: Math.abs(vol), ms: ms() }
}

/** The wall as it was made: the distance of up to 1500 evenly chosen cavity points to the outer surface. */
function wallStats(sd: MeshDistance, pos: Float64Array, t: number, onlyCavityVertices: boolean): { min: number; mean: number } | null {
  const nv = pos.length / 3
  if (nv === 0) return null
  const step = Math.max(1, Math.floor(nv / 1500))
  let min = Infinity, sum = 0, n = 0, h = -1
  for (let v = 0; v < nv; v += step) {
    const d = sd.signed(pos[3 * v] as number, pos[3 * v + 1] as number, pos[3 * v + 2] as number, h)
    h = sd.lastTriangle
    const w = -d
    if (onlyCavityVertices && w < t / 2) continue   // a point of the outer surface, not of the cavity
    if (w < min) min = w
    sum += w; n++
  }
  return n === 0 ? null : { min, mean: sum / n }
}

function flipped(idx: Uint32Array): Uint32Array {
  const out = new Uint32Array(idx.length)
  for (let i = 0; i < idx.length; i += 3) { out[i] = idx[i] as number; out[i + 1] = idx[i + 2] as number; out[i + 2] = idx[i + 1] as number }
  return out
}
