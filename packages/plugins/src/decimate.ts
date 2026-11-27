// Mesh decimation by edge collapse with quadric error metrics (Garland and Heckbert, SIGGRAPH 1997), written from the published method.
// Open boundaries, sharp creases and segment borders are held by extra quadrics and by refusing to move their vertices off them.
// The topology is kept: the link condition is checked before every collapse, so a closed manifold stays a closed manifold.
import { MeshError } from '@ateliermesh/core'
import type { Mesh, SegmentInfo } from '@ateliermesh/core'

export interface DecimateOptions {
  /** Stop when the mesh has at most this many triangles. */
  targetTriangles: number
  /** Also stop when the next collapse would exceed this error (mm, from the quadric); 0 for no limit. */
  maxError?: number
  preserveBoundary?: boolean
  preserveCreases?: boolean
  /** Edges whose faces meet at more than this angle (degrees) count as creases. */
  creaseAngle?: number
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
}

export interface DecimateResult {
  mesh: Mesh
  before: number
  after: number
  /** Largest quadric error of any collapse made (mm). It estimates the distance from the surface; tests measure the real one. */
  maxError: number
  collapses: number
}

// quadric as 10 numbers: a2 ab ac ad b2 bc bd c2 cd d2 (symmetric 4x4 of the plane (a,b,c,d))
const addPlane = (q: Float64Array, o: number, a: number, b: number, c: number, d: number, w: number): void => {
  q[o] += w * a * a; q[o + 1] += w * a * b; q[o + 2] += w * a * c; q[o + 3] += w * a * d
  q[o + 4] += w * b * b; q[o + 5] += w * b * c; q[o + 6] += w * b * d
  q[o + 7] += w * c * c; q[o + 8] += w * c * d; q[o + 9] += w * d * d
}
const evalQ = (q: Float64Array, o: number, x: number, y: number, z: number): number =>
  (q[o] as number) * x * x + 2 * (q[o + 1] as number) * x * y + 2 * (q[o + 2] as number) * x * z + 2 * (q[o + 3] as number) * x
  + (q[o + 4] as number) * y * y + 2 * (q[o + 5] as number) * y * z + 2 * (q[o + 6] as number) * y
  + (q[o + 7] as number) * z * z + 2 * (q[o + 8] as number) * z + (q[o + 9] as number)

class Heap {
  cost: number[] = []
  a: number[] = []
  b: number[] = []
  va: number[] = []
  vb: number[] = []
  get size(): number { return this.cost.length }
  push(c: number, a: number, b: number, va: number, vb: number): void {
    let i = this.cost.length
    this.cost.push(c); this.a.push(a); this.b.push(b); this.va.push(va); this.vb.push(vb)
    while (i > 0) {
      const p = (i - 1) >> 1
      if ((this.cost[p] as number) <= c) break
      this.move(i, p); i = p
    }
    this.set(i, c, a, b, va, vb)
  }
  private move(to: number, from: number): void { this.cost[to] = this.cost[from] as number; this.a[to] = this.a[from] as number; this.b[to] = this.b[from] as number; this.va[to] = this.va[from] as number; this.vb[to] = this.vb[from] as number }
  private set(i: number, c: number, a: number, b: number, va: number, vb: number): void { this.cost[i] = c; this.a[i] = a; this.b[i] = b; this.va[i] = va; this.vb[i] = vb }
  pop(): { cost: number; a: number; b: number; va: number; vb: number } {
    const top = { cost: this.cost[0] as number, a: this.a[0] as number, b: this.b[0] as number, va: this.va[0] as number, vb: this.vb[0] as number }
    const lc = this.cost.pop() as number, la = this.a.pop() as number, lb = this.b.pop() as number, lva = this.va.pop() as number, lvb = this.vb.pop() as number
    const n = this.cost.length
    if (n > 0) {
      let i = 0
      for (;;) {
        let c = 2 * i + 1
        if (c >= n) break
        if (c + 1 < n && (this.cost[c + 1] as number) < (this.cost[c] as number)) c++
        if ((this.cost[c] as number) >= lc) break
        this.move(i, c); i = c
      }
      this.set(i, lc, la, lb, lva, lvb)
    }
    return top
  }
}

/** The triangles `start` to `start + count` of a mesh as a mesh of its own (vertices renumbered, labels kept). */
function slice(mesh: Mesh, start: number, count: number): Mesh {
  const map = new Map<number, number>()
  const pos: number[] = []
  const idx = new Uint32Array(count * 3)
  for (let i = 0; i < count * 3; i++) {
    const v = mesh.indices[3 * start + i] as number
    let m = map.get(v)
    if (m === undefined) { m = map.size; map.set(v, m); pos.push(mesh.positions[3 * v] as number, mesh.positions[3 * v + 1] as number, mesh.positions[3 * v + 2] as number) }
    idx[i] = m
  }
  const out: Mesh = { positions: Float64Array.from(pos), indices: idx }
  if (mesh.segments) out.segments = { labels: mesh.segments.labels.slice(start, start + count), table: mesh.segments.table }
  return out
}

/**
 * Decimate a mesh made of bodies: each body on its own (collapses never cross from one body to another), with the target split in
 * proportion to the bodies' sizes. `run` is the decimator for one mesh, so the JavaScript and the WebAssembly versions share this.
 */
export async function decimateBodies(mesh: Mesh, opts: DecimateOptions, run: (m: Mesh, o: DecimateOptions) => DecimateResult | Promise<DecimateResult>): Promise<DecimateResult> {
  const groups = mesh.groups as NonNullable<Mesh['groups']>
  const nt = mesh.indices.length / 3
  let covered = 0
  groups.forEach((g, i) => { covered += g.count; if (g.start !== (i === 0 ? 0 : (groups[i - 1] as { start: number; count: number }).start + (groups[i - 1] as { count: number }).count)) throw new MeshError('decimate.groups_unsupported', { reason: 'groups_are_not_a_partition' }) })
  if (covered !== nt) throw new MeshError('decimate.groups_unsupported', { reason: 'groups_do_not_cover_the_mesh' })
  if (nt <= opts.targetTriangles) return { mesh, before: nt, after: nt, maxError: 0, collapses: 0 }
  const parts: DecimateResult[] = []
  for (const g of groups) {
    const share = Math.max(4, Math.round((opts.targetTriangles * g.count) / nt))
    parts.push(await run(slice(mesh, g.start, g.count), { ...opts, targetTriangles: share }))
  }
  let nv = 0, tri = 0
  for (const p of parts) { nv += p.mesh.positions.length / 3; tri += p.mesh.indices.length / 3 }
  const positions = new Float64Array(nv * 3), indices = new Uint32Array(tri * 3)
  const labels = mesh.segments ? new Uint16Array(tri) : undefined
  let vo = 0, to = 0
  const outGroups = parts.map((p, i) => {
    positions.set(p.mesh.positions, vo * 3)
    for (let k = 0; k < p.mesh.indices.length; k++) indices[to * 3 + k] = (p.mesh.indices[k] as number) + vo
    if (labels && p.mesh.segments) labels.set(p.mesh.segments.labels, to)
    const g = { ...(groups[i] as NonNullable<Mesh['groups']>[number]), start: to, count: p.mesh.indices.length / 3 }
    vo += p.mesh.positions.length / 3; to += g.count
    return g
  })
  const out: Mesh = { positions, indices, groups: outGroups }
  if (labels && mesh.segments) out.segments = { labels, table: mesh.segments.table.map(s => ({ ...s })) }
  return { mesh: out, before: nt, after: tri, maxError: Math.max(...parts.map(p => p.maxError)), collapses: parts.reduce((s, p) => s + p.collapses, 0) }
}

export function decimate(mesh: Mesh, opts: DecimateOptions): DecimateResult {
  if (mesh.groups && mesh.groups.length > 0) throw new MeshError('decimate.groups_unsupported', { reason: 'use_decimateBodies' })
  const nv0 = mesh.positions.length / 3, nt0 = mesh.indices.length / 3
  const target = Math.max(4, Math.floor(opts.targetTriangles))
  if (nt0 <= target) return { mesh, before: nt0, after: nt0, maxError: 0, collapses: 0 }
  const keepBoundary = opts.preserveBoundary !== false, keepCreases = opts.preserveCreases !== false
  const cosCrease = Math.cos(((opts.creaseAngle ?? 40) * Math.PI) / 180)
  const maxErr2 = opts.maxError && opts.maxError > 0 ? opts.maxError * opts.maxError : Infinity

  const P = Float64Array.from(mesh.positions)
  const T = Uint32Array.from(mesh.indices)
  const alive = new Uint8Array(nt0).fill(1)
  const labels = mesh.segments ? Uint16Array.from(mesh.segments.labels) : undefined
  let triCount = nt0

  // vertex -> incident triangles (lazy: entries of dead triangles are skipped)
  const vt: number[][] = Array.from({ length: nv0 }, () => [])
  for (let t = 0; t < nt0; t++) for (let k = 0; k < 3; k++) (vt[T[3 * t + k] as number] as number[]).push(t)

  // face normals and areas
  const N = new Float64Array(3 * nt0), A = new Float64Array(nt0)
  const faceNormal = (t: number): void => {
    const a = 3 * (T[3 * t] as number), b = 3 * (T[3 * t + 1] as number), c = 3 * (T[3 * t + 2] as number)
    const ux = (P[b] as number) - (P[a] as number), uy = (P[b + 1] as number) - (P[a + 1] as number), uz = (P[b + 2] as number) - (P[a + 2] as number)
    const vx = (P[c] as number) - (P[a] as number), vy = (P[c + 1] as number) - (P[a + 1] as number), vz = (P[c + 2] as number) - (P[a + 2] as number)
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz)
    A[t] = l / 2
    if (l > 0) { N[3 * t] = nx / l; N[3 * t + 1] = ny / l; N[3 * t + 2] = nz / l } else { N[3 * t] = 0; N[3 * t + 1] = 0; N[3 * t + 2] = 0 }
  }
  for (let t = 0; t < nt0; t++) faceNormal(t)

  // edges: which triangles share each edge
  const key = (a: number, b: number): number => (a < b ? a * nv0 + b : b * nv0 + a)
  const edgeTris = new Map<number, number[]>()
  for (let t = 0; t < nt0; t++) for (let k = 0; k < 3; k++) {
    const kk = key(T[3 * t + k] as number, T[3 * t + ((k + 1) % 3)] as number)
    let l = edgeTris.get(kk)
    if (!l) edgeTris.set(kk, (l = []))
    l.push(t)
  }

  // quadrics, with extra weight on boundary edges, creases and segment borders
  const Q = new Float64Array(10 * nv0)
  let size = 0
  for (let v = 0; v < nv0; v++) { size = Math.max(size, Math.abs(P[3 * v] as number), Math.abs(P[3 * v + 1] as number), Math.abs(P[3 * v + 2] as number)) }
  const locked = new Uint8Array(nv0)       // vertices that must stay on their boundary or crease
  const lockedEdge = new Set<number>()     // edges that are themselves boundary or crease edges
  const edgePlane = (t: number, a: number, b: number, w: number): void => {
    // a plane through the edge a-b, perpendicular to the face: it resists sliding off the edge
    const ex = (P[3 * b] as number) - (P[3 * a] as number), ey = (P[3 * b + 1] as number) - (P[3 * a + 1] as number), ez = (P[3 * b + 2] as number) - (P[3 * a + 2] as number)
    const nx = N[3 * t] as number, ny = N[3 * t + 1] as number, nz = N[3 * t + 2] as number
    let px = ey * nz - ez * ny, py = ez * nx - ex * nz, pz = ex * ny - ey * nx
    const l = Math.hypot(px, py, pz)
    if (l === 0) return
    px /= l; py /= l; pz /= l
    const d = -(px * (P[3 * a] as number) + py * (P[3 * a + 1] as number) + pz * (P[3 * a + 2] as number))
    const el2 = ex * ex + ey * ey + ez * ez
    addPlane(Q, 10 * a, px, py, pz, d, w * el2); addPlane(Q, 10 * b, px, py, pz, d, w * el2)
  }
  for (let t = 0; t < nt0; t++) {
    const a = T[3 * t] as number, b = T[3 * t + 1] as number, c = T[3 * t + 2] as number
    const nx = N[3 * t] as number, ny = N[3 * t + 1] as number, nz = N[3 * t + 2] as number
    const d = -(nx * (P[3 * a] as number) + ny * (P[3 * a + 1] as number) + nz * (P[3 * a + 2] as number))
    for (const v of [a, b, c]) addPlane(Q, 10 * v, nx, ny, nz, d, A[t] as number)
  }
  for (const [k, ts] of edgeTris) {
    const a = Math.floor(k / nv0), b = k - a * nv0
    let hold = false
    if (ts.length === 1) hold = keepBoundary
    else if (ts.length === 2) {
      const t0 = ts[0] as number, t1 = ts[1] as number
      const dot = (N[3 * t0] as number) * (N[3 * t1] as number) + (N[3 * t0 + 1] as number) * (N[3 * t1 + 1] as number) + (N[3 * t0 + 2] as number) * (N[3 * t1 + 2] as number)
      const border = labels !== undefined && labels[t0] !== labels[t1]
      hold = (keepCreases && dot < cosCrease) || border
    } else hold = true // non-manifold: leave alone
    if (hold) {
      lockedEdge.add(k); locked[a] = 1; locked[b] = 1
      for (const t of ts) edgePlane(t, a, b, 100)
    }
  }

  const version = new Int32Array(nv0)
  const dead = new Uint8Array(nv0)
  const heap = new Heap()

  const neighbours = (v: number): Set<number> => {
    const s = new Set<number>()
    for (const t of vt[v] as number[]) {
      if (!alive[t]) continue
      for (let k = 0; k < 3; k++) { const w = T[3 * t + k] as number; if (w !== v) s.add(w) }
    }
    return s
  }

  /** Best place for the merged vertex, and its cost. Null when the pair may not be collapsed. */
  const candidate = (a: number, b: number): { x: number; y: number; z: number; cost: number } | null => {
    const la = locked[a] === 1, lb = locked[b] === 1
    const onEdge = lockedEdge.has(key(a, b))
    if (la && lb && !onEdge) return null            // two held vertices joined by an ordinary edge: collapsing would cut a corner
    const q = new Float64Array(10)
    for (let i = 0; i < 10; i++) q[i] = (Q[10 * a + i] as number) + (Q[10 * b + i] as number)
    const pa: [number, number, number] = [P[3 * a] as number, P[3 * a + 1] as number, P[3 * a + 2] as number]
    const pb: [number, number, number] = [P[3 * b] as number, P[3 * b + 1] as number, P[3 * b + 2] as number]
    const opts2: Array<[number, number, number]> = []
    if (la && !lb) opts2.push(pa)
    else if (lb && !la) opts2.push(pb)
    else if (la && lb) opts2.push(pa, pb)
    else opts2.push(pa, pb, [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2])
    let best: { x: number; y: number; z: number; cost: number } | null = null
    // a tiny preference for short edges: on a flat area every collapse costs the same, and without it the loop keeps merging into one
    // vertex until its star is huge (a 506 000 triangle plate took 226 s); with it the flat area is thinned evenly
    const len2 = (pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2 + (pa[2] - pb[2]) ** 2
    for (const p of opts2) { const c = Math.max(0, evalQ(q, 0, p[0], p[1], p[2])) + 1e-9 * len2; if (!best || c < best.cost) best = { x: p[0], y: p[1], z: p[2], cost: c } }
    return best
  }

  const queue = (a: number, b: number): void => {
    const c = candidate(a, b)
    if (c) heap.push(c.cost, a, b, version[a] as number, version[b] as number)
  }
  for (const k of edgeTris.keys()) { const a = Math.floor(k / nv0); queue(a, k - a * nv0) }

  let collapses = 0, maxCost = 0
  const total = triCount - target
  let tick = 0
  while (triCount > target && heap.size > 0) {
    if (opts.signal?.aborted) throw new MeshError('run.cancelled')
    if ((++tick & 1023) === 0) opts.onProgress?.(Math.min(1, (nt0 - triCount) / Math.max(1, total)))
    const e = heap.pop()
    const { a, b } = e
    if (dead[a] || dead[b] || version[a] !== e.va || version[b] !== e.vb) continue
    if (e.cost > maxErr2) break
    // the pair must still be an edge
    const na = neighbours(a)
    if (!na.has(b)) continue
    // link condition: the neighbours the two vertices share are exactly the far corners of the triangles on the edge
    const nb = neighbours(b)
    const shared: number[] = []
    for (const w of na) if (nb.has(w)) shared.push(w)
    const around = (vt[a] as number[]).filter(t => alive[t] && (T[3 * t] === b || T[3 * t + 1] === b || T[3 * t + 2] === b))
    const corners = new Set<number>()
    for (const t of around) for (let k = 0; k < 3; k++) { const w = T[3 * t + k] as number; if (w !== a && w !== b) corners.add(w) }
    if (shared.length !== corners.size || shared.some(w => !corners.has(w))) continue
    const c = candidate(a, b)
    if (!c) continue
    // no triangle may fold over or collapse into a sliver
    let ok = true
    const check = (v: number): void => {
      for (const t of vt[v] as number[]) {
        if (!ok) return
        if (!alive[t] || around.includes(t)) continue
        const i0 = T[3 * t] as number, i1 = T[3 * t + 1] as number, i2 = T[3 * t + 2] as number
        const pt = (i: number): [number, number, number] => (i === a || i === b ? [c.x, c.y, c.z] : [P[3 * i] as number, P[3 * i + 1] as number, P[3 * i + 2] as number])
        const p0 = pt(i0), p1 = pt(i1), p2 = pt(i2)
        const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2], vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2]
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
        const l = Math.hypot(nx, ny, nz)
        if (l < 1e-12 * Math.max(1, size * size)) { ok = false; return }
        if ((nx * (N[3 * t] as number) + ny * (N[3 * t + 1] as number) + nz * (N[3 * t + 2] as number)) / l < 0.2) { ok = false; return }
      }
    }
    check(a); check(b)
    if (!ok) continue

    // collapse b into a
    P[3 * a] = c.x; P[3 * a + 1] = c.y; P[3 * a + 2] = c.z
    for (let i = 0; i < 10; i++) Q[10 * a + i] = (Q[10 * a + i] as number) + (Q[10 * b + i] as number)
    if (locked[b]) locked[a] = 1
    for (const t of around) { alive[t] = 0; triCount-- }
    for (const t of vt[b] as number[]) {
      if (!alive[t]) continue
      for (let k = 0; k < 3; k++) if (T[3 * t + k] === b) T[3 * t + k] = a
      ;(vt[a] as number[]).push(t)
    }
    vt[b] = []
    dead[b] = 1
    version[a] = (version[a] as number) + 1
    // refresh the geometry of the triangles around the merged vertex and requeue its edges
    const seen = new Set<number>()
    vt[a] = (vt[a] as number[]).filter(t => alive[t] && !seen.has(t) && (seen.add(t), true))
    for (const t of vt[a] as number[]) faceNormal(t)
    for (const w of neighbours(a)) queue(a, w)
    collapses++
    maxCost = Math.max(maxCost, e.cost)
  }

  // compact into a new mesh
  const vmap = new Int32Array(nv0).fill(-1)
  const outP: number[] = []
  const outT: number[] = []
  const outL: number[] = []
  for (let t = 0; t < nt0; t++) {
    if (!alive[t]) continue
    for (let k = 0; k < 3; k++) {
      const v = T[3 * t + k] as number
      if (vmap[v] < 0) { vmap[v] = outP.length / 3; outP.push(P[3 * v] as number, P[3 * v + 1] as number, P[3 * v + 2] as number) }
      outT.push(vmap[v] as number)
    }
    if (labels) outL.push(labels[t] as number)
  }
  const out: Mesh = { positions: Float64Array.from(outP), indices: Uint32Array.from(outT) }
  if (labels && mesh.segments) out.segments = { labels: Uint16Array.from(outL), table: mesh.segments.table.map((s): SegmentInfo => ({ ...s })) }
  opts.onProgress?.(1)
  return { mesh: out, before: nt0, after: outT.length / 3, maxError: Math.sqrt(maxCost), collapses }
}
