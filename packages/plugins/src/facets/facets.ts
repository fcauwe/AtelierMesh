// Facets: a low-poly mosaic on any closed model, like a hand-made low-poly mug.
//   1. remesh  the surface is remeshed to triangles of about `facet_size` (split long edges, collapse short ones, flip
//              edges towards six neighbours per vertex, slide every vertex towards the middle of its neighbours and back
//              onto the model). Sharp edges (rims, the edge of the base, the borders between colours or bodies) stay where
//              they are: their vertices only slide along them. Flat horizontal faces stay flat. Plain bands at the bottom
//              and the top are cut off at their height (a straight horizontal edge) and remeshed but not moved; parts a
//              caller holds back (the generator's collar) keep their own triangles exactly.
//   2. facets  every vertex moves in or out along its normal by a random amount (up to `jitter`) and a little sideways
//              (`shift`, a share of the facet size). Vertices on a horizontal face only move within it, so the rim and the
//              base stay on their planes. On a wall (a vase, a mug) the inside follows the outside across the wall, or stays
//              smooth, and an inward move never leaves less than `wall`.
//   3. check   where an edge would pass through a triangle, or a triangle would turn over, the move is halved there and
//              around it until nothing crosses; after 6 rounds the remaining places do not move at all.
// Every triangle is flat, so a flat-shaded view shows the facets. Colours: one, alternating or random from a palette, as
// segments. Deterministic: the only randomness is a small generator started from `seed`.
import type { Mesh, MeshGroup, SegmentInfo, StructuredError } from '@ateliermesh/core'
import { checkClosed, crossingVertices } from './mesh-checks'

export interface FacetParams {
  facet_size: number
  jitter: number
  shift: number
  seed: number
  plain_bottom: number
  plain_top: number
  wall: number
  inside: 'follow' | 'smooth'
  facet_colours: 'one' | 'alternating' | 'random'
  palette_size: number
  colour_1: string
  colour_2: string
  colour_3: string
  colour_4: string
}

export interface FacetOptions {
  isCancelled?: () => boolean
  progress?: (stage: 'remesh' | 'facets' | 'check', fraction: number) => void
  /** Segment labels whose triangles stay exactly as they are (the generator's collar). */
  keepLabels?: number[]
  /** Names of the facet colour segments (default facet_1 ...). */
  segmentNames?: string[]
  /** Error code prefix (default `lowpoly`). */
  code?: string
}

export const FEATURE_ANGLE = 35          // degrees: an edge where the surface turns more than this is held as a sharp edge
const CORNER_TURN = 50                   // degrees: a sharp edge that bends more than this at a vertex makes it a corner
const MAX_TRIANGLES = 2_000_000
const problem = (code: string, params: Record<string, unknown> = {}): StructuredError => ({ code, params })
const cancelled = () => problem('run.cancelled')
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d
const BIG = 33554432                     // 2^25: edge keys a * BIG + b stay exact in a double

/** A small seeded generator: the same seed gives the same numbers. */
export function rng(seed: number) {
  let a = (Math.floor(seed) >>> 0) ^ 0x9e3779b9
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// geometry helpers

type V3 = [number, number, number]
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const len = (a: V3) => Math.hypot(a[0], a[1], a[2])
const unit = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l] }

/** The closest point to p on the triangle a, b, c. */
function closestOnTriangle(p: V3, a: V3, b: V3, c: V3): V3 {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a)
  const d1 = dot(ab, ap), d2 = dot(ac, ap)
  if (d1 <= 0 && d2 <= 0) return a
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp)
  if (d3 >= 0 && d4 <= d3) return b
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]] }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp)
  if (d6 >= 0 && d5 <= d6) return c
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]] }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6))
    return [b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])]
  }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]
}
function closestOnSegment(p: V3, a: V3, b: V3): V3 {
  const ab = sub(b, a), l2 = dot(ab, ab)
  const t = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2)) : 0
  return [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]]
}

/** A uniform grid of items (triangles or segments), for closest-point and ray queries. */
class Grid {
  cells = new Map<number, number[]>()
  private stamp = new Int32Array(0)
  private query = 0
  constructor(public h: number) {}
  key(x: number, y: number, z: number) { return (x + 2048) + 4096 * ((y + 2048) + 4096 * (z + 2048)) }
  cell(v: number) { return Math.floor(v / this.h) }
  private put(id: number, x: number, y: number, z: number) {
    const k = this.key(x, y, z)
    let l = this.cells.get(k)
    if (!l) this.cells.set(k, l = [])
    if (l[l.length - 1] !== id) l.push(id)
  }
  /** A segment or a triangle goes into the cells it passes through (sampled at a third of a cell), not its whole box. */
  add(id: number, a: V3, b: V3, c: V3 = b) {
    if (id >= this.stamp.length) { const s = new Int32Array(Math.max(1024, 2 * (id + 1))); s.set(this.stamp); this.stamp = s }
    const n = Math.max(1, Math.ceil((3 * Math.max(len(sub(b, a)), len(sub(c, a)), len(sub(c, b)))) / this.h))
    const seen = new Set<number>()
    for (let i = 0; i <= n; i++) for (let j = 0; i + j <= n; j++) {
      const u = i / n, w = j / n
      const x = this.cell(a[0] + u * (b[0] - a[0]) + w * (c[0] - a[0])), y = this.cell(a[1] + u * (b[1] - a[1]) + w * (c[1] - a[1])), z = this.cell(a[2] + u * (b[2] - a[2]) + w * (c[2] - a[2]))
      const k = this.key(x, y, z)
      if (seen.has(k)) continue
      seen.add(k); this.put(id, x, y, z)
    }
  }
  /** Every item in the cells of the box around p with half-size r, once each. */
  near(p: V3, r: number, visit: (id: number) => void) {
    this.query++
    const x0 = this.cell(p[0] - r), x1 = this.cell(p[0] + r), y0 = this.cell(p[1] - r), y1 = this.cell(p[1] + r), z0 = this.cell(p[2] - r), z1 = this.cell(p[2] + r)
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const l = this.cells.get(this.key(x, y, z))
      if (l) for (const t of l) if (this.stamp[t] !== this.query) { this.stamp[t] = this.query; visit(t) }
    }
  }
}

/** The model's own surface (and its sharp edges), which the remeshed vertices are put back onto. */
class Reference {
  tris: Grid; segs: Grid
  constructor(private P: Float64Array, private I: number[], private N: Float64Array, private S: number[], private chainOf: Int32Array, h: number, private r0: number) {
    this.tris = new Grid(h); this.segs = new Grid(h)
    for (let t = 0; t < I.length / 3; t++) {
      this.tris.add(t, this.v(I[3 * t]!), this.v(I[3 * t + 1]!), this.v(I[3 * t + 2]!))
    }
    for (let s = 0; s < S.length / 2; s++) {
      this.segs.add(s, this.v(S[2 * s]!), this.v(S[2 * s + 1]!))
    }
  }
  v(i: number): V3 { return [this.P[3 * i]!, this.P[3 * i + 1]!, this.P[3 * i + 2]!] }
  /** The closest point on the surface whose face looks the same way as n (so a wall never lands on its other side). */
  onSurface(p: V3, n: V3): V3 {
    let r = this.r0
    for (let ring = 0; ring < 3; ring++, r *= 2) {
      let best: V3 | null = null, bd = Infinity
      this.tris.near(p, r, t => {
        if (this.N[3 * t]! * n[0] + this.N[3 * t + 1]! * n[1] + this.N[3 * t + 2]! * n[2] < 0.2) return
        const q = closestOnTriangle(p, this.v(this.I[3 * t]!), this.v(this.I[3 * t + 1]!), this.v(this.I[3 * t + 2]!))
        const d = len(sub(q, p))
        if (d < bd) { bd = d; best = q }
      })
      if (best && bd <= r) return best
    }
    return p
  }
  /** The closest point on the sharp edges of one chain (the rim's outer edge never lands on its inner edge). */
  onEdge(p: V3, chain: number): V3 {
    let r = this.r0
    for (let ring = 0; ring < 3; ring++, r *= 2) {
      let best: V3 | null = null, bd = Infinity
      this.segs.near(p, r, s => {
        if (this.chainOf[s] !== chain) return
        const q = closestOnSegment(p, this.v(this.S[2 * s]!), this.v(this.S[2 * s + 1]!))
        const d = len(sub(q, p))
        if (d < bd) { bd = d; best = q }
      })
      if (best && bd <= r) return best
    }
    return p
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// the remesher: a triangle list with triangles per vertex, edited in place

class Remesher {
  P: number[]; T: number[]; alive: number[] = []; lab: number[] = []; grp: number[] = []; frz: number[] = []; pln: number[] = []
  vt: number[][] = []; cls: number[] = []; tgt: number[] = []; part: number[] = []; chain: number[] = []
  feat = new Set<number>()
  constructor(P: number[], T: number[], lab: number[], grp: number[], frz: number[], pln: number[], public ref: Reference) {
    this.P = P; this.T = []
    for (let v = 0; v < P.length / 3; v++) this.vt.push([])
    for (let t = 0; t < T.length / 3; t++) this.addTri(T[3 * t]!, T[3 * t + 1]!, T[3 * t + 2]!, lab[t]!, grp[t]!, frz[t]!, pln[t]!)
  }
  key(a: number, b: number) { return a < b ? a * BIG + b : b * BIG + a }
  pos(v: number): V3 { return [this.P[3 * v]!, this.P[3 * v + 1]!, this.P[3 * v + 2]!] }
  set(v: number, p: V3) { this.P[3 * v] = p[0]; this.P[3 * v + 1] = p[1]; this.P[3 * v + 2] = p[2] }
  addTri(a: number, b: number, c: number, lab: number, grp: number, frz: number, pln: number) {
    const t = this.T.length / 3
    this.T.push(a, b, c); this.alive.push(1); this.lab.push(lab); this.grp.push(grp); this.frz.push(frz); this.pln.push(pln)
    this.vt[a]!.push(t); this.vt[b]!.push(t); this.vt[c]!.push(t)
    return t
  }
  dropFrom(v: number, t: number) { const l = this.vt[v]!, i = l.indexOf(t); if (i >= 0) l.splice(i, 1) }
  edgeTris(a: number, b: number) {
    const out: number[] = []
    for (const t of this.vt[a]!) if (this.T[3 * t] === b || this.T[3 * t + 1] === b || this.T[3 * t + 2] === b) out.push(t)
    return out
  }
  neighbours(v: number) {
    const s = new Set<number>()
    for (const t of this.vt[v]!) for (let e = 0; e < 3; e++) { const w = this.T[3 * t + e]!; if (w !== v) s.add(w) }
    return s
  }
  normal(t: number, sub0 = -1, p0?: V3, sub1 = -1, p1?: V3): V3 {
    const g = (v: number) => (v === sub0 ? p0! : v === sub1 ? p1! : this.pos(v))
    const a = g(this.T[3 * t]!), b = g(this.T[3 * t + 1]!), c = g(this.T[3 * t + 2]!)
    return cross(sub(b, a), sub(c, a))
  }
  quality(n: V3, a: V3, b: V3, c: V3) {
    const s = dot(sub(b, a), sub(b, a)) + dot(sub(c, b), sub(c, b)) + dot(sub(a, c), sub(a, c))
    return s > 0 ? (2 * Math.sqrt(3) * len(n)) / s : 0                  // 1 for an equilateral triangle
  }
  vnormal(v: number): V3 {
    let n: V3 = [0, 0, 0]
    for (const t of this.vt[v]!) { const m = this.normal(t); n = [n[0] + m[0], n[1] + m[1], n[2] + m[2]] }
    return unit(n)
  }
  edgeLen(a: number, b: number) { return len(sub(this.pos(a), this.pos(b))) }
  target(a: number, b: number) { return (this.tgt[a]! + this.tgt[b]!) / 2 }
  frozenEdge(a: number, b: number) { return this.edgeTris(a, b).some(t => this.frz[t] === 1) }

  split(a: number, b: number) {
    const ts = this.edgeTris(a, b)
    if (ts.length !== 2) return false
    const m = this.P.length / 3
    const pa = this.pos(a), pb = this.pos(b)
    let p: V3 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2]
    const isFeat = this.feat.has(this.key(a, b))
    if (isFeat) p = this.ref.onEdge(p, this.chain[a]!)
    else {
      const n0 = unit(this.normal(ts[0]!)), n1 = unit(this.normal(ts[1]!))
      p = this.ref.onSurface(p, unit([n0[0] + n1[0], n0[1] + n1[1], n0[2] + n1[2]]))
    }
    this.P.push(p[0], p[1], p[2]); this.vt.push([])
    this.part.push(this.part[a]!); this.chain.push(isFeat ? this.chain[a]! : -1); this.cls.push(isFeat ? 1 : 0); this.tgt.push(isFeat ? Math.min(this.tgt[a]!, this.tgt[b]!) : (this.tgt[a]! + this.tgt[b]!) / 2)
    for (const t of ts) {
      const T = this.T
      let e = 0
      while (!((T[3 * t + e] === a && T[3 * t + (e + 1) % 3] === b) || (T[3 * t + e] === b && T[3 * t + (e + 1) % 3] === a))) e++
      const x = T[3 * t + e]!, y = T[3 * t + (e + 1) % 3]!, z = T[3 * t + (e + 2) % 3]!
      T[3 * t] = x; T[3 * t + 1] = m; T[3 * t + 2] = z
      this.dropFrom(y, t); this.vt[m]!.push(t)
      this.addTri(m, y, z, this.lab[t]!, this.grp[t]!, 0, this.pln[t]!)
    }
    if (isFeat) { this.feat.delete(this.key(a, b)); this.feat.add(this.key(a, m)); this.feat.add(this.key(m, b)) }
    return true
  }

  /** Collapse the edge a-b: the vertex with fewer constraints goes into the other. */
  collapse(a0: number, b0: number) {
    let a = a0, b = b0
    if (this.cls[a]! > this.cls[b]!) { a = b0; b = a0 }
    const ca = this.cls[a]!, cb = this.cls[b]!, isFeat = this.feat.has(this.key(a, b))
    if (ca === 2) return false
    if (ca === 1 && !isFeat) return false
    const ts = this.edgeTris(a, b)
    if (ts.length !== 2 || ts.some(t => this.frz[t] === 1)) return false
    const Na = this.neighbours(a), Nb = this.neighbours(b)
    let common = 0
    for (const v of Na) if (Nb.has(v)) common++
    if (common !== 2) return false
    // the new place: the middle of two free vertices or two vertices on one sharp edge; else the more constrained one
    let p: V3 = this.pos(b)
    if (ca === cb) {
      const pa = this.pos(a), pb = this.pos(b)
      p = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2]
      // a short edge of a dense model: its middle is as good as on the model (the sliding puts it back later)
      if (len(sub(pa, pb)) > 0.25 * this.tgt[b]!) p = ca === 1 ? this.ref.onEdge(p, this.chain[a]!) : this.ref.onSurface(p, this.vnormal(a))
    }
    for (const n of [...Na, ...Nb]) {
      if (n === a || n === b) continue
      if (len(sub(p, this.pos(n))) > (4 / 3) * (this.tgt[n]! + this.tgt[b]!) / 2) return false
    }
    for (const t of [...this.vt[a]!, ...this.vt[b]!]) {
      if (ts.includes(t)) continue
      const n0 = this.normal(t), n1 = this.normal(t, a, p, b, p)
      const l0 = len(n0), l1 = len(n1)
      if (l1 < 1e-9 * Math.max(1, l0) || dot(n0, n1) < 0.6 * l0 * l1) return false
      const g = (v: number) => (v === a || v === b ? p : this.pos(v))
      const A = g(this.T[3 * t]!), B = g(this.T[3 * t + 1]!), C = g(this.T[3 * t + 2]!)
      const q1 = this.quality(n1, A, B, C)
      if (q1 < 0.03 && q1 < 0.5 * this.quality(n0, this.pos(this.T[3 * t]!), this.pos(this.T[3 * t + 1]!), this.pos(this.T[3 * t + 2]!))) return false
    }
    // do it
    this.set(b, p)
    for (const t of ts) {
      this.alive[t] = 0
      for (let e = 0; e < 3; e++) { const v = this.T[3 * t + e]!; if (v !== a) this.dropFrom(v, t) }
    }
    for (const t of this.vt[a]!) {
      if (ts.includes(t)) continue
      for (let e = 0; e < 3; e++) if (this.T[3 * t + e] === a) this.T[3 * t + e] = b
      this.vt[b]!.push(t)
    }
    this.vt[a] = []
    for (const n of Na) {
      const k = this.key(a, n)
      if (this.feat.has(k)) { this.feat.delete(k); if (n !== b) this.feat.add(this.key(b, n)) }
    }
    this.tgt[b] = Math.min(this.tgt[a]!, this.tgt[b]!)
    return true
  }

  flip(a: number, b: number) {
    if (this.feat.has(this.key(a, b))) return false
    const ts = this.edgeTris(a, b)
    if (ts.length !== 2 || this.frz[ts[0]!] || this.frz[ts[1]!]) return false
    // orient: t1 has a -> b, t2 has b -> a
    const T = this.T
    const dir = (t: number, x: number, y: number) => { for (let e = 0; e < 3; e++) if (T[3 * t + e] === x && T[3 * t + (e + 1) % 3] === y) return T[3 * t + (e + 2) % 3]!; return -1 }
    let t1 = ts[0]!, t2 = ts[1]!
    let c = dir(t1, a, b)
    if (c < 0) { t1 = ts[1]!; t2 = ts[0]!; c = dir(t1, a, b) }
    const d = dir(t2, b, a)
    if (c < 0 || d < 0 || c === d) return false
    if (this.neighbours(c).has(d)) return false
    const tv = (v: number) => (this.cls[v]! === 0 ? 6 : 4)
    const va = this.vt[a]!.length, vb = this.vt[b]!.length, vc = this.vt[c]!.length, vd = this.vt[d]!.length
    const before = (va - tv(a)) ** 2 + (vb - tv(b)) ** 2 + (vc - tv(c)) ** 2 + (vd - tv(d)) ** 2
    const after = (va - 1 - tv(a)) ** 2 + (vb - 1 - tv(b)) ** 2 + (vc + 1 - tv(c)) ** 2 + (vd + 1 - tv(d)) ** 2
    if (after >= before) return false
    const n1 = unit(this.normal(t1)), n2 = unit(this.normal(t2))
    if (dot(n1, n2) < Math.cos((30 * Math.PI) / 180)) return false
    const pa = this.pos(a), pb = this.pos(b), pc = this.pos(c), pd = this.pos(d)
    const m1 = cross(sub(pd, pa), sub(pc, pa)), m2 = cross(sub(pb, pd), sub(pc, pd))
    const avg = unit([n1[0] + n2[0], n1[1] + n2[1], n1[2] + n2[2]])
    if (dot(unit(m1), avg) < 0.7 || dot(unit(m2), avg) < 0.7) return false
    if (this.quality(m1, pa, pd, pc) < 0.1 || this.quality(m2, pd, pb, pc) < 0.1) return false
    T[3 * t1] = a; T[3 * t1 + 1] = d; T[3 * t1 + 2] = c
    T[3 * t2] = d; T[3 * t2 + 1] = b; T[3 * t2 + 2] = c
    this.dropFrom(a, t2); this.dropFrom(b, t1); this.vt[c]!.push(t2); this.vt[d]!.push(t1)
    return true
  }

  /** Slide every free vertex towards the middle of its neighbours, then back onto the model; vertices on a sharp edge slide along it. */
  relax() {
    const nv = this.P.length / 3
    for (let v = 0; v < nv; v++) {
      const ts = this.vt[v]!
      if (ts.length === 0 || this.cls[v] === 2) continue
      const p = this.pos(v)
      let q: V3
      if (this.cls[v] === 1) {
        const f: number[] = []
        for (const w of this.neighbours(v)) if (this.feat.has(this.key(v, w))) f.push(w)
        if (f.length !== 2) continue
        const A = this.pos(f[0]!), B = this.pos(f[1]!)
        q = this.ref.onEdge([p[0] + 0.5 * ((A[0] + B[0]) / 2 - p[0]), p[1] + 0.5 * ((A[1] + B[1]) / 2 - p[1]), p[2] + 0.5 * ((A[2] + B[2]) / 2 - p[2])], this.chain[v]!)
      } else {
        let cx = 0, cy = 0, cz = 0, wa = 0
        const n = this.vnormal(v)
        for (const t of ts) {
          const a = this.T[3 * t]!, b = this.T[3 * t + 1]!, c = this.T[3 * t + 2]!
          const ar = len(this.normal(t))
          cx += ar * (this.P[3 * a]! + this.P[3 * b]! + this.P[3 * c]!) / 3; cy += ar * (this.P[3 * a + 1]! + this.P[3 * b + 1]! + this.P[3 * c + 1]!) / 3; cz += ar * (this.P[3 * a + 2]! + this.P[3 * b + 2]! + this.P[3 * c + 2]!) / 3
          wa += ar
        }
        if (wa <= 0) continue
        let d: V3 = [cx / wa - p[0], cy / wa - p[1], cz / wa - p[2]]
        const k = dot(d, n)
        d = [d[0] - k * n[0], d[1] - k * n[1], d[2] - k * n[2]]
        q = this.ref.onSurface([p[0] + 0.8 * d[0], p[1] + 0.8 * d[1], p[2] + 0.8 * d[2]], n)
      }
      // keep it only when no triangle turns over or gets much worse
      let ok = true
      for (const t of ts) {
        const n0 = this.normal(t), n1 = this.normal(t, v, q), l0 = len(n0), l1 = len(n1)
        if (l1 < 1e-12 || dot(n0, n1) < 0.7 * l0 * l1) { ok = false; break }
      }
      if (ok) this.set(v, q)
    }
  }

  run(iterations: number, isCancelled: () => boolean, progress: (f: number) => void) {
    for (let it = 0; it < iterations; it++) {
      if (isCancelled()) throw cancelled()
      progress(it / iterations)
      // split long edges
      for (let t = 0; t < this.T.length / 3; t++) {
        if (!this.alive[t] || this.frz[t]) continue
        if ((t & 16383) === 0 && isCancelled()) throw cancelled()
        // the longest edge first (longest-edge bisection: needles from a model's long strips do not multiply)
        let be = -1, bl = 0
        for (let e = 0; e < 3; e++) {
          const a = this.T[3 * t + e]!, b = this.T[3 * t + (e + 1) % 3]!, l = this.edgeLen(a, b)
          if (l > bl) { bl = l; be = e }
        }
        const a = this.T[3 * t + be]!, b = this.T[3 * t + (be + 1) % 3]!
        if (bl > (4 / 3) * this.target(a, b) && !this.frozenEdge(a, b) && this.split(a, b)) t--
        if (this.T.length / 3 > MAX_TRIANGLES) throw problem('lowpoly.too_many_triangles', { triangles: this.T.length / 3, limit: MAX_TRIANGLES })
      }
      // collapse short edges (a few rounds: a dense model comes down step by step)
      for (let round = 0; round < 12; round++) {
        // the threshold grows over the rounds: a dense model comes down evenly, without vertices that gather many neighbours
        const share = Math.min(0.8, 0.2 * (round + 1))
        let n = 0
        for (let t = 0; t < this.T.length / 3; t++) {
          if (!this.alive[t] || this.frz[t]) continue
          if ((t & 16383) === 0 && isCancelled()) throw cancelled()
          for (let e = 0; e < 3; e++) {
            const a = this.T[3 * t + e]!, b = this.T[3 * t + (e + 1) % 3]!
            if (this.edgeLen(a, b) < share * this.target(a, b) && this.collapse(a, b)) { n++; break }
          }
        }
        if (n === 0 && share >= 0.8) break
      }
      // flip towards six neighbours per vertex
      for (let t = 0; t < this.T.length / 3; t++) {
        if (!this.alive[t] || this.frz[t]) continue
        for (let e = 0; e < 3; e++) {
          const a = this.T[3 * t + e]!, b = this.T[3 * t + (e + 1) % 3]!
          if (a < b && this.flip(a, b)) break
        }
      }
      this.relax()
    }
    progress(1)
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// the step

export interface FacetBase {
  positions: Float64Array; indices: Uint32Array; lab: Uint16Array; grp: Int32Array; frz: Uint8Array; plain: Uint8Array
  locked: Uint8Array; onPlane: Uint8Array; normals: Float64Array
  facetSize: number; facetAsked: number; crossingsLeft: number; partsReduced: number
}

/** Cut a closed mesh at the plane z = h: triangles that pass it are split, with one shared vertex per cut edge, so it stays closed. */
function cutPlane(P: number[], I: number[], src: number[], h: number) {
  const outI: number[] = [], outS: number[] = []
  const cut = new Map<number, number>()
  const side = (v: number) => { const d = P[3 * v + 2]! - h; return Math.abs(d) < 1e-7 ? 0 : d > 0 ? 1 : -1 }
  const at = (a: number, b: number) => {
    const lo = Math.min(a, b), hi = Math.max(a, b), k = lo * BIG + hi
    let v = cut.get(k)
    if (v === undefined) {
      const za = P[3 * lo + 2]!, zb = P[3 * hi + 2]!, f = (h - za) / (zb - za)
      v = P.length / 3
      P.push(P[3 * lo]! + f * (P[3 * hi]! - P[3 * lo]!), P[3 * lo + 1]! + f * (P[3 * hi + 1]! - P[3 * lo + 1]!), h)
      cut.set(k, v)
    }
    return v
  }
  for (let t = 0; t < I.length / 3; t++) {
    const v = [I[3 * t]!, I[3 * t + 1]!, I[3 * t + 2]!], s = v.map(side)
    if (!(s.includes(1) && s.includes(-1))) { outI.push(v[0]!, v[1]!, v[2]!); outS.push(src[t]!); continue }
    const poly: Array<[number, number]> = []
    for (let e = 0; e < 3; e++) {
      poly.push([v[e]!, s[e]!])
      const f = (e + 1) % 3
      if (s[e]! * s[f]! < 0) poly.push([at(v[e]!, v[f]!), 0])
    }
    for (const keep of [-1, 1]) {
      const q = poly.filter(x => x[1] === 0 || x[1] === keep).map(x => x[0])
      for (let k = 1; k + 1 < q.length; k++) { outI.push(q[0]!, q[k]!, q[k + 1]!); outS.push(src[t]!) }
    }
  }
  return { I: outI, src: outS }
}

/** Remesh the model to facets of about `facet_size` (made smaller in steps when its walls would cross). */
export function facetBase(input: Mesh, p: FacetParams, opt: FacetOptions = {}): FacetBase {
  const isCancelled = opt.isCancelled ?? (() => false)
  const progress = opt.progress ?? (() => {})
  const code = opt.code ?? 'lowpoly'
  const nt0 = input.indices.length / 3
  if (nt0 === 0) throw problem(`${code}.empty_input`, { triangles: 0 })
  checkClosed(input.indices, input.positions.length / 3, `${code}.not_closed`)
  progress('remesh', 0)
  // plain bands: cut at their heights, so the band ends in a straight horizontal edge
  let lo = Infinity, hi = -Infinity
  for (let i = 2; i < input.positions.length; i += 3) { lo = Math.min(lo, input.positions[i]!); hi = Math.max(hi, input.positions[i]!) }
  const P0 = Array.from(input.positions)
  let I0 = Array.from(input.indices), src = Array.from({ length: nt0 }, (_, t) => t)
  const zb = p.plain_bottom > 0 ? lo + p.plain_bottom : -Infinity, zt = p.plain_top > 0 ? hi - p.plain_top : Infinity
  if (zb > lo && zb < hi) ({ I: I0, src } = cutPlane(P0, I0, src, zb))
  if (zt > lo && zt < hi) ({ I: I0, src } = cutPlane(P0, I0, src, zt))
  const nt = I0.length / 3
  const groupOf = new Int32Array(nt0).fill(-1)
  input.groups?.forEach((g, k) => { for (let t = g.start; t < g.start + g.count; t++) groupOf[t] = k })
  const keep = new Set(opt.keepLabels ?? [])
  const lab = src.map(t => input.segments?.labels[t] ?? 0), grp = src.map(t => groupOf[t]!)
  const frz = new Array<number>(nt).fill(0), pln = new Array<number>(nt).fill(0)
  for (let t = 0; t < nt; t++) {
    const zc = (P0[3 * I0[3 * t]! + 2]! + P0[3 * I0[3 * t + 1]! + 2]! + P0[3 * I0[3 * t + 2]! + 2]!) / 3
    if (keep.has(lab[t]!)) frz[t] = 1
    else if (zc < zb || zc > zt) pln[t] = 1
  }
  // the model's face normals and its sharp edges (also borders between colours, bodies and held-back parts)
  const Pf = Float64Array.from(P0)
  const FN = new Float64Array(nt * 3)
  for (let t = 0; t < nt; t++) {
    const a = I0[3 * t]!, b = I0[3 * t + 1]!, c = I0[3 * t + 2]!
    const A: V3 = [Pf[3 * a]!, Pf[3 * a + 1]!, Pf[3 * a + 2]!], B: V3 = [Pf[3 * b]!, Pf[3 * b + 1]!, Pf[3 * b + 2]!], C: V3 = [Pf[3 * c]!, Pf[3 * c + 1]!, Pf[3 * c + 2]!]
    const n = unit(cross(sub(B, A), sub(C, A)))
    FN[3 * t] = n[0]; FN[3 * t + 1] = n[1]; FN[3 * t + 2] = n[2]
  }
  const edgeT = new Map<number, number[]>()
  for (let t = 0; t < nt; t++) for (let e = 0; e < 3; e++) {
    const a = I0[3 * t + e]!, b = I0[3 * t + (e + 1) % 3]!, k = a < b ? a * BIG + b : b * BIG + a
    let l = edgeT.get(k)
    if (!l) edgeT.set(k, l = [])
    l.push(t)
  }
  const cosF = Math.cos((FEATURE_ANGLE * Math.PI) / 180)
  const featKeys: number[] = [], segs: number[] = []
  for (const [k, l] of edgeT) {
    if (l.length !== 2) continue
    const [t, u] = l as [number, number]
    const d = FN[3 * t]! * FN[3 * u]! + FN[3 * t + 1]! * FN[3 * u + 1]! + FN[3 * t + 2]! * FN[3 * u + 2]!
    if (d < cosF || lab[t] !== lab[u] || grp[t] !== grp[u] || frz[t] !== frz[u] || pln[t] !== pln[u]) { featKeys.push(k); segs.push(Math.floor(k / BIG), k % BIG) }
  }
  const L0 = Math.max(1, p.facet_size)
  // the grid: cells of about two typical edges of the model (at most a third of a facet), searched from a small box outwards
  const lens: number[] = []
  for (let t = 0; t < nt; t += Math.max(1, Math.floor(nt / 20000))) for (let e = 0; e < 3; e++) { const a = I0[3 * t + e]!, b = I0[3 * t + (e + 1) % 3]!; lens.push(Math.hypot(Pf[3 * a]! - Pf[3 * b]!, Pf[3 * a + 1]! - Pf[3 * b + 1]!, Pf[3 * a + 2]! - Pf[3 * b + 2]!)) }
  lens.sort((x, y) => x - y)
  // chains: sharp edges joined end to end (the outer rim, the inner rim, the edge of the base ...)
  const croot = Int32Array.from({ length: P0.length / 3 }, (_, v) => v)
  const cfind = (v: number): number => { while (croot[v] !== v) { croot[v] = croot[croot[v]!]!; v = croot[v]! } return v }
  for (let k = 0; k < segs.length; k += 2) croot[cfind(segs[k]!)] = cfind(segs[k + 1]!)
  const onChain = new Uint8Array(P0.length / 3)
  for (const v of segs) onChain[v] = 1
  const chainOfVertex = (v: number) => (onChain[v] ? cfind(v) : -1)
  const segChain = new Int32Array(segs.length / 2)
  for (let k = 0; k < segs.length / 2; k++) segChain[k] = cfind(segs[2 * k]!)
  const hRef = Math.min(Math.max(2 * lens[Math.floor(lens.length / 2)]!, 0.5), L0 / 3)
  const ref = new Reference(Pf, I0, FN, segs, segChain, hRef, Math.max(0.25, Math.min(L0 / 8, hRef / 2)))

  // the separate parts (bodies) of the model: a part whose walls cross at this facet size gets smaller facets, the others keep theirs
  const nv0 = P0.length / 3, root = Int32Array.from({ length: nv0 }, (_, v) => v)
  const find = (v: number): number => { while (root[v] !== v) { root[v] = root[root[v]!]!; v = root[v]! } return v }
  for (let t = 0; t < nt; t++) { const a = find(I0[3 * t]!), b = find(I0[3 * t + 1]!), c = find(I0[3 * t + 2]!); root[b] = a; root[find(c)] = a }
  const partOf = new Int32Array(nv0), partIds = new Map<number, number>(), partTris: number[] = []
  for (let v = 0; v < nv0; v++) { const r = find(v); if (!partIds.has(r)) { partIds.set(r, partIds.size); partTris.push(0) } partOf[v] = partIds.get(r)! }
  for (let t = 0; t < nt; t++) partTris[partOf[I0[3 * t]!]!]!++
  const mainPart = partTris.indexOf(Math.max(...partTris))
  const Lp = new Float64Array(partIds.size).fill(L0)
  let best: FacetBase | undefined
  for (let attempt = 0; attempt < 5; attempt++) {
    const rm = new Remesher(P0.slice(), I0.slice(), lab, grp, frz, pln, ref)
    for (const k of featKeys) rm.feat.add(k)
    const nv = P0.length / 3
    // classes: 0 free, 1 on a sharp edge (two sharp edges that go on fairly straight), 2 held (corners, held-back parts)
    const fe: number[][] = Array.from({ length: nv }, () => [])
    for (const k of featKeys) { const a = Math.floor(k / BIG), b = k % BIG; fe[a]!.push(b); fe[b]!.push(a) }
    const cosC = Math.cos((CORNER_TURN * Math.PI) / 180)
    for (let v = 0; v < nv; v++) {
      let c = fe[v]!.length === 0 ? 0 : fe[v]!.length === 2 ? 1 : 2
      if (c === 1) {
        const p0 = rm.pos(v), d1 = unit(sub(p0, rm.pos(fe[v]![0]!))), d2 = unit(sub(rm.pos(fe[v]![1]!), p0))
        if (dot(d1, d2) < cosC) c = 2
      }
      rm.cls.push(c); rm.tgt.push(Lp[partOf[v]!]!); rm.part.push(partOf[v]!); rm.chain.push(chainOfVertex(v))
    }
    for (let t = 0; t < nt; t++) if (frz[t]) for (let e = 0; e < 3; e++) rm.cls[I0[3 * t + e]!] = 2
    // small closed sharp-edge loops (a vent hole, the small top of an ornament) get shorter edges: at least 6 around
    const seen = new Uint8Array(nv)
    for (let v = 0; v < nv; v++) {
      if (seen[v] || rm.cls[v] !== 1) continue
      const loop = [v]; seen[v] = 1
      let prev = v, cur = fe[v]![0]!, length = rm.edgeLen(v, cur), closed = false
      while (rm.cls[cur] === 1 && !seen[cur]) {
        seen[cur] = 1; loop.push(cur)
        const next = fe[cur]![0] === prev ? fe[cur]![1]! : fe[cur]![0]!
        length += rm.edgeLen(cur, next); prev = cur; cur = next
      }
      if (cur === v) closed = true
      if (!closed || length / 6 >= Lp[partOf[v]!]!) continue
      const lt = Math.max(0.5, length / 6)
      for (const w of loop) rm.tgt[w] = Math.min(rm.tgt[w]!, lt)
      const onLoop = new Set(loop)
      // around it the size grows by half the distance, so the facets near a small top or hole are small too
      let cx = 0, cy = 0, cz = 0
      for (const w of loop) { cx += P0[3 * w]! / loop.length; cy += P0[3 * w + 1]! / loop.length; cz += P0[3 * w + 2]! / loop.length }
      let rl = 0
      for (const w of loop) rl = Math.max(rl, Math.hypot(P0[3 * w]! - cx, P0[3 * w + 1]! - cy, P0[3 * w + 2]! - cz))
      for (let u = 0; u < nv; u++) {
        if (onLoop.has(u)) continue
        const d = Math.hypot(P0[3 * u]! - cx, P0[3 * u + 1]! - cy, P0[3 * u + 2]! - cz) - rl
        if (d < 2 * Lp[partOf[u]!]!) rm.tgt[u] = Math.min(rm.tgt[u]!, lt + 0.5 * Math.max(0, d))
      }
    }
    rm.run(8, isCancelled, f => progress('remesh', (attempt + f) / 5))
    // compact
    const map = new Int32Array(rm.P.length / 3).fill(-1)
    const pos: number[] = [], idx: number[] = [], labs: number[] = [], grps: number[] = [], frzs: number[] = [], plns: number[] = []
    const order: number[] = []
    for (let t = 0; t < rm.T.length / 3; t++) if (rm.alive[t]) order.push(t)
    order.sort((x, y) => rm.grp[x]! - rm.grp[y]! || x - y)                 // bodies stay in one range each
    for (const t of order) {
      for (let e = 0; e < 3; e++) {
        const v = rm.T[3 * t + e]!
        if (map[v]! < 0) { map[v] = pos.length / 3; pos.push(rm.P[3 * v]!, rm.P[3 * v + 1]!, rm.P[3 * v + 2]!) }
        idx.push(map[v]!)
      }
      labs.push(rm.lab[t]!); grps.push(rm.grp[t]!); frzs.push(rm.frz[t]!); plns.push(rm.pln[t]!)
    }
    const positions = Float64Array.from(pos), indices = Uint32Array.from(idx)
    const nvo = positions.length / 3
    const locked = new Uint8Array(nvo)
    for (let v = 0; v < rm.P.length / 3; v++) if (map[v]! >= 0 && rm.cls[v] === 2 && rm.vt[v]!.some(t => rm.frz[t] === 1)) locked[map[v]!] = 1
    const partOut = new Int32Array(nvo)
    for (let v = 0; v < rm.P.length / 3; v++) if (map[v]! >= 0) partOut[map[v]!] = rm.part[v]!
    const cv = crossingVertices(positions, indices, new Uint8Array(nvo).fill(1))
    const base = finishBase(positions, indices, Uint16Array.from(labs), Int32Array.from(grps), Uint8Array.from(frzs), Uint8Array.from(plns), locked, Lp[mainPart]!, L0, cv.length)
    base.partsReduced = Array.from(Lp).filter(x => x < L0).length
    if (!best || cv.length < best.crossingsLeft) best = base
    if (cv.length === 0) break
    // a wall too thin for this facet size: smaller facets on that part
    let changed = false
    for (const c of new Set(cv.map(v => partOut[v]!))) if (Lp[c]! > 2) { Lp[c] = Math.max(2, Lp[c]! * 0.75); changed = true }
    if (!changed) break
  }
  progress('remesh', 1)
  return best!
}

function finishBase(positions: Float64Array, indices: Uint32Array, lab: Uint16Array, grp: Int32Array, frz: Uint8Array, plain: Uint8Array, locked: Uint8Array, L: number, L0: number, crossings: number): FacetBase {
  const nv = positions.length / 3, nt = indices.length / 3
  const normals = new Float64Array(nv * 3), onPlane = new Uint8Array(nv)
  for (let t = 0; t < nt; t++) {
    const a = indices[3 * t]!, b = indices[3 * t + 1]!, c = indices[3 * t + 2]!
    const A: V3 = [positions[3 * a]!, positions[3 * a + 1]!, positions[3 * a + 2]!], B: V3 = [positions[3 * b]!, positions[3 * b + 1]!, positions[3 * b + 2]!], C: V3 = [positions[3 * c]!, positions[3 * c + 1]!, positions[3 * c + 2]!]
    const n = cross(sub(B, A), sub(C, A))
    const flat = Math.abs(n[2]) > 0.99995 * len(n) && Math.abs(A[2] - B[2]) < 1e-6 && Math.abs(A[2] - C[2]) < 1e-6
    for (const v of [a, b, c]) { normals[3 * v]! += n[0]; normals[3 * v + 1]! += n[1]; normals[3 * v + 2]! += n[2]; if (flat) onPlane[v] = 1 }
    if (plain[t]) { locked[a] = 1; locked[b] = 1; locked[c] = 1 }                  // plain bands: remeshed, but not moved
  }
  for (let v = 0; v < nv; v++) { const l = Math.hypot(normals[3 * v]!, normals[3 * v + 1]!, normals[3 * v + 2]!) || 1; normals[3 * v]! /= l; normals[3 * v + 1]! /= l; normals[3 * v + 2]! /= l }
  return { positions, indices, lab, grp, frz, plain, locked, onPlane, normals, facetSize: L, facetAsked: L0, crossingsLeft: crossings, partsReduced: 0 }
}

export interface FacetMoves {
  /** The full move of every vertex (mm), before the check. */
  move: Float64Array
  /** Vertices with the other side of a wall within reach: the check keeps at least `wall` there. */
  shell: Uint8Array
  /** Per vertex: the way into the material, along which it moves in (level on a flat face). */
  inDir: Float64Array
  wall: number
  innerFollowing: number
  limitedInwards: number
}

/** A grid of the triangles of P, I (cells of size h). */
function triangleGrid(P: Float64Array, I: Uint32Array, h: number) {
  const grid = new Grid(h)
  const vx = (i: number): V3 => [P[3 * i]!, P[3 * i + 1]!, P[3 * i + 2]!]
  for (let t = 0; t < I.length / 3; t++) grid.add(t, vx(I[3 * t]!), vx(I[3 * t + 1]!), vx(I[3 * t + 2]!))
  return grid
}
/** The first triangle (not one of v's own) hit going from vertex v along d, within `reach`: distance, triangle, barycentric place. */
function rayFrom(P: Float64Array, I: Uint32Array, grid: Grid, v: number, d: V3, reach: number) {
  return rayAt(P, I, grid, [P[3 * v]!, P[3 * v + 1]!, P[3 * v + 2]!], d, reach, (a, b, c) => a === v || b === v || c === v)
}
/** The same from a point o, leaving out the triangles `skip` names by their corners. */
function rayAt(P: Float64Array, I: Uint32Array, grid: Grid, o: V3, d: V3, reach: number, skip: (a: number, b: number, c: number) => boolean) {
  const mid: V3 = [o[0] + d[0] * reach / 2, o[1] + d[1] * reach / 2, o[2] + d[2] * reach / 2]
  let best = Infinity, bt = -1, bu = 0, bw = 0
  grid.near(mid, reach / 2, t => {
    const a = I[3 * t]!, b = I[3 * t + 1]!, c = I[3 * t + 2]!
    if (skip(a, b, c)) return
    const p0: V3 = [P[3 * a]!, P[3 * a + 1]!, P[3 * a + 2]!]
    const e1: V3 = [P[3 * b]! - p0[0], P[3 * b + 1]! - p0[1], P[3 * b + 2]! - p0[2]], e2: V3 = [P[3 * c]! - p0[0], P[3 * c + 1]! - p0[1], P[3 * c + 2]! - p0[2]]
    const q = cross(d, e2), det = dot(e1, q)
    if (Math.abs(det) < 1e-12) return
    const s0 = sub(o, p0), u = dot(s0, q) / det
    if (u < 0 || u > 1) return
    const r = cross(s0, e1), w = dot(d, r) / det
    if (w < 0 || u + w > 1) return
    const dist = dot(e2, r) / det
    if (dist > 1e-6 && dist < best && dist <= reach) { best = dist; bt = t; bu = u; bw = w }
  })
  return { dist: best, t: bt, u: bu, w: bw }
}

/** The random move of every vertex at full strength (k = 1); the same seed gives the same moves. */
export function facetMoves(base: FacetBase, p: FacetParams): FacetMoves {
  const P = base.positions, I = base.indices, N = base.normals, nv = P.length / 3, nt = I.length / 3
  const L = base.facetSize
  const rand = rng(p.seed)
  const U1 = new Float64Array(nv), U2 = new Float64Array(nv), U3 = new Float64Array(nv)
  for (let v = 0; v < nv; v++) { U1[v] = rand(); U2[v] = rand(); U3[v] = rand() }
  // the axis: the middle of the footprint
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (let v = 0; v < nv; v++) { x0 = Math.min(x0, P[3 * v]!); x1 = Math.max(x1, P[3 * v]!); y0 = Math.min(y0, P[3 * v + 1]!); y1 = Math.max(y1, P[3 * v + 1]!) }
  const ax = (x0 + x1) / 2, ay = (y0 + y1) / 2
  // vertex -> triangles, and a grid of triangles for rays into the material
  const deg = new Int32Array(nv + 1)
  for (let k = 0; k < I.length; k++) deg[I[k]! + 1]!++
  for (let v = 0; v < nv; v++) deg[v + 1]! += deg[v]!
  const vt = new Int32Array(deg[nv]!), fill = deg.slice(0, nv)
  for (let t = 0; t < nt; t++) for (let e = 0; e < 3; e++) vt[fill[I[3 * t + e]!]!++] = t
  const shellMax = Math.max(4 * p.wall, 8)
  const vx = (i: number): V3 => [P[3 * i]!, P[3 * i + 1]!, P[3 * i + 2]!]
  const grid = triangleGrid(P, I, Math.max(2, Math.min(L, shellMax)))
  // the way into the material: against the normal, level on a flat face (a corner there only moves level)
  const inDir = new Float64Array(nv * 3)
  for (let v = 0; v < nv; v++) {
    let d: V3 = [-N[3 * v]!, -N[3 * v + 1]!, -N[3 * v + 2]!]
    if (base.onPlane[v]) { const h = Math.hypot(d[0], d[1]); d = h > 0.1 ? [d[0] / h, d[1] / h, 0] : d }
    inDir[3 * v] = d[0]; inDir[3 * v + 1] = d[1]; inDir[3 * v + 2] = d[2]
  }
  /** The first triangle hit going from vertex v into the material. */
  const inward = (v: number) => rayFrom(P, I, grid, v, [inDir[3 * v]!, inDir[3 * v + 1]!, inDir[3 * v + 2]!], shellMax)
  const radialDot = (v: number) => {
    const rx = P[3 * v]! - ax, ry = P[3 * v + 1]! - ay, r = Math.hypot(rx, ry)
    return r < 1 ? 0 : (N[3 * v]! * rx + N[3 * v + 1]! * ry) / r
  }
  const candidate = new Uint8Array(nv)
  for (let v = 0; v < nv; v++) candidate[v] = radialDot(v) < -0.3 ? 1 : 0
  const hit = Array.from({ length: nv }, (_, v) => inward(v))
  // inside a wall: the hit triangle belongs to the outside (it faces away from the axis)
  const inner = new Uint8Array(nv), shell = new Uint8Array(nv)
  for (let v = 0; v < nv; v++) {
    const h = hit[v]!
    if (h.t < 0) continue
    shell[v] = 1
    if (!candidate[v]) continue
    const a = I[3 * h.t]!, b = I[3 * h.t + 1]!, c = I[3 * h.t + 2]!
    const n = cross(sub(vx(b), vx(a)), sub(vx(c), vx(a)))
    const rx = (P[3 * a]! + P[3 * b]! + P[3 * c]!) / 3 - ax, ry = (P[3 * a + 1]! + P[3 * b + 1]! + P[3 * c + 1]!) / 3 - ay, rr = Math.hypot(rx, ry) || 1
    if ((n[0] * rx + n[1] * ry) / rr > 0.3 * len(n)) inner[v] = 1
  }
  const move = new Float64Array(nv * 3)
  let limited = 0, following = 0
  const own = (v: number) => {
    const n: V3 = [N[3 * v]!, N[3 * v + 1]!, N[3 * v + 2]!]
    let dirN = n
    const plane = base.onPlane[v] === 1
    if (plane) { const h = Math.hypot(n[0], n[1]); dirN = h > 0.1 ? [n[0] / h, n[1] / h, 0] : [0, 0, 0] }
    let a = p.jitter * (2 * U1[v]! - 1)
    if (a < 0) {
      // inwards: keep at least `wall` to the other side (half the room when the other side moves on its own; an inside that
      // follows or stays smooth does not)
      const h = hit[v]!
      const other = h.t >= 0 && (inner[I[3 * h.t]!] || inner[I[3 * h.t + 1]!] || inner[I[3 * h.t + 2]!]) ? 1 : 0.5
      const room = Number.isFinite(h.dist) ? Math.max(0, (h.dist - p.wall) * other) : Infinity
      if (-a > room) { a = -room; limited++ }
    }
    // sideways: a random direction in the tangent plane (in the face itself on a flat face)
    const ref: V3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
    const t1 = unit(cross(n, ref)), t2 = cross(n, t1)
    const ang = 2 * Math.PI * U2[v]!, s = (p.shift / 100) * L * U3[v]!
    let side: V3 = [Math.cos(ang) * t1[0] + Math.sin(ang) * t2[0], Math.cos(ang) * t1[1] + Math.sin(ang) * t2[1], Math.cos(ang) * t1[2] + Math.sin(ang) * t2[2]]
    if (plane) side = [side[0], side[1], 0]
    move[3 * v] = a * dirN[0] + s * side[0]; move[3 * v + 1] = a * dirN[1] + s * side[1]; move[3 * v + 2] = plane ? 0 : a * dirN[2] + s * side[2]
  }
  for (let v = 0; v < nv; v++) if (!base.locked[v] && !inner[v]) own(v)
  for (let v = 0; v < nv; v++) {
    if (base.locked[v] || !inner[v]) continue
    if (p.inside === 'smooth') continue
    // follow: the move of the outside where the ray across the wall comes out
    const h = hit[v]!, a = I[3 * h.t]!, b = I[3 * h.t + 1]!, c = I[3 * h.t + 2]!, wa = 1 - h.u - h.w
    for (let k = 0; k < 3; k++) move[3 * v + k] = wa * move[3 * a + k]! + h.u * move[3 * b + k]! + h.w * move[3 * c + k]!
    if (base.onPlane[v]) move[3 * v + 2] = 0
    following++
  }
  return { move, shell, inDir, wall: p.wall, innerFollowing: following, limitedInwards: limited }
}

/**
 * Place the moves at strength k, halving them where an edge would pass through a triangle or a triangle would turn over;
 * after 6 rounds the remaining places do not move at all. Returns the positions and how many vertices were held back.
 */
export function placeFacets(base: FacetBase, moves: FacetMoves, k: number, isCancelled: () => boolean = () => false) {
  const B = base.positions, I = base.indices, nv = B.length / 3, nt = I.length / 3
  const s = new Float64Array(nv).fill(k)
  const P = new Float64Array(B.length)
  const held = new Uint8Array(nv)
  const nb: number[][] = Array.from({ length: nv }, () => [])
  for (let t = 0; t < nt; t++) for (let e = 0; e < 3; e++) { const a = I[3 * t + e]!, b = I[3 * t + (e + 1) % 3]!; nb[a]!.push(b) }
  const BN = new Float64Array(nt * 3)
  const nrm = (Q: Float64Array, t: number): V3 => {
    const a = I[3 * t]!, b = I[3 * t + 1]!, c = I[3 * t + 2]!
    return cross([Q[3 * b]! - Q[3 * a]!, Q[3 * b + 1]! - Q[3 * a + 1]!, Q[3 * b + 2]! - Q[3 * a + 2]!], [Q[3 * c]! - Q[3 * a]!, Q[3 * c + 1]! - Q[3 * a + 1]!, Q[3 * c + 2]! - Q[3 * a + 2]!])
  }
  for (let t = 0; t < nt; t++) { const n = nrm(B, t); BN[3 * t] = n[0]; BN[3 * t + 1] = n[1]; BN[3 * t + 2] = n[2] }
  let active = new Uint8Array(nv)
  for (let v = 0; v < nv; v++) if (moves.move[3 * v] || moves.move[3 * v + 1] || moves.move[3 * v + 2]) active[v] = 1
  // walls: at a vertex with the other side of a wall near, at least `wall` must stay (where the model itself had that much)
  const W = moves.wall, D = moves.inDir
  const inDir = (v: number): V3 => [D[3 * v]!, D[3 * v + 1]!, D[3 * v + 2]!]
  const watch: number[] = [], watchT: number[] = []
  // ... and from the middle of each facet there, straight into it
  const centre = (Q: Float64Array, t: number): V3 => { const a = 3 * I[3 * t]!, b = 3 * I[3 * t + 1]!, c = 3 * I[3 * t + 2]!; return [(Q[a]! + Q[b]! + Q[c]!) / 3, (Q[a + 1]! + Q[b + 1]! + Q[c + 1]!) / 3, (Q[a + 2]! + Q[b + 2]! + Q[c + 2]!) / 3] }
  const own = (t: number) => (a: number, b: number, c: number) => a === I[3 * t] && b === I[3 * t + 1] && c === I[3 * t + 2]
  const into = (Q: Float64Array, t: number): V3 => { const n = unit(nrm(Q, t)); return [-n[0], -n[1], -n[2]] }
  if (W > 0) {
    const g0 = triangleGrid(B, I, Math.max(1, 2 * W))
    for (let v = 0; v < nv; v++) if (moves.shell[v] && rayFrom(B, I, g0, v, inDir(v), W).t < 0) watch.push(v)
    for (let t = 0; t < nt; t++) {
      const a = I[3 * t]!, b = I[3 * t + 1]!, c = I[3 * t + 2]!
      if ((moves.shell[a] || moves.shell[b] || moves.shell[c]) && rayAt(B, I, g0, centre(B, t), into(B, t), W, own(t)).t < 0) watchT.push(t)
    }
  }
  for (let r = 0; r < 40; r++) {
    if (isCancelled()) throw cancelled()
    for (let i = 0; i < B.length; i++) P[i] = B[i]! + moves.move[i]! * s[Math.floor(i / 3)]!
    const bad = new Set(crossingVertices(P, I, active))
    for (let t = 0; t < nt; t++) {
      const a = I[3 * t]!, b = I[3 * t + 1]!, c = I[3 * t + 2]!
      if (!active[a] && !active[b] && !active[c]) continue
      const n = nrm(P, t), n0: V3 = [BN[3 * t]!, BN[3 * t + 1]!, BN[3 * t + 2]!]
      if (dot(n, n0) < 0.3 * len(n) * len(n0)) { bad.add(a); bad.add(b); bad.add(c) }
    }
    if (watch.length || watchT.length) {
      const g = triangleGrid(P, I, Math.max(1, 2 * W))
      for (const v of watch) {
        const h = rayFrom(P, I, g, v, inDir(v), W - 1e-6)
        if (h.t >= 0) { bad.add(v); bad.add(I[3 * h.t]!); bad.add(I[3 * h.t + 1]!); bad.add(I[3 * h.t + 2]!) }
      }
      for (const t of watchT) {
        const h = rayAt(P, I, g, centre(P, t), into(P, t), W - 1e-6, own(t))
        if (h.t >= 0) for (const w of [I[3 * t]!, I[3 * t + 1]!, I[3 * t + 2]!, I[3 * h.t]!, I[3 * h.t + 1]!, I[3 * h.t + 2]!]) bad.add(w)
      }
    }
    if (bad.size === 0) break
    active = new Uint8Array(nv)
    for (const v of bad) for (const w of [v, ...nb[v]!]) {
      if (!s[w]) continue
      s[w] = r < 6 ? s[w]! * 0.5 : 0
      held[w] = 1; active[w] = 1
    }
  }
  for (let i = 0; i < B.length; i++) P[i] = B[i]! + moves.move[i]! * s[Math.floor(i / 3)]!
  let n = 0
  for (let v = 0; v < nv; v++) n += held[v]!
  return { positions: P, held: n }
}

/** Colours per facet: one (segments ready), alternating (two colours, neighbours differ where they can) or random from a palette. */
export function facetColours(base: FacetBase, input: Mesh, p: FacetParams, opt: FacetOptions = {}): { labels: Uint16Array; table: SegmentInfo[]; colours: number } {
  const I = base.indices, nt = I.length / 3
  const keep = new Set(opt.keepLabels ?? [])
  const inTable = input.segments?.table ?? [{ id: 0, name: 'body' }]
  const names = opt.segmentNames ?? ['facet_1', 'facet_2', 'facet_3', 'facet_4']
  const palette = [p.colour_1, p.colour_2, p.colour_3, p.colour_4].map(hex)
  if (p.facet_colours === 'one') {
    if (input.segments) return { labels: base.lab.slice(), table: inTable.map(s => ({ ...s })), colours: 1 }
    return { labels: new Uint16Array(nt).fill(1), table: [{ id: 0, name: 'body' }, { id: 1, name: names[0]!, color: palette[0]! }], colours: 1 }
  }
  const n = p.facet_colours === 'alternating' ? 2 : Math.max(2, Math.min(4, Math.round(p.palette_size)))
  // the kept segments keep their entries; the facet colours get new ids after them
  const kept = inTable.filter(s => keep.has(s.id))
  let next = Math.max(0, ...inTable.map(s => s.id)) + 1
  const ids: number[] = []
  const table: SegmentInfo[] = [{ id: 0, name: 'body' }, ...kept.map(s => ({ ...s }))]
  for (let c = 0; c < n; c++) { ids.push(next); table.push({ id: next, name: names[c]!, color: palette[c]! }); next++ }
  // neighbours across edges
  const edge = new Map<number, number>(), adj: number[][] = Array.from({ length: nt }, () => [])
  for (let t = 0; t < nt; t++) for (let e = 0; e < 3; e++) {
    const a = I[3 * t + e]!, b = I[3 * t + (e + 1) % 3]!, k = Math.min(a, b) * BIG + Math.max(a, b)
    const u = edge.get(k)
    if (u === undefined) edge.set(k, t); else { adj[t]!.push(u); adj[u]!.push(t) }
  }
  const col = new Int32Array(nt).fill(-1)
  const rand = rng(p.seed + 7919)
  const pick = (t: number) => {
    const used = new Array<number>(n).fill(0)
    for (const u of adj[t]!) if (col[u]! >= 0) used[col[u]!]!++
    if (p.facet_colours === 'alternating') return used[0]! <= used[1]! ? (used[0]! === used[1]! ? (t & 1) : 0) : 1
    // random, avoiding the colours of the neighbours when it can
    const free = used.map((u, c) => (u === 0 ? c : -1)).filter(c => c >= 0)
    const from = free.length ? free : Array.from({ length: n }, (_, c) => c)
    return from[Math.floor(rand() * from.length) % from.length]!
  }
  // breadth first from every uncoloured triangle, so neighbours are coloured one after another
  for (let s = 0; s < nt; s++) {
    if (col[s]! >= 0) continue
    const queue = [s]
    col[s] = pick(s)
    for (let q = 0; q < queue.length; q++) for (const u of adj[queue[q]!]!) if (col[u]! < 0) { col[u] = pick(u); queue.push(u) }
  }
  const labels = new Uint16Array(nt)
  for (let t = 0; t < nt; t++) labels[t] = keep.has(base.lab[t]!) ? base.lab[t]! : ids[col[t]!]!
  return { labels, table, colours: n }
}

function hex(s: string): string {
  const h = String(s).replace('#', '').toLowerCase()
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h.slice(0, 6)
  return /^[0-9a-f]{6}$/.test(full) ? '#' + full : '#cccccc'
}

/** The groups of the input, with the new triangle ranges (the base keeps each body in one range). */
export function facetGroups(base: FacetBase, input: Mesh): MeshGroup[] | undefined {
  if (!input.groups) return undefined
  const out: MeshGroup[] = []
  let t = 0
  const nt = base.grp.length
  input.groups.forEach((g, k) => {
    const start = t
    while (t < nt && base.grp[t] === k) t++
    out.push({ ...g, start, count: t - start })
  })
  return out
}

/** Steepest downward-facing slope (degrees from vertical) of the non-flat triangles, as the mesh lies. */
export function overhangOf(P: Float64Array, I: Uint32Array, skip?: Uint8Array): number {
  let worst = 0
  for (let t = 0; t < I.length; t += 3) {
    if (skip && skip[t / 3]) continue
    const a = 3 * I[t]!, b = 3 * I[t + 1]!, c = 3 * I[t + 2]!
    const n = cross([P[b]! - P[a]!, P[b + 1]! - P[a + 1]!, P[b + 2]! - P[a + 2]!], [P[c]! - P[a]!, P[c + 1]! - P[a + 1]!, P[c + 2]! - P[a + 2]!])
    const l = len(n)
    if (l === 0 || Math.abs(n[2]) > 0.99995 * l) continue                 // flat: the bed, a lid, a floor
    if (n[2] < 0) worst = Math.max(worst, (Math.asin(Math.min(1, -n[2] / l)) * 180) / Math.PI)
  }
  return worst
}

/** Edge lengths of the triangles that are not held back: the spread of the facet sizes. */
export function facetStats(base: FacetBase) {
  const P = base.positions, I = base.indices, ls: number[] = []
  for (let t = 0; t < I.length / 3; t++) {
    if (base.frz[t]) continue
    for (let e = 0; e < 3; e++) { const a = I[3 * t + e]!, b = I[3 * t + (e + 1) % 3]!; if (a < b) ls.push(Math.hypot(P[3 * a]! - P[3 * b]!, P[3 * a + 1]! - P[3 * b + 1]!, P[3 * a + 2]! - P[3 * b + 2]!)) }
  }
  ls.sort((x, y) => x - y)
  const q = (f: number) => ls.length ? ls[Math.min(ls.length - 1, Math.floor(f * ls.length))]! : 0
  return { median: q(0.5), p10: q(0.1), p90: q(0.9) }
}

/** The Facets step: remesh, move, check, colour. */
export function facets(input: Mesh, p: FacetParams, opt: FacetOptions = {}) {
  const isCancelled = opt.isCancelled ?? (() => false)
  const progress = opt.progress ?? (() => {})
  const base = facetBase(input, p, opt)
  progress('facets', 0)
  const moves = facetMoves(base, p)
  progress('facets', 1)
  progress('check', 0)
  const placed = placeFacets(base, moves, 1, isCancelled)
  progress('check', 1)
  const colours = facetColours(base, input, p, opt)
  const mesh: Mesh = { positions: placed.positions, indices: base.indices, segments: { labels: colours.labels, table: colours.table } }
  const groups = facetGroups(base, input)
  if (groups) mesh.groups = groups
  const st = facetStats(base)
  return {
    mesh,
    warnings: [] as StructuredError[],
    report: {
      triangles_in: input.indices.length / 3, triangles: base.indices.length / 3,
      facet_size_mm: round(base.facetSize, 2), facet_size_asked_mm: base.facetAsked, facet_size_reduced: base.facetSize < base.facetAsked, parts_with_smaller_facets: base.partsReduced,
      edge_median_mm: round(st.median, 1), edge_p10_mm: round(st.p10, 1), edge_p90_mm: round(st.p90, 1),
      jitter_mm: p.jitter, shift_pct: p.shift, seed: p.seed, inside: p.inside, inner_vertices_following: p.inside === 'follow' ? moves.innerFollowing : 0,
      vertices_limited_by_wall: moves.limitedInwards, vertices_held: placed.held, plain_triangles: countOnes(base.plain),
      surface_crossings: base.crossingsLeft, colours: colours.colours, overhang_max_deg: round(overhangOf(placed.positions, base.indices), 0),
    },
  }
}

const countOnes = (a: Uint8Array) => { let n = 0; for (const x of a) n += x; return n }
