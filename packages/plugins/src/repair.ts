// Mesh repair: make a damaged triangle mesh a closed, consistently oriented solid again. Pure functions on a mesh; the plugin (repair-plugin.ts) wraps them.
//
// What it does, in this order (each step can be switched off):
//   1. weld        vertices closer than `weld` mm become one (a spatial hash, the first vertex of a cluster is kept).
//   2. clean       triangles with a repeated corner or no area go; a triangle that appears twice keeps one copy, and a pair that
//                  faces opposite ways (an internal membrane) goes altogether.
//   3. manifold    an edge shared by more than two triangles is resolved: the triangles are paired by how flat they continue
//                  across the edge (angle between their directions away from the edge close to 180 degrees); `split` pulls the
//                  left-over triangle off (the edge and the vertices are duplicated), `remove` deletes it. Vertices that
//                  touch such an edge are split into one copy per fan, so every edge ends up with at most two triangles.
//   4. orient      per shell (triangles joined by shared edges) the winding is made consistent by a walk over the shells,
//                  then the shell is turned outward by the sign of its volume. A shell that lies inside another closed shell
//                  (a cavity) and a body of role `negative` keep the orientation they had (the cheaper of the two).
//   5. islands     shells smaller than `min_island` percent of the largest one go, and so does any other shell with fewer
//                  than four triangles (it cannot enclose anything).
//   6. holes       every boundary loop of at most `max_hole` edges is closed. A hole whose edge lies in one plane gets a
//                  flat cap (an ear clipping of the loop). A hole whose edge is not planar gets that cap refined
//                  (interior edges longer than 1.4 times the average edge of the loop are split, edges are flipped to the
//                  shorter diagonal) and then relaxed with 25 rounds of Laplacian smoothing, so the patch follows the
//                  loop instead of being a flat lid. A loop whose cap would cross itself, or would reuse an edge the mesh
//                  already has, is left open and reported.
//
// Groups (bodies) are repaired one at a time, so a repair never joins two bodies. Triangles keep their segment label; the
// triangles of a cap take the label that most of the triangles around the hole have. Nothing here uses randomness, so the same input
// gives the same output.
import { MeshError, measureMesh } from '@ateliermesh/core'
import type { Mesh, MeshGroup } from '@ateliermesh/core'

export interface RepairOptions {
  /** Millimetres; 0 switches welding off. */
  weld: number
  nonManifold: 'split' | 'remove' | 'off'
  fixNormals: boolean
  /** Percent of the triangles of the largest shell; 0 keeps every shell. */
  minIsland: number
  /** Most boundary edges of a hole that is closed; 0 switches hole filling off. */
  maxHole: number
  signal?: AbortSignal
  onProgress?: (stage: string, fraction: number) => void
}

export interface RepairCounts {
  vertices: number
  triangles: number
  shells: number
  holes: number
  boundaryEdges: number
  nonManifoldEdges: number
  /** Only when the mesh is a closed solid; an open mesh has no volume. */
  volume: number | null
  closed: boolean
}

export interface RepairActions {
  welded: number
  degenerate: number
  duplicates: number
  nonManifoldEdges: number
  flipped: number
  islandsRemoved: number
  islandTriangles: number
  holesFilled: number
  holeTriangles: number
  holesTooBig: number
  holesSkipped: number
  groupsRemoved: number
}

export interface RepairResult {
  mesh: Mesh
  before: RepairCounts
  after: RepairCounts
  did: RepairActions
  /** True when nothing needed repairing and the input mesh is returned as it is. */
  unchanged: boolean
  /** The biggest hole that was too big, in boundary edges (0 when none). */
  largestTooBig: number
}

// ------------------------------------------------------------------------------------------------ the working copy of one body

interface Body {
  P: Float64Array
  T: Uint32Array
  /** Segment label per triangle, or null when the mesh has no segments. */
  L: Uint16Array | null
  /** 1 where the winding was reversed relative to the input. */
  F: Uint8Array
  negative: boolean
}

const cancelled = (o: RepairOptions): void => { if (o.signal?.aborted) throw new MeshError('run.cancelled') }

/** The triangles of `keep` (all when null), with the vertices they use renumbered in order of first use. */
function compact(b: Body, keep: Uint8Array | null): Body {
  const nt = b.T.length / 3
  let nk = 0
  if (keep) for (let t = 0; t < nt; t++) nk += keep[t] ? 1 : 0
  else nk = nt
  const remap = new Int32Array(b.P.length / 3).fill(-1)
  const T = new Uint32Array(3 * nk), F = new Uint8Array(nk)
  const L = b.L ? new Uint16Array(nk) : null
  const pos: number[] = []
  let nv = 0, o = 0
  for (let t = 0; t < nt; t++) {
    if (keep && !keep[t]) continue
    for (let k = 0; k < 3; k++) {
      const v = b.T[3 * t + k] as number
      let r = remap[v] as number
      if (r < 0) { r = nv++; remap[v] = r; pos.push(b.P[3 * v] as number, b.P[3 * v + 1] as number, b.P[3 * v + 2] as number) }
      T[3 * o + k] = r
    }
    F[o] = b.F[t] as number
    if (L && b.L) L[o] = b.L[t] as number
    o++
  }
  return { P: Float64Array.from(pos), T, L, F, negative: b.negative }
}

// ------------------------------------------------------------------------------------------------ edges

interface Edges {
  /** Edge slot of each corner (corner = 3 * triangle + k, the edge from corner k to corner k + 1). */
  slotOf: Int32Array
  /** First corner of each slot, and the next corner on the same edge. */
  head: Int32Array
  next: Int32Array
  count: Int32Array
  nSlots: number
  lo: Uint32Array
  hi: Uint32Array
}

function buildEdges(T: Uint32Array): Edges {
  const nc = T.length
  let size = 4; while (size < nc * 2) size <<= 1
  const mask = size - 1
  const table = new Int32Array(size).fill(-1)
  const lo = new Uint32Array(nc), hi = new Uint32Array(nc), head = new Int32Array(nc).fill(-1), count = new Int32Array(nc)
  const slotOf = new Int32Array(nc), next = new Int32Array(nc).fill(-1)
  let ns = 0
  for (let t = 0; t < nc; t += 3) {
    for (let k = 0; k < 3; k++) {
      const c = t + k
      const a = T[c] as number, b = T[t + (k + 1) % 3] as number
      const l = a < b ? a : b, h = a < b ? b : a
      let s = ((Math.imul(l, 0x9e3779b1) ^ Math.imul(h, 0x85ebca6b)) >>> 0) & mask
      let slot = -1
      for (;;) {
        slot = table[s] as number
        if (slot === -1) { slot = ns++; lo[slot] = l; hi[slot] = h; table[s] = slot; break }
        if (lo[slot] === l && hi[slot] === h) break
        s = (s + 1) & mask
      }
      slotOf[c] = slot; next[c] = head[slot] as number; head[slot] = c; count[slot] = (count[slot] as number) + 1
    }
  }
  return { slotOf, head, next, count, nSlots: ns, lo, hi }
}

/** Union-find over `n` items. */
class Sets {
  private p: Int32Array
  constructor(n: number) { this.p = new Int32Array(n); for (let i = 0; i < n; i++) this.p[i] = i }
  find(a: number): number { const p = this.p; while (p[a] !== a) { p[a] = p[p[a] as number] as number; a = p[a] as number } return a }
  union(a: number, b: number): void { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p[rb] = ra }
}

/** The shell of every triangle: triangles that share an edge (of any count) belong together. Ids follow the first triangle of each shell. */
function shellsOf(T: Uint32Array, E: Edges): { id: Int32Array; n: number; size: number[] } {
  const nt = T.length / 3
  const u = new Sets(nt)
  for (let s = 0; s < E.nSlots; s++) {
    const first = E.head[s] as number
    for (let k = E.next[first] as number; k !== -1; k = E.next[k] as number) u.union((first / 3) | 0, (k / 3) | 0)
  }
  const id = new Int32Array(nt).fill(-1), ofRoot = new Map<number, number>(), size: number[] = []
  for (let t = 0; t < nt; t++) {
    const r = u.find(t)
    let s = ofRoot.get(r)
    if (s === undefined) { s = size.length; ofRoot.set(r, s); size.push(0) }
    id[t] = s; size[s] = (size[s] as number) + 1
  }
  return { id, n: size.length, size }
}

// ------------------------------------------------------------------------------------------------ counts for the report

export function countHoles(T: Uint32Array): number {
  const E = buildEdges(T)
  const verts = new Map<number, number>()
  const edges: Array<[number, number]> = []
  for (let s = 0; s < E.nSlots; s++) if (E.count[s] === 1) {
    const a = E.lo[s] as number, b = E.hi[s] as number
    for (const v of [a, b]) if (!verts.has(v)) verts.set(v, verts.size)
    edges.push([a, b])
  }
  if (edges.length === 0) return 0
  const u = new Sets(verts.size)
  for (const [a, b] of edges) u.union(verts.get(a) as number, verts.get(b) as number)
  const roots = new Set<number>()
  for (const v of verts.values()) roots.add(u.find(v))
  return roots.size
}

function countShells(mesh: Mesh): number {
  const nv = mesh.positions.length / 3
  const u = new Sets(nv), used = new Uint8Array(nv)
  const T = mesh.indices
  for (let t = 0; t < T.length; t += 3) { u.union(T[t] as number, T[t + 1] as number); u.union(T[t] as number, T[t + 2] as number); used[T[t] as number] = 1; used[T[t + 1] as number] = 1; used[T[t + 2] as number] = 1 }
  const roots = new Set<number>()
  for (let v = 0; v < nv; v++) if (used[v]) roots.add(u.find(v))
  return roots.size
}

export function repairCounts(mesh: Mesh): RepairCounts {
  const m = measureMesh(mesh)
  return {
    vertices: m.vertices, triangles: m.triangles, shells: countShells(mesh), holes: countHoles(mesh.indices),
    boundaryEdges: m.boundaryEdges, nonManifoldEdges: m.nonManifoldEdges, volume: m.watertight ? m.volume : null, closed: m.watertight,
  }
}

// ------------------------------------------------------------------------------------------------ 1. weld

function weldVertices(b: Body, tol: number): number {
  const n = b.P.length / 3
  let size = 4; while (size < n * 2) size <<= 1
  const mask = size - 1
  const head = new Int32Array(size).fill(-1), nextV = new Int32Array(n).fill(-1)
  const remap = new Int32Array(n)
  const P = b.P, inv = 1 / tol, t2 = tol * tol
  const hash = (x: number, y: number, z: number): number => ((Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791)) >>> 0) & mask
  let merged = 0
  for (let v = 0; v < n; v++) {
    const x = P[3 * v] as number, y = P[3 * v + 1] as number, z = P[3 * v + 2] as number
    const cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv)
    let found = -1
    search: for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (let r = head[hash(cx + dx, cy + dy, cz + dz)] as number; r !== -1; r = nextV[r] as number) {
        const ex = (P[3 * r] as number) - x, ey = (P[3 * r + 1] as number) - y, ez = (P[3 * r + 2] as number) - z
        if (ex * ex + ey * ey + ez * ez <= t2) { found = r; break search }
      }
    }
    if (found >= 0) { remap[v] = found; merged++ } else {
      remap[v] = v
      const h = hash(cx, cy, cz)
      nextV[v] = head[h] as number; head[h] = v
    }
  }
  if (merged > 0) for (let i = 0; i < b.T.length; i++) b.T[i] = remap[b.T[i] as number] as number
  return merged
}

// ------------------------------------------------------------------------------------------------ 2. degenerate and duplicate triangles

function cleanTriangles(b: Body, diag: number): { degenerate: number; duplicates: number } {
  const nt = b.T.length / 3, P = b.P, T = b.T
  const keep = new Uint8Array(nt).fill(1)
  const eps = 1e-14 * diag * diag
  let degenerate = 0, duplicates = 0
  const ka = new Uint32Array(nt), kb = new Uint32Array(nt), kc = new Uint32Array(nt), sign = new Int8Array(nt)
  for (let t = 0; t < nt; t++) {
    const a = T[3 * t] as number, c1 = T[3 * t + 1] as number, c2 = T[3 * t + 2] as number
    let bad = a === c1 || c1 === c2 || a === c2
    if (!bad) {
      const ux = (P[3 * c1] as number) - (P[3 * a] as number), uy = (P[3 * c1 + 1] as number) - (P[3 * a + 1] as number), uz = (P[3 * c1 + 2] as number) - (P[3 * a + 2] as number)
      const vx = (P[3 * c2] as number) - (P[3 * a] as number), vy = (P[3 * c2 + 1] as number) - (P[3 * a + 1] as number), vz = (P[3 * c2 + 2] as number) - (P[3 * a + 2] as number)
      if (0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) <= eps) bad = true
    }
    if (bad) { keep[t] = 0; degenerate++; continue }
    // sorted corners and the parity of the permutation (a cyclic shift is even)
    let s0 = a, s1 = c1, s2 = c2, odd = 0
    if (s0 > s1) { const x = s0; s0 = s1; s1 = x; odd ^= 1 }
    if (s1 > s2) { const x = s1; s1 = s2; s2 = x; odd ^= 1 }
    if (s0 > s1) { const x = s0; s0 = s1; s1 = x; odd ^= 1 }
    ka[t] = s0; kb[t] = s1; kc[t] = s2; sign[t] = odd ? -1 : 1
  }
  const order = new Uint32Array(nt)
  for (let t = 0; t < nt; t++) order[t] = t
  order.sort((x, y) => (ka[x] as number) - (ka[y] as number) || (kb[x] as number) - (kb[y] as number) || (kc[x] as number) - (kc[y] as number) || x - y)
  for (let i = 0; i < nt;) {
    const t0 = order[i] as number
    if (!keep[t0]) { i++; continue }
    const run: number[] = [t0]
    let j = i + 1
    while (j < nt) {
      const t = order[j] as number
      if (!keep[t]) { j++; continue }
      if (ka[t] === ka[t0] && kb[t] === kb[t0] && kc[t] === kc[t0]) { run.push(t); j++ } else break
    }
    // the live triangles with the same corners: one copy of each facing, and none when both facings occur (an internal membrane)
    if (run.length > 1) {
      const both = run.some(t => sign[t] === 1) && run.some(t => sign[t] === -1)
      for (let q = both ? 0 : 1; q < run.length; q++) { keep[run[q] as number] = 0; duplicates++ }
    }
    i = j
  }
  if (degenerate + duplicates > 0) {
    const c = compact(b, keep)
    b.P = c.P; b.T = c.T; b.L = c.L; b.F = c.F
  }
  return { degenerate, duplicates }
}

// ------------------------------------------------------------------------------------------------ 3. non-manifold edges

function resolveNonManifold(b: Body, mode: 'split' | 'remove'): number {
  const T = b.T, P = b.P, nt = T.length / 3
  const E = buildEdges(T)
  let bad = 0
  for (let s = 0; s < E.nSlots; s++) if ((E.count[s] as number) > 2) bad++
  if (bad === 0) return 0
  // partner[corner] = the corner of the triangle on the other side of that edge (-1: none)
  const partner = new Int32Array(T.length).fill(-1)
  const removed = new Uint8Array(nt)
  const touched = new Set<number>()
  for (let s = 0; s < E.nSlots; s++) {
    const n = E.count[s] as number
    if (n < 2) continue
    const corners: number[] = []
    for (let k = E.head[s] as number; k !== -1; k = E.next[k] as number) corners.push(k)
    corners.sort((x, y) => x - y)
    if (n === 2) { partner[corners[0] as number] = corners[1] as number; partner[corners[1] as number] = corners[0] as number; continue }
    // more than two: pair the triangles that continue each other most flatly
    const u = E.lo[s] as number, v = E.hi[s] as number
    touched.add(u); touched.add(v)
    const ax = (P[3 * v] as number) - (P[3 * u] as number), ay = (P[3 * v + 1] as number) - (P[3 * u + 1] as number), az = (P[3 * v + 2] as number) - (P[3 * u + 2] as number)
    const al = Math.hypot(ax, ay, az) || 1
    const ex = ax / al, ey = ay / al, ez = az / al
    const dirs = corners.map(c => {
      const t = (c / 3) | 0, w = T[3 * t + ((c % 3) + 2) % 3] as number
      let dx = (P[3 * w] as number) - (P[3 * u] as number), dy = (P[3 * w + 1] as number) - (P[3 * u + 1] as number), dz = (P[3 * w + 2] as number) - (P[3 * u + 2] as number)
      const dot = dx * ex + dy * ey + dz * ez
      dx -= dot * ex; dy -= dot * ey; dz -= dot * ez
      const l = Math.hypot(dx, dy, dz) || 1
      return [dx / l, dy / l, dz / l] as const
    })
    const pairs: Array<{ i: number; j: number; cos: number }> = []
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const di = dirs[i] as readonly [number, number, number], dj = dirs[j] as readonly [number, number, number]
      pairs.push({ i, j, cos: di[0] * dj[0] + di[1] * dj[1] + di[2] * dj[2] })
    }
    pairs.sort((p, q) => p.cos - q.cos || p.i - q.i || p.j - q.j)
    const used = new Uint8Array(n)
    for (const p of pairs) {
      if (used[p.i] || used[p.j]) continue
      used[p.i] = used[p.j] = 1
      partner[corners[p.i] as number] = corners[p.j] as number; partner[corners[p.j] as number] = corners[p.i] as number
    }
    for (let i = 0; i < n; i++) if (!used[i] && mode === 'remove') removed[(((corners[i] as number) / 3) | 0)] = 1
  }
  // split every touched vertex into one copy per fan of triangles joined across paired edges
  const cornersAt = new Map<number, number[]>()
  for (let c = 0; c < T.length; c++) { const v = T[c] as number; if (touched.has(v) && !removed[(c / 3) | 0]) { const l = cornersAt.get(v); if (l) l.push(c); else cornersAt.set(v, [c]) } }
  const newV = Uint32Array.from(T)
  const extra: number[] = []
  const nv0 = P.length / 3
  const local = new Int32Array(nt).fill(-1)
  for (const v of [...cornersAt.keys()].sort((x, y) => x - y)) {
    const cs = cornersAt.get(v) as number[]
    const parent = cs.map((_, i) => i)
    const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a] as number] as number; a = parent[a] as number } return a }
    cs.forEach((c, i) => { local[(c / 3) | 0] = i })
    cs.forEach((c, i) => {
      const t = (c / 3) | 0, k = c % 3
      for (const edge of [c, 3 * t + ((k + 2) % 3)]) {
        const p = partner[edge] as number
        if (p < 0) continue
        const s = (p / 3) | 0
        if (removed[s]) continue
        const j = local[s] as number
        if (j >= 0) { const ra = find(i), rb = find(j); if (ra !== rb) parent[rb] = ra }
      }
    })
    const root = new Map<number, number>()
    cs.forEach((c, i) => {
      const r = find(i)
      let id = root.get(r)
      if (id === undefined) { id = root.size === 0 ? v : nv0 + extra.length / 3; if (root.size > 0) extra.push(P[3 * v] as number, P[3 * v + 1] as number, P[3 * v + 2] as number); root.set(r, id) }
      newV[c] = id
    })
    for (const c of cs) local[(c / 3) | 0] = -1
  }
  const P2 = new Float64Array(P.length + extra.length)
  P2.set(P); P2.set(extra, P.length)
  const keep = new Uint8Array(nt)
  for (let t = 0; t < nt; t++) keep[t] = removed[t] ? 0 : 1
  const c = compact({ P: P2, T: newV, L: b.L, F: b.F, negative: b.negative }, keep)
  b.P = c.P; b.T = c.T; b.L = c.L; b.F = c.F
  return bad
}

// ------------------------------------------------------------------------------------------------ 4. winding

/** Does a ray from `p` cross the closed shell `tris` an odd number of times? */
function insideShell(P: Float64Array, T: Uint32Array, tris: number[], p: [number, number, number]): boolean {
  const dx = 0.5773, dy = 0.3141, dz = 0.7591
  const dl = Math.hypot(dx, dy, dz), rx = dx / dl, ry = dy / dl, rz = dz / dl
  let hits = 0
  for (const t of tris) {
    const a = 3 * (T[3 * t] as number), b = 3 * (T[3 * t + 1] as number), c = 3 * (T[3 * t + 2] as number)
    const e1x = (P[b] as number) - (P[a] as number), e1y = (P[b + 1] as number) - (P[a + 1] as number), e1z = (P[b + 2] as number) - (P[a + 2] as number)
    const e2x = (P[c] as number) - (P[a] as number), e2y = (P[c + 1] as number) - (P[a + 1] as number), e2z = (P[c + 2] as number) - (P[a + 2] as number)
    const hx = ry * e2z - rz * e2y, hy = rz * e2x - rx * e2z, hz = rx * e2y - ry * e2x
    const det = e1x * hx + e1y * hy + e1z * hz
    if (Math.abs(det) < 1e-14) continue
    const f = 1 / det
    const sx = p[0] - (P[a] as number), sy = p[1] - (P[a + 1] as number), sz = p[2] - (P[a + 2] as number)
    const u = f * (sx * hx + sy * hy + sz * hz)
    if (u < 0 || u > 1) continue
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x
    const v = f * (rx * qx + ry * qy + rz * qz)
    if (v < 0 || u + v > 1) continue
    if (f * (e2x * qx + e2y * qy + e2z * qz) > 1e-9) hits++
  }
  return (hits & 1) === 1
}

function orientShells(b: Body, diag: number): number {
  const T = b.T, P = b.P, nt = T.length / 3
  if (nt === 0) return 0
  const E = buildEdges(T)
  const sh = shellsOf(T, E)
  // 1. walk each shell and give every triangle a state (0: as is, 1: reversed) that makes the shell consistent
  const o = new Int8Array(nt).fill(-1)
  const queue = new Int32Array(nt)
  for (let seed = 0; seed < nt; seed++) {
    if (o[seed] !== -1) continue
    o[seed] = 0
    let qh = 0, qt = 0
    queue[qt++] = seed
    while (qh < qt) {
      const t = queue[qh++] as number
      for (let k = 0; k < 3; k++) {
        const c = 3 * t + k
        if ((E.count[E.slotOf[c] as number] as number) !== 2) continue
        const first = E.head[E.slotOf[c] as number] as number
        const c2 = first === c ? (E.next[first] as number) : first
        const s = (c2 / 3) | 0
        const same = (T[c2] as number) === (T[c] as number)
        const want = same ? 1 - (o[t] as number) : (o[t] as number)
        if (o[s] === -1) { o[s] = want; queue[qt++] = s }
      }
    }
  }
  // 2. per shell: its triangles, volume, and whether it is closed
  const tris: number[][] = Array.from({ length: sh.n }, () => [])
  for (let t = 0; t < nt; t++) (tris[sh.id[t] as number] as number[]).push(t)
  const open = new Uint8Array(sh.n)
  for (let s = 0; s < E.nSlots; s++) if (E.count[s] !== 2) open[sh.id[((E.head[s] as number) / 3) | 0] as number] = 1
  const bbox = tris.map(list => {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
    for (const t of list) for (let k = 0; k < 3; k++) { const v = T[3 * t + k] as number; for (let a = 0; a < 3; a++) { const x = P[3 * v + a] as number; if (x < (mn[a] as number)) mn[a] = x; if (x > (mx[a] as number)) mx[a] = x } }
    return { mn, mx }
  })
  const bySize = [...tris.keys()].sort((x, y) => (tris[y] as number[]).length - (tris[x] as number[]).length || x - y).slice(0, 8)
  let flipped = 0
  for (let s = 0; s < sh.n; s++) {
    const list = tris[s] as number[], bb = bbox[s] as { mn: number[]; mx: number[] }
    const cx = ((bb.mn[0] as number) + (bb.mx[0] as number)) / 2, cy = ((bb.mn[1] as number) + (bb.mx[1] as number)) / 2, cz = ((bb.mn[2] as number) + (bb.mx[2] as number)) / 2
    let vol = 0, ones = 0
    for (const t of list) {
      const a = 3 * (T[3 * t] as number), c1 = 3 * (T[3 * t + 1] as number), c2 = 3 * (T[3 * t + 2] as number)
      const ax = (P[a] as number) - cx, ay = (P[a + 1] as number) - cy, az = (P[a + 2] as number) - cz
      const bx = (P[c1] as number) - cx, by = (P[c1 + 1] as number) - cy, bz = (P[c1 + 2] as number) - cz
      const qx = (P[c2] as number) - cx, qy = (P[c2 + 1] as number) - cy, qz = (P[c2 + 2] as number) - cz
      const d = (ax * (by * qz - bz * qy) + ay * (bz * qx - bx * qz) + az * (bx * qy - by * qx)) / 6
      if (o[t] === 1) { vol -= d; ones++ } else vol += d
    }
    const cheaper = ones * 2 > list.length // true: reversing the whole shell changes fewer triangles
    let flipShell = cheaper
    if (!b.negative && Math.abs(vol) > 1e-12 * diag * diag * diag) {
      if (vol > 0) flipShell = false
      else {
        // pointing inward: right for a cavity (a closed shell inside another), wrong for anything else
        const t0 = list[0] as number
        const p: [number, number, number] = [0, 0, 0]
        for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) p[a] = (p[a] as number) + (P[3 * (T[3 * t0 + k] as number) + a] as number) / 3
        const nested = bySize.some(r => r !== s && !open[r] && (() => {
          const rb = bbox[r] as { mn: number[]; mx: number[] }
          for (let a = 0; a < 3; a++) if ((bb.mn[a] as number) < (rb.mn[a] as number) || (bb.mx[a] as number) > (rb.mx[a] as number)) return false
          return insideShell(P, T, tris[r] as number[], p)
        })())
        flipShell = nested ? cheaper : true
      }
    }
    for (const t of list) {
      if (((o[t] as number) ^ (flipShell ? 1 : 0)) === 1) {
        const x = T[3 * t + 1] as number; T[3 * t + 1] = T[3 * t + 2] as number; T[3 * t + 2] = x
        b.F[t] = (b.F[t] as number) ^ 1
        flipped++
      }
    }
  }
  return flipped
}

// ------------------------------------------------------------------------------------------------ 5. floating islands

function removeIslands(b: Body, minPercent: number): { shells: number; triangles: number } {
  const nt = b.T.length / 3
  if (nt === 0 || minPercent <= 0) return { shells: 0, triangles: 0 }
  const E = buildEdges(b.T)
  const sh = shellsOf(b.T, E)
  if (sh.n < 2) return { shells: 0, triangles: 0 }
  const largest = Math.max(...sh.size)
  const drop = sh.size.map(n => n < (minPercent / 100) * largest || (n < 4 && n < largest))
  if (!drop.some(Boolean)) return { shells: 0, triangles: 0 }
  const keep = new Uint8Array(nt)
  let triangles = 0
  for (let t = 0; t < nt; t++) { const d = drop[sh.id[t] as number]; keep[t] = d ? 0 : 1; if (d) triangles++ }
  const c = compact(b, keep)
  b.P = c.P; b.T = c.T; b.L = c.L; b.F = c.F
  return { shells: drop.filter(Boolean).length, triangles }
}

// ------------------------------------------------------------------------------------------------ 6. holes

type V3 = [number, number, number]
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2])

/** Smallest angle (radians) of the triangle abc. */
function minAngle(a: V3, b: V3, c: V3): number {
  const f = (p: V3, q: V3, r: V3): number => { const u = sub(q, p), v = sub(r, p); const l = len(u) * len(v); return l === 0 ? 0 : Math.acos(Math.max(-1, Math.min(1, dot(u, v) / l))) }
  return Math.min(f(a, b, c), f(b, c, a), f(c, a, b))
}

type Hole = { ok: true; tris: Array<[number, number, number]>; extra: number[] } | { ok: false; reason: 'self_intersects' | 'degenerate' }

/**
 * Close one loop. `poly` lists the loop's vertices in the order a cap must run (the reverse of how the surrounding triangles traverse the
 * boundary). `forbidden` holds the edges the mesh already has between loop vertices: a cap may not use them a second time.
 */
function fillHole(P: Float64Array, poly: number[], forbidden: Set<number>, nv: number, firstNew: number): Hole {
  const m = poly.length
  const at = (i: number): V3 => [P[3 * (poly[i] as number)] as number, P[3 * (poly[i] as number) + 1] as number, P[3 * (poly[i] as number) + 2] as number]
  const pts = poly.map((_, i) => at(i))
  // the Newell normal and a basis of the plane
  const n: V3 = [0, 0, 0]
  for (let i = 0; i < m; i++) {
    const a = pts[i] as V3, c = pts[(i + 1) % m] as V3
    n[0] += (a[1] - c[1]) * (a[2] + c[2]); n[1] += (a[2] - c[2]) * (a[0] + c[0]); n[2] += (a[0] - c[0]) * (a[1] + c[1])
  }
  const nl = len(n)
  if (nl === 0 || !Number.isFinite(nl)) return { ok: false, reason: 'degenerate' }
  const nn: V3 = [n[0] / nl, n[1] / nl, n[2] / nl]
  const ref: V3 = Math.abs(nn[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const ux = cross(nn, ref), ul = len(ux)
  const U: V3 = [ux[0] / ul, ux[1] / ul, ux[2] / ul]
  const Vv = cross(nn, U)
  const q = pts.map(p => [dot(p, U), dot(p, Vv)] as const)
  let diam = 0
  for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) diam = Math.max(diam, len(sub(pts[i] as V3, pts[j] as V3)))
  if (diam === 0) return { ok: false, reason: 'degenerate' }
  const eps = 1e-12 * diam * diam
  // the loop must not cross itself when seen along the normal
  const segX = (a: number, b: number, c: number, d: number): boolean => {
    const o = (p: readonly [number, number], r: readonly [number, number], s: readonly [number, number]): number => (r[0] - p[0]) * (s[1] - p[1]) - (r[1] - p[1]) * (s[0] - p[0])
    const A = q[a] as readonly [number, number], B = q[b] as readonly [number, number], C = q[c] as readonly [number, number], D = q[d] as readonly [number, number]
    const d1 = o(A, B, C), d2 = o(A, B, D), d3 = o(C, D, A), d4 = o(C, D, B)
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  }
  for (let i = 0; i < m; i++) for (let j = i + 2; j < m; j++) { if (i === 0 && j === m - 1) continue; if (segX(i, (i + 1) % m, j, (j + 1) % m)) return { ok: false, reason: 'self_intersects' } }
  // ear clipping, always taking the ear with the best smallest angle
  const prev = poly.map((_, i) => (i + m - 1) % m), next = poly.map((_, i) => (i + 1) % m)
  const alive = new Uint8Array(m).fill(1)
  const cr = (a: number, b: number, c: number): number => ((q[b] as readonly [number, number])[0] - (q[a] as readonly [number, number])[0]) * ((q[c] as readonly [number, number])[1] - (q[a] as readonly [number, number])[1]) - ((q[b] as readonly [number, number])[1] - (q[a] as readonly [number, number])[1]) * ((q[c] as readonly [number, number])[0] - (q[a] as readonly [number, number])[0])
  const key = (a: number, b: number): number => { const x = poly[a] as number, y = poly[b] as number; return (x < y ? x : y) * nv + (x < y ? y : x) }
  let remaining = m
  const quality = new Float64Array(m).fill(-1)
  const evaluate = (i: number): void => {
    quality[i] = -1
    if (!alive[i]) return
    const a = prev[i] as number, c = next[i] as number
    if (cr(a, i, c) <= eps) return
    if (remaining > 3 && forbidden.has(key(a, c))) return
    // no other live vertex inside the triangle
    for (let j = next[c] as number; j !== a; j = next[j] as number) {
      const d1 = cr(a, i, j), d2 = cr(i, c, j), d3 = cr(c, a, j)
      if (d1 >= -eps && d2 >= -eps && d3 >= -eps) return
    }
    quality[i] = minAngle(pts[a] as V3, pts[i] as V3, pts[c] as V3)
  }
  for (let i = 0; i < m; i++) evaluate(i)
  const tris: Array<[number, number, number]> = []
  while (remaining > 3) {
    let best = -1
    for (let i = 0; i < m; i++) if ((quality[i] as number) >= 0 && (best < 0 || (quality[i] as number) > (quality[best] as number))) best = i
    if (best < 0) return { ok: false, reason: 'degenerate' }
    const a = prev[best] as number, c = next[best] as number
    tris.push([poly[a] as number, poly[best] as number, poly[c] as number])
    alive[best] = 0; remaining--
    next[a] = c; prev[c] = a
    quality[best] = -1
    evaluate(a); evaluate(c)
  }
  const last = alive.indexOf(1)
  const a = prev[last] as number, c = next[last] as number
  if (cr(a, last, c) <= eps) return { ok: false, reason: 'degenerate' }
  tris.push([poly[a] as number, poly[last] as number, poly[c] as number])
  // a hole whose edge lies in one plane gets the flat cap
  const centre: V3 = [0, 0, 0]
  for (const p of pts) { centre[0] += p[0] / m; centre[1] += p[1] / m; centre[2] += p[2] / m }
  let dev = 0
  for (const p of pts) dev = Math.max(dev, Math.abs(dot(sub(p, centre), nn)))
  if (dev <= 0.02 * diam || m < 4) return { ok: true, tris, extra: [] }
  return smoothPatch(P, poly, tris, nn, firstNew)
}

/** Refine the cap of a hole with a bent edge and relax it, so it follows the loop. New vertices are numbered from `firstNew`. */
function smoothPatch(P: Float64Array, poly: number[], flat: Array<[number, number, number]>, n: V3, firstNew: number): Hole {
  const loopLen = poly.reduce((s, v, i) => { const w = poly[(i + 1) % poly.length] as number; return s + Math.hypot((P[3 * v] as number) - (P[3 * w] as number), (P[3 * v + 1] as number) - (P[3 * w + 1] as number), (P[3 * v + 2] as number) - (P[3 * w + 2] as number)) }, 0)
  const h = loopLen / poly.length
  // local numbering: the global vertices first (as they are), the new ones after
  const extra: number[] = []
  const posOf = (v: number): V3 => (v < firstNew ? [P[3 * v] as number, P[3 * v + 1] as number, P[3 * v + 2] as number] : [extra[3 * (v - firstNew)] as number, extra[3 * (v - firstNew) + 1] as number, extra[3 * (v - firstNew) + 2] as number])
  const tris: Array<[number, number, number]> = flat.map(t => [t[0], t[1], t[2]])
  const K = 1 << 26
  const ekey = (a: number, b: number): number => (a < b ? a : b) * K + (a < b ? b : a)
  const maxTris = Math.min(20000, 40 * poly.length)
  const edgeMap = (): Map<number, number[]> => {
    const mp = new Map<number, number[]>()
    tris.forEach((t, i) => { for (let k = 0; k < 3; k++) { const kk = ekey(t[k] as number, t[(k + 1) % 3] as number); const l = mp.get(kk); if (l) l.push(i); else mp.set(kk, [i]) } })
    return mp
  }
  const third = (t: [number, number, number], a: number, b: number): number => { for (let k = 0; k < 3; k++) if (t[k] === a && t[(k + 1) % 3] === b) return t[(k + 2) % 3] as number; return -1 }
  for (let pass = 0; pass < 8; pass++) {
    const mp = edgeMap()
    const cand: Array<{ lo: number; hi: number; l: number }> = []
    for (const [kk, ts] of mp) {
      if (ts.length !== 2) continue
      const lo = Math.floor(kk / K), hi = kk - lo * K
      const l = len(sub(posOf(lo), posOf(hi)))
      if (l > 1.4 * h) cand.push({ lo, hi, l })
    }
    if (cand.length === 0 || tris.length >= maxTris) break
    cand.sort((x, y) => y.l - x.l || x.lo - y.lo || x.hi - y.hi)
    const used = new Set<number>()
    for (const e of cand) {
      if (tris.length >= maxTris) break
      const ts = mp.get(ekey(e.lo, e.hi)) as number[]
      if (used.has(ts[0] as number) || used.has(ts[1] as number)) continue
      let tA = ts[0] as number, tB = ts[1] as number
      let c = third(tris[tA] as [number, number, number], e.lo, e.hi)
      if (c < 0) { [tA, tB] = [tB, tA]; c = third(tris[tA] as [number, number, number], e.lo, e.hi) }
      const d = third(tris[tB] as [number, number, number], e.hi, e.lo)
      if (c < 0 || d < 0) continue
      const p = posOf(e.lo), r = posOf(e.hi)
      const mid = firstNew + extra.length / 3
      extra.push((p[0] + r[0]) / 2, (p[1] + r[1]) / 2, (p[2] + r[2]) / 2)
      tris[tA] = [e.lo, mid, c]; tris[tB] = [e.hi, mid, d]
      tris.push([mid, e.hi, c], [mid, e.lo, d])
      used.add(tA); used.add(tB)
    }
    // flip long diagonals to the shorter one when the quad is convex
    for (let sweep = 0; sweep < 3; sweep++) {
      const m2 = edgeMap()
      let flips = 0
      for (const [kk, ts] of [...m2].sort((x, y) => x[0] - y[0])) {
        if (ts.length !== 2) continue
        const lo = Math.floor(kk / K), hi = kk - lo * K
        const tA = ts[0] as number, tB = ts[1] as number
        let c = third(tris[tA] as [number, number, number], lo, hi)
        let a = lo, b = hi
        if (c < 0) { a = hi; b = lo; c = third(tris[tA] as [number, number, number], a, b) }
        const d = third(tris[tB] as [number, number, number], b, a)
        if (c < 0 || d < 0) continue
        if (m2.has(ekey(c, d))) continue
        const pa = posOf(a), pb = posOf(b), pc = posOf(c), pd = posOf(d)
        if (len(sub(pc, pd)) >= 0.9 * len(sub(pa, pb))) continue
        const n1 = cross(sub(pa, pc), sub(pd, pc)), n2 = cross(sub(pd, pc), sub(pb, pc))
        if (dot(n1, n) <= 0 || dot(n2, n) <= 0) continue
        tris[tA] = [c, a, d]; tris[tB] = [d, b, c]
        flips++
      }
      if (flips === 0) break
    }
  }
  // relax the new vertices: they move halfway to the average of their neighbours, 25 times
  const nb = new Map<number, Set<number>>()
  for (const t of tris) { for (let k = 0; k < 3; k++) { const a = t[k] as number; if (a < firstNew) continue; let s = nb.get(a); if (!s) { s = new Set(); nb.set(a, s) } s.add(t[(k + 1) % 3] as number); s.add(t[(k + 2) % 3] as number) } }
  const ids = [...nb.keys()].sort((x, y) => x - y)
  for (let it = 0; it < 25; it++) {
    for (const v of ids) {
      const set = nb.get(v) as Set<number>
      let x = 0, y = 0, z = 0
      for (const w of set) { const p = posOf(w); x += p[0]; y += p[1]; z += p[2] }
      const k = set.size, i = v - firstNew
      extra[3 * i] = (extra[3 * i] as number) * 0.5 + 0.5 * (x / k)
      extra[3 * i + 1] = (extra[3 * i + 1] as number) * 0.5 + 0.5 * (y / k)
      extra[3 * i + 2] = (extra[3 * i + 2] as number) * 0.5 + 0.5 * (z / k)
    }
  }
  return { ok: true, tris, extra }
}

/** A closed walk that visits some vertex twice, as separate simple loops (each at least three vertices; two-vertex loops are dropped). */
function simpleCycles(walk: number[]): number[][] {
  const out: number[][] = []
  const stack: number[] = []
  const at = new Map<number, number>()
  for (const v of walk) {
    const i = at.get(v)
    if (i !== undefined) {
      const cycle = stack.splice(i)
      for (const x of cycle) at.delete(x)
      if (cycle.length >= 3) out.push(cycle)
      at.set(v, stack.length); stack.push(v)
    } else { at.set(v, stack.length); stack.push(v) }
  }
  if (stack.length >= 3) out.push(stack)
  return out
}

function fillHoles(b: Body, maxHole: number, did: RepairActions, o: RepairOptions): { largestTooBig: number } {
  const T = b.T, nt = T.length / 3
  const E = buildEdges(T)
  // directed boundary edges: the triangle's own direction a -> b
  const outs = new Map<number, number[]>()
  const boundary: number[] = []
  for (let s = 0; s < E.nSlots; s++) if (E.count[s] === 1) {
    const c = E.head[s] as number
    const a = T[c] as number
    boundary.push(c)
    const l = outs.get(a)
    if (l) l.push(c); else outs.set(a, [c])
  }
  if (boundary.length === 0) return { largestTooBig: 0 }
  boundary.sort((x, y) => x - y)
  for (const l of outs.values()) l.sort((x, y) => x - y)
  // the edges the mesh already has, to keep a cap from using one twice
  const nv = b.P.length / 3
  const edgeSet = new Set<number>()
  for (let s = 0; s < E.nSlots; s++) edgeSet.add((E.lo[s] as number) * nv + (E.hi[s] as number))
  // where two holes touch at a vertex, several boundary edges leave it: the loop leaves along the edge of the next fan of triangles
  // around the vertex (counter-clockwise), because the hole lies in the gap between the two fans
  let cornersAt: Map<number, number[]> | null = null
  const pinched = new Set<number>()
  for (const [v, l] of outs) if (l.length > 1) pinched.add(v)
  const nextBoundary = (inCorner: number, v: number): number => {
    const cand = outs.get(v)
    if (!cand) return -1
    if (cand.length === 1) return cand[0] as number
    if (!cornersAt) {
      cornersAt = new Map()
      for (let c = 0; c < T.length; c++) { const x = T[c] as number; if (pinched.has(x)) { const l = cornersAt.get(x); if (l) l.push(c); else cornersAt.set(x, [c]) } }
    }
    const cs = cornersAt.get(v) as number[]
    const tri = new Map<number, number>()
    cs.forEach((c, i) => tri.set((c / 3) | 0, i))
    const parent = cs.map((_, i) => i)
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x] as number] as number; x = parent[x] as number } return x }
    const nrm: V3 = [0, 0, 0]
    cs.forEach((c, i) => {
      const t = (c / 3) | 0, k = c % 3
      for (const edge of [c, 3 * t + ((k + 2) % 3)]) {
        if ((E.count[E.slotOf[edge] as number] as number) !== 2) continue
        const first = E.head[E.slotOf[edge] as number] as number
        const other = first === edge ? (E.next[first] as number) : first
        const j = tri.get((other / 3) | 0)
        if (j !== undefined) { const ra = find(i), rb = find(j); if (ra !== rb) parent[rb] = ra }
      }
      const pa = [0, 1, 2].map(q => { const w = T[3 * t + q] as number; return [b.P[3 * w], b.P[3 * w + 1], b.P[3 * w + 2]] as V3 })
      const cr = cross(sub(pa[1] as V3, pa[0] as V3), sub(pa[2] as V3, pa[0] as V3))
      nrm[0] += cr[0]; nrm[1] += cr[1]; nrm[2] += cr[2]
    })
    const fanOfIn = find(tri.get((inCorner / 3) | 0) as number)
    // one outgoing boundary edge per fan, with its direction away from the vertex
    const outOf = new Map<number, number>()
    for (const c of cand) {
      const f = find(tri.get((c / 3) | 0) as number)
      if (outOf.has(f)) return -1
      outOf.set(f, c)
    }
    if (outOf.size < 2) return -1
    const nl = len(nrm)
    if (nl === 0) return -1
    const nn: V3 = [nrm[0] / nl, nrm[1] / nl, nrm[2] / nl]
    const ref: V3 = Math.abs(nn[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
    const e1 = cross(nn, ref), e1l = len(e1)
    const E1: V3 = [e1[0] / e1l, e1[1] / e1l, e1[2] / e1l]
    const E2 = cross(nn, E1)
    const pv: V3 = [b.P[3 * v] as number, b.P[3 * v + 1] as number, b.P[3 * v + 2] as number]
    const angle = (c: number): number => {
      const x = T[3 * ((c / 3) | 0) + ((c % 3) + 1) % 3] as number
      const d = sub([b.P[3 * x] as number, b.P[3 * x + 1] as number, b.P[3 * x + 2] as number], pv)
      return Math.atan2(dot(d, E2), dot(d, E1))
    }
    const fans = [...outOf.entries()].map(([f, c]) => ({ f, c, a: angle(c) })).sort((x, y) => x.a - y.a || x.c - y.c)
    const at = fans.findIndex(x => x.f === fanOfIn)
    if (at < 0) return -1
    return (fans[(at + 1) % fans.length] as { c: number }).c
  }
  const seen = new Set<number>()
  const loops: number[][] = []
  for (const start of boundary) {
    if (seen.has(start)) continue
    const corners: number[] = []
    let c = start, ok = true
    for (;;) {
      if (seen.has(c) && c !== start) { ok = false; break }
      seen.add(c); corners.push(c)
      const v = T[3 * ((c / 3) | 0) + ((c % 3) + 1) % 3] as number
      const n = nextBoundary(c, v)
      if (n < 0) { ok = false; break }
      if (n === start) break
      c = n
    }
    if (ok) loops.push(corners)
    else did.holesSkipped++
  }
  let largestTooBig = 0
  const extraPos: number[] = []
  const newTris: number[] = []
  const newLabels: number[] = []
  let n0 = nv
  for (const [li, corners] of loops.entries()) {
    cancelled(o)
    o.onProgress?.('holes', li / loops.length)
    const m = corners.length
    if (maxHole <= 0) break
    if (m > maxHole) { largestTooBig = Math.max(largestTooBig, m); did.holesTooBig++; continue }
    // the label that most triangles around the hole have
    let label = 0
    if (b.L) {
      const votes = new Map<number, number>()
      for (const c of corners) { const l = b.L[(c / 3) | 0] as number; votes.set(l, (votes.get(l) ?? 0) + 1) }
      let best = -1
      for (const [l, v] of [...votes].sort((x, y) => x[0] - y[0])) if (v > best) { best = v; label = l }
    }
    // a loop that touches itself at a vertex is several simple loops
    for (const poly of simpleCycles(corners.map(c => T[c] as number).reverse())) {
      const mm = poly.length
      const set = new Set(poly)
      // existing edges between loop vertices that are not loop edges
      const forbidden = new Set<number>()
      const loopEdges = new Set<number>()
      for (let i = 0; i < mm; i++) { const a = poly[i] as number, c2 = poly[(i + 1) % mm] as number; loopEdges.add((a < c2 ? a : c2) * nv + (a < c2 ? c2 : a)) }
      for (const key of edgeSet) { const lo = Math.floor(key / nv), hi = key - lo * nv; if (set.has(lo) && set.has(hi) && !loopEdges.has(key)) forbidden.add(key) }
      const hole = fillHole(b.P, poly, forbidden, nv, n0)
      if (!hole.ok) { did.holesSkipped++; continue }
      for (const x of hole.extra) extraPos.push(x)
      n0 += hole.extra.length / 3
      for (const t of hole.tris) { newTris.push(t[0], t[1], t[2]); newLabels.push(label) }
      did.holesFilled++; did.holeTriangles += hole.tris.length
    }
  }
  if (newTris.length > 0) {
    const P2 = new Float64Array(b.P.length + extraPos.length)
    P2.set(b.P); P2.set(extraPos, b.P.length)
    const T2 = new Uint32Array(T.length + newTris.length)
    T2.set(T); T2.set(newTris, T.length)
    b.P = P2; b.T = T2
    const nn = newTris.length / 3
    if (b.L) { const L2 = new Uint16Array(nt + nn); L2.set(b.L); L2.set(newLabels, nt); b.L = L2 }
    const F2 = new Uint8Array(nt + nn); F2.set(b.F); b.F = F2
  }
  return { largestTooBig }
}

// ------------------------------------------------------------------------------------------------ the whole repair

const emptyActions = (): RepairActions => ({ welded: 0, degenerate: 0, duplicates: 0, nonManifoldEdges: 0, flipped: 0, islandsRemoved: 0, islandTriangles: 0, holesFilled: 0, holeTriangles: 0, holesTooBig: 0, holesSkipped: 0, groupsRemoved: 0 })

function validate(mesh: Mesh): void {
  const P = mesh.positions, T = mesh.indices
  if (P.length % 3 !== 0 || T.length % 3 !== 0) throw new MeshError('repair.bad_input', { reason: 'not_triples' })
  if (T.length === 0) throw new MeshError('repair.bad_input', { reason: 'no_triangles' })
  for (let i = 0; i < P.length; i++) if (!Number.isFinite(P[i] as number)) throw new MeshError('repair.bad_input', { reason: 'not_finite' })
  const nv = P.length / 3
  for (let i = 0; i < T.length; i++) if ((T[i] as number) >= nv) throw new MeshError('repair.bad_input', { reason: 'index_out_of_range' })
}

export function repairMesh(mesh: Mesh, opts: RepairOptions): RepairResult {
  validate(mesh)
  const nt = mesh.indices.length / 3
  const before = repairCounts(mesh)
  const did = emptyActions()
  // bodies: one per group, then whatever no group names
  const groups: MeshGroup[] = mesh.groups ?? []
  const ranges = groups.map((g, i) => ({ g, i })).sort((x, y) => x.g.start - y.g.start)
  let end = 0
  for (const { g } of ranges) {
    if (!Number.isInteger(g.start) || !Number.isInteger(g.count) || g.start < 0 || g.count < 0 || g.start + g.count > nt) throw new MeshError('repair.groups_unsupported', { reason: 'group_out_of_range' })
    if (g.start < end) throw new MeshError('repair.groups_unsupported', { reason: 'groups_overlap' })
    end = g.start + g.count
  }
  const inGroup = new Int32Array(nt).fill(-1)
  groups.forEach((g, i) => { inGroup.fill(i, g.start, g.start + g.count) })
  const lists: number[][] = groups.map(() => [])
  const rest: number[] = []
  for (let t = 0; t < nt; t++) { const gi = inGroup[t] as number; if (gi >= 0) (lists[gi] as number[]).push(t); else rest.push(t) }
  const allLists = [...lists, ...(rest.length > 0 || groups.length === 0 ? [rest] : [])]
  const diag = Math.max(measureMesh(mesh).size.reduce((s, x) => s + x * x, 0) ** 0.5, 1e-9)

  const bodies: Body[] = allLists.map((list, bi) => {
    const remap = new Map<number, number>()
    const pos: number[] = []
    const T = new Uint32Array(3 * list.length), F = new Uint8Array(list.length)
    const L = mesh.segments ? new Uint16Array(list.length) : null
    list.forEach((t, o) => {
      for (let k = 0; k < 3; k++) {
        const v = mesh.indices[3 * t + k] as number
        let r = remap.get(v)
        if (r === undefined) { r = remap.size; remap.set(v, r); pos.push(mesh.positions[3 * v] as number, mesh.positions[3 * v + 1] as number, mesh.positions[3 * v + 2] as number) }
        T[3 * o + k] = r
      }
      if (L && mesh.segments) L[o] = mesh.segments.labels[t] as number
    })
    return { P: Float64Array.from(pos), T, L, F, negative: bi < groups.length && (groups[bi] as MeshGroup).role === 'negative' }
  })

  let largestTooBig = 0
  const steps = 6
  bodies.forEach((b, bi) => {
    const stage = (name: string, i: number): void => { cancelled(opts); opts.onProgress?.(name, (bi + i / steps) / bodies.length) }
    stage('weld', 0)
    if (opts.weld > 0 && b.T.length > 0) did.welded += weldVertices(b, opts.weld)
    stage('weld', 1)
    const c = cleanTriangles(b, diag)
    did.degenerate += c.degenerate; did.duplicates += c.duplicates
    stage('manifold', 2)
    if (opts.nonManifold !== 'off' && b.T.length > 0) did.nonManifoldEdges += resolveNonManifold(b, opts.nonManifold)
    stage('manifold', 3)
    if (opts.fixNormals && b.T.length > 0) did.flipped += orientShells(b, diag)
    stage('islands', 4)
    const isl = removeIslands(b, opts.minIsland)
    did.islandsRemoved += isl.shells; did.islandTriangles += isl.triangles
    stage('holes', 5)
    if (opts.maxHole > 0 && b.T.length > 0) largestTooBig = Math.max(largestTooBig, fillHoles(b, opts.maxHole, did, opts).largestTooBig)
  })
  cancelled(opts)

  // put the bodies back together
  const pos: number[] = [], idx: number[] = [], labels: number[] = []
  const outGroups: MeshGroup[] = []
  let vOff = 0, tOff = 0
  bodies.forEach((raw, bi) => {
    const b = compact(raw, null)
    const n = b.T.length / 3
    for (let i = 0; i < b.P.length; i++) pos.push(b.P[i] as number)
    for (let i = 0; i < b.T.length; i++) idx.push((b.T[i] as number) + vOff)
    if (b.L) for (let i = 0; i < n; i++) labels.push(b.L[i] as number)
    if (bi < groups.length) {
      const g = groups[bi] as MeshGroup
      if (n > 0) outGroups.push({ ...g, start: tOff, count: n }); else did.groupsRemoved++
    }
    vOff += b.P.length / 3; tOff += n
  })
  const result: Mesh = { positions: Float64Array.from(pos), indices: Uint32Array.from(idx) }
  if (mesh.segments) result.segments = { labels: Uint16Array.from(labels), table: mesh.segments.table.map(s => ({ ...s })) }
  if (groups.length > 0) result.groups = outGroups

  const changed = did.welded + did.degenerate + did.duplicates + did.nonManifoldEdges + did.flipped + did.islandTriangles + did.holeTriangles + did.groupsRemoved > 0
  if (!changed) return { mesh, before, after: before, did, unchanged: true, largestTooBig }
  return { mesh: result, before, after: repairCounts(result), did, unchanged: false, largestTooBig }
}
