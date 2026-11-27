// Cut hole: an exact boolean subtract of a convex cutter (a prism or a frustum with a round, slot or rounded-square section) from a closed solid.
//
// The cutter is a convex polytope (N side faces, a top and a bottom cap). Everything is planar, so every intersection is exact arithmetic on planes:
//  - a triangle of the model that the polytope touches is replaced by "triangle minus the part inside the cutter": the corners of that region are the
//    triangle's own corners outside the cutter, the points where its edges cross the cutter's faces, and the points where the cutter's edges pierce it;
//  - the wall of the hole is, face by face, the part of the cutter's face that lies inside the solid: it is bounded by the same crossing and piercing
//    points (shared by index), so the two sides meet without a gap;
//  - a triangle the cutter does not touch keeps its vertices and its place in the list, bit for bit.
// Both kinds of region are triangulated with a constrained Delaunay triangulation of exactly the points on their boundary (no new points), and kept by an
// even-odd test on the boundary edges. The cutter is nudged by a tiny, fixed amount when a result is not closed (an edge of the cutter exactly on a vertex
// of the model), and the cut is made again: the same input always gives the same output.
import cdt2d from 'cdt2d'
import { MeshError, measureMesh } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'

type V3 = [number, number, number]
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s]
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2])
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l] }

export class HoleFailure extends Error {
  constructor(public readonly reason: string) { super(reason) }
}

/** The 2D section of a cutter, counter-clockwise, in the cutter's own frame (x along `e1`, y along `e2`). */
export function crossSection(shape: 'round' | 'slot' | 'square', width: number, length: number, corner: number, segments: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  // the vertices of a regular polygon are pushed out so that its area equals the area of the true circle
  const fit = (n: number): number => { const a = (2 * Math.PI) / n; return Math.sqrt(a / Math.sin(a)) }
  if (shape === 'round') {
    const n = Math.max(12, segments), r = (width / 2) * fit(n)
    for (let i = 0; i < n; i++) out.push([r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)])
    return out
  }
  if (shape === 'slot') {
    const w = width, L = Math.max(length, width), half = (L - w) / 2, m = Math.max(6, Math.round(segments / 2))
    const r = (w / 2) * Math.sqrt((Math.PI / m) / Math.sin(Math.PI / m))
    for (let i = 0; i <= m; i++) { const a = -Math.PI / 2 + (Math.PI * i) / m; out.push([half + r * Math.cos(a), r * Math.sin(a)]) }
    for (let i = 0; i <= m; i++) { const a = Math.PI / 2 + (Math.PI * i) / m; out.push([-half + r * Math.cos(a), r * Math.sin(a)]) }
    return out
  }
  const hx = width / 2, hy = Math.max(length, 1e-3) / 2, c = Math.min(Math.max(0, corner), Math.min(hx, hy) * 0.999)
  if (c <= 1e-9) return [[hx, -hy], [hx, hy], [-hx, hy], [-hx, -hy]]
  const m = Math.max(3, Math.round(segments / 8))
  const corners: Array<[number, number, number]> = [[hx - c, -hy + c, -90], [hx - c, hy - c, 0], [-hx + c, hy - c, 90], [-hx + c, -hy + c, 180]]
  for (const [cx, cy, a0] of corners) for (let i = 0; i <= m; i++) { const a = ((a0 + (90 * i) / m) * Math.PI) / 180; out.push([cx + c * Math.cos(a), cy + c * Math.sin(a)]) }
  return out
}

export interface Cutter {
  /** A point on the axis (the placement) and the unit axis pointing into the model. */
  origin: V3
  axis: V3
  e1: V3
  e2: V3
  /** The section, counter-clockwise, and where the cutter starts and ends along the axis, with the scale of the section there. */
  section: Array<[number, number]>
  zTop: number; scaleTop: number
  zBottom: number; scaleBottom: number
}

interface Face { n: V3; c: number; ring: number[]; u: V3; v: V3 }
interface PEdge { a: number; b: number; f1: number; f2: number }
interface Poly { verts: V3[]; faces: Face[]; edges: PEdge[]; N: number; min: V3; max: V3 }

function buildPolytope(c: Cutter): Poly {
  const N = c.section.length
  const verts: V3[] = []
  for (const [z, s] of [[c.zTop, c.scaleTop], [c.zBottom, c.scaleBottom]] as Array<[number, number]>) {
    for (const [x, y] of c.section) verts.push(add(add(c.origin, mul(c.axis, z)), add(mul(c.e1, x * s), mul(c.e2, y * s))))
  }
  let ctr: V3 = [0, 0, 0]
  for (const v of verts) ctr = add(ctr, v)
  ctr = mul(ctr, 1 / verts.length)
  const faces: Face[] = []
  const mk = (ring: number[]): Face => {
    // the normal from the largest triangle of the ring fan (stable for a long thin face); pointing away from the middle of the polytope
    let n: V3 = [0, 0, 0]
    for (let i = 1; i + 1 < ring.length; i++) n = add(n, cross(sub(verts[ring[i]!]!, verts[ring[0]!]!), sub(verts[ring[i + 1]!]!, verts[ring[0]!]!)))
    n = norm(n)
    let mid: V3 = [0, 0, 0]
    for (const i of ring) mid = add(mid, verts[i]!)
    mid = mul(mid, 1 / ring.length)
    if (dot(n, sub(mid, ctr)) < 0) n = mul(n, -1)
    const u = norm(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]))
    return { n, c: dot(n, verts[ring[0]!]!), ring, u, v: cross(n, u) }
  }
  for (let i = 0; i < N; i++) faces.push(mk([i, (i + 1) % N, N + ((i + 1) % N), N + i]))
  faces.push(mk(Array.from({ length: N }, (_, i) => i)))
  faces.push(mk(Array.from({ length: N }, (_, i) => N + i)))
  const edges: PEdge[] = []
  for (let i = 0; i < N; i++) edges.push({ a: i, b: (i + 1) % N, f1: i, f2: N })
  for (let i = 0; i < N; i++) edges.push({ a: N + i, b: N + ((i + 1) % N), f1: i, f2: N + 1 })
  for (let i = 0; i < N; i++) edges.push({ a: i, b: N + i, f1: (i + N - 1) % N, f2: i })
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity]
  for (const v of verts) for (let k = 0; k < 3; k++) { if (v[k]! < min[k]!) min[k] = v[k]!; if (v[k]! > max[k]!) max[k] = v[k]! }
  return { verts, faces, edges, N, min, max }
}

/** `flags`: one per triangle, 1 for the triangles the cutter may open (the selected part); the cutter must not touch the others. */
export interface CutInput { positions: Float64Array; indices: Uint32Array; labels?: Uint16Array; flags?: Uint8Array }
export interface CutStats {
  cutTriangles: number[]                 // triangles of the input that the cutter touches (original indices)
  removed: number                        // triangles that lay completely inside the cutter
  bottomWall: boolean                    // the bottom cap of the cutter has a wall (a blind hole), false when the cutter leaves the model there
  wallTriangles: number
  ms: { cut: number; stitch: number }
}
export interface CutOutput extends CutInput { stats: CutStats }

const EPS = 1e-12
/** The square of the largest extent of a set of 2D points (the scale that decides what counts as a zero area). */
const extent2 = (pts: Array<[number, number]>): number => {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  const d = Math.max(x1 - x0, y1 - y0)
  return d * d
}

/** One exact subtraction of one cutter. Throws HoleFailure when the result cannot be built. */
export function cutOnce(input: CutInput, cutter: Cutter, opts: { signal?: AbortSignal | undefined; selected?: Uint8Array | null; onProgress?: (f: number) => void } = {}): CutOutput {
  const t0 = performance.now()
  const poly = buildPolytope(cutter)
  const { faces, edges, N } = poly
  const F = faces.length
  const pos = input.positions, idx = input.indices
  const nv0 = pos.length / 3, nt0 = idx.length / 3
  const extra: number[] = []                                     // the new vertices, from index nv0 on
  const pt = (i: number): V3 => (i < nv0 ? [pos[3 * i]!, pos[3 * i + 1]!, pos[3 * i + 2]!] : [extra[3 * (i - nv0)]!, extra[3 * (i - nv0) + 1]!, extra[3 * (i - nv0) + 2]!])
  const newPoint = (p: V3): number => { extra.push(p[0], p[1], p[2]); return nv0 + extra.length / 3 - 1 }
  const sd = (p: V3, f: Face): number => dot(f.n, p) - f.c

  // ---- the triangles the cutter may touch
  const cand: number[] = []
  for (let t = 0; t < nt0; t++) {
    const a = idx[3 * t]!, b = idx[3 * t + 1]!, c = idx[3 * t + 2]!
    let outside = false
    for (let k = 0; k < 3 && !outside; k++) {
      const lo = Math.min(pos[3 * a + k]!, pos[3 * b + k]!, pos[3 * c + k]!), hi = Math.max(pos[3 * a + k]!, pos[3 * b + k]!, pos[3 * c + k]!)
      if (hi < poly.min[k]! || lo > poly.max[k]!) outside = true
    }
    if (outside) continue
    const A = pt(a), B = pt(b), C = pt(c)
    for (let f = 0; f < F; f++) { const fc = faces[f]!; if (sd(A, fc) >= 0 && sd(B, fc) >= 0 && sd(C, fc) >= 0) { outside = true; break } }
    if (!outside) cand.push(t)
  }

  // ---- per edge: where it is inside the cutter (shared by the two triangles of the edge)
  interface EdgeInfo { s0: number; s1: number; f0: number; f1: number; i0: number; i1: number }
  const einfo = new Map<number, EdgeInfo | null>()
  const edgeInfo = (lo: number, hi: number): EdgeInfo | null => {
    const key = lo * nv0 + hi
    if (einfo.has(key)) return einfo.get(key)!
    const A = pt(lo), B = pt(hi)
    let s0 = 0, s1 = 1, f0 = -1, f1 = -1
    let res: EdgeInfo | null = null
    let miss = false
    for (let f = 0; f < F; f++) {
      const fc = faces[f]!
      const dA = sd(A, fc), dB = sd(B, fc)
      if (dA >= 0 && dB >= 0) { miss = true; break }
      if (dA < 0 && dB < 0) continue
      const s = dA / (dA - dB)
      if (dA >= 0) { if (s > s0) { s0 = s; f0 = f } } else if (s < s1) { s1 = s; f1 = f }
    }
    if (!miss && s0 < s1 - EPS) {
      const at = (s: number): V3 => [A[0] + s * (B[0] - A[0]), A[1] + s * (B[1] - A[1]), A[2] + s * (B[2] - A[2])]
      res = { s0, s1, f0, f1, i0: f0 >= 0 ? newPoint(at(s0)) : -1, i1: f1 >= 0 ? newPoint(at(s1)) : -1 }
    }
    einfo.set(key, res)
    return res
  }

  // ---- the points where an edge of the cutter pierces a triangle (one per edge and triangle)
  const pierce = new Map<number, number>()
  const pierceOn: Array<Array<{ t: number; i: number }>> = edges.map(() => [])
  const piercings = (t: number, A3: V3, B3: V3, C3: V3): Array<{ k: number; i: number }> => {
    const out: Array<{ k: number; i: number }> = []
    const e1 = sub(B3, A3), e2 = sub(C3, A3)
    const lo: V3 = [Math.min(A3[0], B3[0], C3[0]), Math.min(A3[1], B3[1], C3[1]), Math.min(A3[2], B3[2], C3[2])]
    const hi: V3 = [Math.max(A3[0], B3[0], C3[0]), Math.max(A3[1], B3[1], C3[1]), Math.max(A3[2], B3[2], C3[2])]
    for (let k = 0; k < edges.length; k++) {
      const pe = edges[k]!
      const P0 = poly.verts[pe.a]!, P1 = poly.verts[pe.b]!
      let skip = false
      for (let m = 0; m < 3; m++) if (Math.max(P0[m]!, P1[m]!) < lo[m]! || Math.min(P0[m]!, P1[m]!) > hi[m]!) { skip = true; break }
      if (skip) continue
      const D = sub(P1, P0)
      const h = cross(D, e2), det = dot(e1, h)
      if (Math.abs(det) < 1e-18) continue
      const f = 1 / det, s = sub(P0, A3), u = f * dot(s, h)
      if (u <= EPS || u >= 1 - EPS) continue
      const q = cross(s, e1), v = f * dot(D, q)
      if (v <= EPS || u + v >= 1 - EPS) continue
      const tt = f * dot(e2, q)
      if (tt <= EPS || tt >= 1 - EPS) continue
      const key = k * nt0 + t
      let i = pierce.get(key)
      if (i === undefined) { i = newPoint(add(P0, mul(D, tt))); pierce.set(key, i); pierceOn[k]!.push({ t: tt, i }) }
      out.push({ k, i })
    }
    return out
  }

  // ---- the triangles
  interface QV { i: number; faces: number[]; tEdges: number[]; x: number; y: number }
  const wallEdges: Array<Array<[number, number]>> = faces.map(() => [])
  const keep = new Uint8Array(nt0).fill(1)
  const newTris: number[] = []
  const newLabels: number[] = []
  const newFlags: number[] = []
  const cutTriangles: number[] = []
  let removed = 0
  const wallLabelCount = new Map<number, number>()
  for (let ci = 0; ci < cand.length; ci++) {
    if ((ci & 63) === 0) { if (opts.signal?.aborted) throw new MeshError('run.cancelled'); opts.onProgress?.(0.5 * (ci / Math.max(1, cand.length))) }
    const t = cand[ci]!
    const corner = [idx[3 * t]!, idx[3 * t + 1]!, idx[3 * t + 2]!]
    const P3 = corner.map(pt) as [V3, V3, V3]
    const nrm = cross(sub(P3[1], P3[0]), sub(P3[2], P3[0]))
    if (len(nrm) < 1e-14) continue                               // a triangle without area is left alone
    const inside = P3.map(p => faces.every(f => sd(p, f) < 0))
    const label = input.labels ? input.labels[t]! : 0
    if (inside[0] && inside[1] && inside[2]) { keep[t] = 0; removed++; cutTriangles.push(t); wallLabelCount.set(label, (wallLabelCount.get(label) ?? 0) + 1); continue }
    // the three edges in the triangle's own direction: where each is inside the cutter, as parameters along it
    interface Seg { t0: number; t1: number; in0: number; in1: number; f0: number; f1: number }
    const segs: Array<Seg | null> = []
    for (let e = 0; e < 3; e++) {
      const u = corner[e]!, v = corner[(e + 1) % 3]!
      if (u < v) { const g = edgeInfo(u, v); segs.push(g ? { t0: g.s0, t1: g.s1, in0: g.i0, in1: g.i1, f0: g.f0, f1: g.f1 } : null) }
      else { const g = edgeInfo(v, u); segs.push(g ? { t0: 1 - g.s1, t1: 1 - g.s0, in0: g.i1, in1: g.i0, f0: g.f1, f1: g.f0 } : null) }
    }
    const pierced = piercings(t, P3[0], P3[1], P3[2])
    const Q: QV[] = []
    for (let e = 0; e < 3; e++) if (inside[e]) Q.push({ i: corner[e]!, faces: [], tEdges: [e, (e + 2) % 3], x: 0, y: 0 })
    for (let e = 0; e < 3; e++) {
      const g = segs[e]
      if (!g) continue
      if (g.f0 >= 0) Q.push({ i: g.in0, faces: [g.f0], tEdges: [e], x: 0, y: 0 })
      if (g.f1 >= 0) Q.push({ i: g.in1, faces: [g.f1], tEdges: [e], x: 0, y: 0 })
    }
    for (const p of pierced) Q.push({ i: p.i, faces: [edges[p.k]!.f1, edges[p.k]!.f2], tEdges: [], x: 0, y: 0 })
    if (Q.length === 0) continue                                  // the cutter does not reach this triangle
    keep[t] = 0
    cutTriangles.push(t)
    wallLabelCount.set(label, (wallLabelCount.get(label) ?? 0) + 1)
    // the frame of the triangle's plane
    const n = norm(nrm), u = norm(sub(P3[1], P3[0])), v = cross(n, u)
    const xy = (i: number): [number, number] => { const d = sub(pt(i), P3[0]); return [dot(d, u), dot(d, v)] }
    let cx = 0, cy = 0
    for (const q of Q) { [q.x, q.y] = xy(q.i); cx += q.x; cy += q.y }
    cx /= Q.length; cy /= Q.length
    Q.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx))
    const cons: Array<[number, number]> = []
    // the triangle's own edges, outside the cutter
    for (let e = 0; e < 3; e++) {
      const a = corner[e]!, b = corner[(e + 1) % 3]!, g = segs[e]
      if (!g) { cons.push([a, b]); continue }
      if (!inside[e] && g.f0 >= 0) cons.push([a, g.in0])
      if (!inside[(e + 1) % 3] && g.f1 >= 0) cons.push([g.in1, b])
    }
    // the cutter's own outline inside the triangle (the sides of Q that are not on an edge of the triangle), which is also a wall of the hole
    for (let k = 0; k < Q.length; k++) {
      const p = Q[k]!, q = Q[(k + 1) % Q.length]!
      if (Q.length < 3) break
      if (p.tEdges.some(e => q.tEdges.includes(e))) continue
      cons.push([p.i, q.i])
      const common = p.faces.filter(f => q.faces.includes(f))
      if (common.length === 0) throw new HoleFailure('wall_face_unknown')
      wallEdges[common[0]!]!.push([p.i, q.i])
    }
    // triangulate the triangle minus the cutter
    const ids = [...new Set(cons.flat())]
    const local = new Map(ids.map((g, j) => [g, j]))
    const pts: Array<[number, number]> = ids.map(xy)
    const scale2 = extent2(pts)
    const ce = cons.map(([a, b]) => [local.get(a)!, local.get(b)!] as [number, number])
    let tris: Array<[number, number, number]>
    try { tris = cdt2d(pts, ce, { exterior: true, interior: true }) } catch { throw new HoleFailure('triangulation_failed') }
    const inRegion = (px: number, py: number): boolean => {
      let odd = false
      for (const [a, b] of ce) {
        const A = pts[a]!, B = pts[b]!
        if ((A[1] > py) !== (B[1] > py) && px < ((B[0] - A[0]) * (py - A[1])) / (B[1] - A[1]) + A[0]) odd = !odd
      }
      return odd
    }
    for (const [a, b, c] of tris) {
      const A = pts[a]!, B = pts[b]!, C = pts[c]!
      if (!inRegion((A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3)) continue
      const area = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])
      if (Math.abs(area) <= 1e-10 * scale2) continue                 // a sliver on a straight boundary (three collinear points) is not part of the surface
      if (area > 0) newTris.push(ids[a]!, ids[b]!, ids[c]!); else newTris.push(ids[a]!, ids[c]!, ids[b]!)
      newLabels.push(label)
      newFlags.push(input.flags ? input.flags[t]! : 1)
    }
  }
  const t1 = performance.now()
  if (cutTriangles.length === 0) throw new HoleFailure('misses_model')
  if (input.flags && cutTriangles.some(t => !input.flags![t])) throw new HoleFailure('breach')
  if (cutTriangles.length > 400000) throw new HoleFailure('too_heavy')

  // ---- the corners and edges of the cutter that lie inside the solid are the rest of the wall: walk along each edge from one end, switching
  // between outside and inside at every piercing. The state at the first corner comes from one ray through the original model.
  const rayDir = norm([0.5773502691, 0.4082482905, 0.7071067811])
  const insideSolid = (p: V3): boolean => {
    let hits = 0
    for (let t = 0; t < nt0; t++) {
      const A = pt(idx[3 * t]!), e1 = sub(pt(idx[3 * t + 1]!), A), e2 = sub(pt(idx[3 * t + 2]!), A)
      const h = cross(rayDir, e2), det = dot(e1, h)
      if (Math.abs(det) < 1e-18) continue
      const f = 1 / det, s = sub(p, A), u = f * dot(s, h)
      if (u < 0 || u > 1) continue
      const q = cross(s, e1), v = f * dot(rayDir, q)
      if (v < 0 || u + v > 1) continue
      if (f * dot(e2, q) > 0) hits++
    }
    return (hits & 1) === 1
  }
  const polyIdx = new Map<number, number>()
  const polyVertex = (v: number): number => { let i = polyIdx.get(v); if (i === undefined) { i = newPoint(poly.verts[v]!); polyIdx.set(v, i) } return i }
  const vstate: Array<boolean | undefined> = new Array(2 * N).fill(undefined)
  vstate[0] = insideSolid(poly.verts[0]!)
  const sortedOn = pierceOn.map(l => l.slice().sort((a, b) => a.t - b.t))
  // propagate the state of vertex 0 along the edges (the pierce counts decide how the state changes), and check the loops agree
  const propagate = (): void => {
    let changed = true
    while (changed) {
      changed = false
      for (let k = 0; k < edges.length; k++) {
        const e = edges[k]!
        const flip = sortedOn[k]!.length & 1
        const sa = vstate[e.a], sb = vstate[e.b]
        if (sa !== undefined && sb === undefined) { vstate[e.b] = flip ? !sa : sa; changed = true }
        else if (sb !== undefined && sa === undefined) { vstate[e.a] = flip ? !sb : sb; changed = true }
        else if (sa !== undefined && sb !== undefined && (flip ? !sa : sa) !== sb) throw new HoleFailure('inside_state_mismatch')
      }
    }
  }
  propagate()
  for (let k = 0; k < edges.length; k++) {
    const e = edges[k]!
    let state = vstate[e.a]!
    let cur = -1
    const first = polyVertex
    for (const pz of sortedOn[k]!) {
      const here = pz.i
      if (state) { const a = cur === -1 ? first(e.a) : cur; wallEdges[e.f1]!.push([a, here]); wallEdges[e.f2]!.push([a, here]) }
      state = !state; cur = here
    }
    if (state) { const a = cur === -1 ? first(e.a) : cur, b = first(e.b); wallEdges[e.f1]!.push([a, b]); wallEdges[e.f2]!.push([a, b]) }
  }

  // ---- the wall, face by face: the part of the cutter's face that is inside the solid
  const wallTris: number[] = []
  for (let f = 0; f < F; f++) {
    const cons = wallEdges[f]!
    if (cons.length === 0) continue
    const fc = faces[f]!
    const ids = [...new Set(cons.flat())]
    const local = new Map(ids.map((g, j) => [g, j]))
    const xy = (i: number): [number, number] => { const p = pt(i); return [dot(p, fc.u), dot(p, fc.v)] }
    const pts = ids.map(xy)
    const scale2 = extent2(pts)
    const ce = cons.map(([a, b]) => [local.get(a)!, local.get(b)!] as [number, number])
    let tris: Array<[number, number, number]>
    try { tris = cdt2d(pts, ce, { exterior: true, interior: true }) } catch { throw new HoleFailure('triangulation_failed') }
    const inRegion = (px: number, py: number): boolean => {
      let odd = false
      for (const [a, b] of ce) {
        const A = pts[a]!, B = pts[b]!
        if ((A[1] > py) !== (B[1] > py) && px < ((B[0] - A[0]) * (py - A[1])) / (B[1] - A[1]) + A[0]) odd = !odd
      }
      return odd
    }
    for (const [a, b, c] of tris) {
      const A = pts[a]!, B = pts[b]!, C = pts[c]!
      if (!inRegion((A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3)) continue
      const area = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])
      if (Math.abs(area) <= 1e-10 * scale2) continue
      // the wall of the hole faces into the hole: opposite to the outward normal of the cutter's face; in the face's frame (u, v, n) that is clockwise
      if (area < 0) wallTris.push(ids[a]!, ids[b]!, ids[c]!); else wallTris.push(ids[a]!, ids[c]!, ids[b]!)
    }
  }
  let wallLabel = 0, best = -1
  for (const [l, n] of wallLabelCount) if (n > best) { best = n; wallLabel = l }

  // ---- the result: the untouched triangles first, in their order, then the rebuilt ones, then the wall; unused vertices go
  const outIdx: number[] = []
  const outLabels: number[] = []
  const outFlags: number[] = []
  for (let t = 0; t < nt0; t++) if (keep[t]) { outIdx.push(idx[3 * t]!, idx[3 * t + 1]!, idx[3 * t + 2]!); if (input.labels) outLabels.push(input.labels[t]!); if (input.flags) outFlags.push(input.flags[t]!) }
  for (const v of newTris) outIdx.push(v)
  for (const l of newLabels) outLabels.push(l)
  for (const f of newFlags) outFlags.push(f)
  for (const v of wallTris) outIdx.push(v)
  for (let i = 0; i < wallTris.length / 3; i++) { outLabels.push(wallLabel); outFlags.push(1) }
  if (outIdx.length === 0) throw new HoleFailure('too_big')
  const total = nv0 + extra.length / 3
  const used = new Uint8Array(total)
  for (const v of outIdx) used[v] = 1
  const remap = new Int32Array(total).fill(-1)
  let n = 0
  for (let i = 0; i < total; i++) if (used[i]) remap[i] = n++
  const outPos = new Float64Array(3 * n)
  for (let i = 0; i < total; i++) if (used[i]) { const p = pt(i), j = remap[i]!; outPos[3 * j] = p[0]; outPos[3 * j + 1] = p[1]; outPos[3 * j + 2] = p[2] }
  const outIndices = new Uint32Array(outIdx.length)
  for (let i = 0; i < outIdx.length; i++) outIndices[i] = remap[outIdx[i]!]!
  const bottomWall = wallEdges[F - 1]!.length > 0
  const t2 = performance.now()
  return {
    positions: outPos, indices: outIndices, ...(input.labels ? { labels: Uint16Array.from(outLabels) } : {}), ...(input.flags ? { flags: Uint8Array.from(outFlags) } : {}),
    stats: { cutTriangles, removed, bottomWall, wallTriangles: wallTris.length / 3, ms: { cut: t1 - t0, stitch: t2 - t1 } },
  }
}

/**
 * The cutter nudged sideways by a fixed small amount that depends on the attempt. Even the first attempt is nudged, by 0.14 micrometre: a hole placed exactly
 * on a grid line of the model (a corner of its triangles, a straight edge) would have edges of the cutter exactly on edges of the model, and two points a
 * hair apart are harder for the triangulation than two points a little apart. Later attempts nudge more (up to 0.3 mm), only when a result is not closed.
 */
export function nudged(c: Cutter, attempt: number): Cutter {
  const d = [1.37e-4, 9.1e-4, 6.3e-3, 4.3e-2, 3.1e-1][Math.min(Math.max(attempt, 0), 4)]!
  const a = (attempt + 1) * 2.399963
  return { ...c, origin: add(c.origin, add(mul(c.e1, d * Math.cos(a)), mul(c.e2, d * Math.sin(a)))) }
}

/** True when the mesh arrays are a closed solid (every edge used once in each direction). */
export function isClosedSolid(m: CutInput): boolean {
  const mesh: Mesh = { positions: m.positions, indices: m.indices }
  return measureMesh(mesh).watertight
}
