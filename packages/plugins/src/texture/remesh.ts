// Triangle quality after the cut of the texture operation. The cut leaves slivers where the base mesh was coarse or uneven (a plate of 12 triangles, the
// fan of a cylinder). Two cheap passes make the triangles of a flat patch round again without changing the surface at all:
//  1. Edge flips. An edge between two triangles that lie in the same plane is flipped when the two angles opposite to it add up to more than 180 degrees
//     (the Delaunay rule), which always makes the smallest angle larger.
//  2. Relaxation. A vertex whose whole star lies in one plane moves to the centre of its neighbours (which are in that plane too), a few small steps at a
//     time; a step that would turn a triangle over is undone.
// Only vertices and edges inside a planar patch are touched: creases, the border of the region, the border between two segments or two bodies stay exactly
// where they are, so the shape, the groups and the segment labels do not change. Everything is typed arrays and deterministic.
import { MeshError } from '@ateliermesh/core'

export interface RemeshInput {
  /** Vertex positions (x, y, z per vertex); the free vertices are moved in place. */
  P: Float64Array
  /** Triangles (three vertex indices each); flipped in place, a flip rewrites the two triangles in their own slots. */
  T: Uint32Array
  /** 1 for a triangle that is part of the textured region. */
  reg: Uint8Array
  /** A number per triangle that must be equal on both sides of a flipped edge (segment label combined with the body). */
  tag: Int32Array
  signal?: AbortSignal
}

export interface RemeshStats { flips: number; moved: number; minAngleBefore: number; minAngleAfter: number }

const COPLANAR_COS = Math.cos((1.5 * Math.PI) / 180)

function cancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new MeshError('run.cancelled') }

/** The smallest angle of a triangle, in degrees. */
function minAngle(P: Float64Array, a: number, b: number, c: number): number {
  const ax = P[3 * a]!, ay = P[3 * a + 1]!, az = P[3 * a + 2]!, bx = P[3 * b]!, by = P[3 * b + 1]!, bz = P[3 * b + 2]!, cx = P[3 * c]!, cy = P[3 * c + 1]!, cz = P[3 * c + 2]!
  const ab = Math.hypot(bx - ax, by - ay, bz - az), bc = Math.hypot(cx - bx, cy - by, cz - bz), ca = Math.hypot(ax - cx, ay - cy, az - cz)
  if (ab === 0 || bc === 0 || ca === 0) return 0
  const cosA = ((bx - ax) * (cx - ax) + (by - ay) * (cy - ay) + (bz - az) * (cz - az)) / (ab * ca)
  const cosB = ((ax - bx) * (cx - bx) + (ay - by) * (cy - by) + (az - bz) * (cz - bz)) / (ab * bc)
  const cosC = ((ax - cx) * (bx - cx) + (ay - cy) * (by - cy) + (az - cz) * (bz - cz)) / (ca * bc)
  return (Math.acos(Math.max(-1, Math.min(1, Math.max(cosA, cosB, cosC)))) * 180) / Math.PI   // the smallest angle has the largest cosine
}

/** The mean of the smallest angles of the triangles of the region (a quality number: 60 is perfect, near 0 is slivers). */
export function meanMinAngle(P: Float64Array, T: Uint32Array, reg?: Uint8Array): number {
  let sum = 0, n = 0
  for (let t = 0; t < T.length / 3; t++) { if (reg && !reg[t]) continue; sum += minAngle(P, T[3 * t]!, T[3 * t + 1]!, T[3 * t + 2]!); n++ }
  return n ? sum / n : 0
}

/** Which triangle is on the other side of each edge: `adj[3 t + k]` for the edge from corner k to corner k + 1, or -1. */
export function adjacency(T: Uint32Array, nv: number): Int32Array {
  const nt = T.length / 3
  const adj = new Int32Array(3 * nt).fill(-1)
  let size = 1; while (size < 6 * nt + 8) size <<= 1
  const keys = new Float64Array(size).fill(-1), vals = new Int32Array(size)   // vals: 3 t + k of the first side
  const mask = size - 1
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const a = T[3 * t + k]!, b = T[3 * t + (k + 1) % 3]!
      const key = a < b ? a * nv + b : b * nv + a
      let h = (Math.imul(key % 2147483647 | 0, 0x9e3779b1) >>> 7) & mask
      for (;;) {
        const kk = keys[h]!
        if (kk === -1) { keys[h] = key; vals[h] = 3 * t + k; break }
        if (kk === key) { const o = vals[h]!; adj[3 * t + k] = (o / 3) | 0; adj[o] = t; break }
        h = (h + 1) & mask
      }
    }
  }
  return adj
}

export function improveTriangles(o: RemeshInput): RemeshStats {
  const { P, T, reg, tag, signal } = o
  const nt = T.length / 3, nv = P.length / 3
  // already round (a fine, even grid): nothing to gain, so do not spend the time
  let sum0 = 0, n0 = 0, poor = 0
  for (let t = 0; t < nt; t++) { if (!reg[t]) continue; const m = minAngle(P, T[3 * t]!, T[3 * t + 1]!, T[3 * t + 2]!); sum0 += m; n0++; if (m < 30) poor++ }
  const before = n0 ? sum0 / n0 : 0
  if (n0 === 0 || poor / n0 < 0.01) return { flips: 0, moved: 0, minAngleBefore: before, minAngleAfter: before }

  // face normals, and which vertices have a flat star (all their triangles in the region, one tag, one plane)
  const fn = new Float64Array(3 * nt)
  const faceNormal = (t: number): void => {
    const a = T[3 * t]! * 3, b = T[3 * t + 1]! * 3, c = T[3 * t + 2]! * 3
    const ux = P[b]! - P[a]!, uy = P[b + 1]! - P[a + 1]!, uz = P[b + 2]! - P[a + 2]!, vx = P[c]! - P[a]!, vy = P[c + 1]! - P[a + 1]!, vz = P[c + 2]! - P[a + 2]!
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz) || 1
    fn[3 * t] = nx / l; fn[3 * t + 1] = ny / l; fn[3 * t + 2] = nz / l
  }
  for (let t = 0; t < nt; t++) faceNormal(t)
  const flat = new Uint8Array(nv).fill(1)
  const first = new Int32Array(nv).fill(-1)
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const v = T[3 * t + k]!
      if (!reg[t]) { flat[v] = 0; continue }
      const f = first[v]!
      if (f === -1) { first[v] = t; continue }
      if (tag[f] !== tag[t] || fn[3 * f]! * fn[3 * t]! + fn[3 * f + 1]! * fn[3 * t + 1]! + fn[3 * f + 2]! * fn[3 * t + 2]! < COPLANAR_COS) flat[v] = 0
    }
  }
  // an open edge (no triangle on the other side) pins both of its vertices
  const adj = adjacency(T, nv)
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) if (adj[3 * t + k] === -1) { flat[T[3 * t + k]!] = 0; flat[T[3 * t + (k + 1) % 3]!] = 0 }

  let flips = 0, moved = 0
  const flipSweep = (): number => {
    let n = 0
    const touched = new Uint8Array(nt)
    for (let t = 0; t < nt; t++) {
      if ((t & 0x3ffff) === 0) cancelled(signal)
      if (!reg[t] || touched[t]) continue
      for (let k = 0; k < 3; k++) {
        const u = adj[3 * t + k]!
        if (u < 0 || touched[u] || !reg[u] || tag[u] !== tag[t]) continue
        if (fn[3 * t]! * fn[3 * u]! + fn[3 * t + 1]! * fn[3 * u + 1]! + fn[3 * t + 2]! * fn[3 * u + 2]! < COPLANAR_COS) continue
        // t = (a, b, c) with the shared edge a-b at corner k; u holds the same edge as b-a and its third vertex is d
        const a = T[3 * t + k]!, b = T[3 * t + (k + 1) % 3]!, c = T[3 * t + (k + 2) % 3]!
        // only an edge opposite an obtuse corner of this triangle can need a flip (the other side is checked when its own triangle is visited)
        if ((P[3 * a]! - P[3 * c]!) * (P[3 * b]! - P[3 * c]!) + (P[3 * a + 1]! - P[3 * c + 1]!) * (P[3 * b + 1]! - P[3 * c + 1]!) + (P[3 * a + 2]! - P[3 * c + 2]!) * (P[3 * b + 2]! - P[3 * c + 2]!) >= 0) continue
        let m = 0; while (m < 3 && !(T[3 * u + m] === b && T[3 * u + (m + 1) % 3] === a)) m++
        if (m === 3) continue
        const d = T[3 * u + (m + 2) % 3]!
        if (c === d) continue
        // the angles at c and d opposite the edge: flip when they add up to more than 180 degrees (cot c + cot d < 0)
        const cot = (v: number, p: number, q: number): number => {
          const ax = P[3 * p]! - P[3 * v]!, ay = P[3 * p + 1]! - P[3 * v + 1]!, az = P[3 * p + 2]! - P[3 * v + 2]!, bx = P[3 * q]! - P[3 * v]!, by = P[3 * q + 1]! - P[3 * v + 1]!, bz = P[3 * q + 2]! - P[3 * v + 2]!
          const cr = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx)
          return (ax * bx + ay * by + az * bz) / (cr || 1e-300)
        }
        if (cot(c, a, b) + cot(d, a, b) >= -1e-9) continue
        // the quad must be convex: both new triangles keep the orientation of the old ones
        const nx = fn[3 * t]!, ny = fn[3 * t + 1]!, nz = fn[3 * t + 2]!
        const orient = (p: number, q: number, r: number): number => {
          const ux = P[3 * q]! - P[3 * p]!, uy = P[3 * q + 1]! - P[3 * p + 1]!, uz = P[3 * q + 2]! - P[3 * p + 2]!, vx = P[3 * r]! - P[3 * p]!, vy = P[3 * r + 1]! - P[3 * p + 1]!, vz = P[3 * r + 2]! - P[3 * p + 2]!
          return (uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz
        }
        if (orient(a, d, c) <= 1e-12 || orient(d, b, c) <= 1e-12) continue
        // the edge c-d must not exist yet (it would become a double edge)
        let dup = false
        for (let j = 0; j < 3; j++) { const w = adj[3 * t + j]!; if (w >= 0 && w !== u) for (let q = 0; q < 3; q++) if (T[3 * w + q] === d && (T[3 * w + (q + 1) % 3] === c || T[3 * w + (q + 2) % 3] === c)) dup = true }
        if (dup) continue
        // the neighbours around the quad
        const nBC = adj[3 * t + (k + 1) % 3]!, nCA = adj[3 * t + (k + 2) % 3]!
        const nAD = adj[3 * u + (m + 1) % 3]!, nDB = adj[3 * u + (m + 2) % 3]!
        // t becomes (a, d, c) and u becomes (d, b, c)
        T[3 * t] = a; T[3 * t + 1] = d; T[3 * t + 2] = c
        T[3 * u] = d; T[3 * u + 1] = b; T[3 * u + 2] = c
        adj[3 * t] = nAD; adj[3 * t + 1] = u; adj[3 * t + 2] = nCA
        adj[3 * u] = nDB; adj[3 * u + 1] = nBC; adj[3 * u + 2] = t
        const relink = (w: number, from: number, to: number): void => { if (w < 0) return; for (let j = 0; j < 3; j++) if (adj[3 * w + j] === from) { adj[3 * w + j] = to; return } }
        relink(nAD, u, t); relink(nBC, t, u)
        faceNormal(t); faceNormal(u)
        touched[t] = 1; touched[u] = 1
        n++
        break
      }
    }
    return n
  }

  // the star of every flat vertex, for the relaxation
  const relax = (steps: number): void => {
    const cnt = new Int32Array(nv + 1)
    for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) cnt[T[3 * t + k]! + 1]!++
    for (let v = 0; v < nv; v++) cnt[v + 1]! += cnt[v]!
    const star = new Int32Array(cnt[nv]!), cur = Int32Array.from(cnt.subarray(0, nv))
    for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) star[cur[T[3 * t + k]!]!++] = t
    const nx = new Float64Array(3)
    for (let s = 0; s < steps; s++) {
      cancelled(signal)
      for (let v = 0; v < nv; v++) {
        if (!flat[v]) continue
        const s0 = cnt[v]!, s1 = cnt[v + 1]!
        if (s1 - s0 < 3) continue
        let cx = 0, cy = 0, cz = 0, n = 0
        for (let i = s0; i < s1; i++) {
          const t = star[i]!
          for (let k = 0; k < 3; k++) { const w = T[3 * t + k]!; if (w === v) continue; cx += P[3 * w]!; cy += P[3 * w + 1]!; cz += P[3 * w + 2]!; n++ }
        }
        const x = P[3 * v]!, y = P[3 * v + 1]!, z = P[3 * v + 2]!
        nx[0] = x + 0.5 * (cx / n - x); nx[1] = y + 0.5 * (cy / n - y); nx[2] = z + 0.5 * (cz / n - z)
        // keep it in the plane of its star (the neighbours are in it, but rounding drifts)
        const fx = fn[3 * star[s0]!]!, fy = fn[3 * star[s0]! + 1]!, fz = fn[3 * star[s0]! + 2]!
        const dd = (nx[0]! - x) * fx + (nx[1]! - y) * fy + (nx[2]! - z) * fz
        nx[0] = nx[0]! - dd * fx; nx[1] = nx[1]! - dd * fy; nx[2] = nx[2]! - dd * fz
        // undo the move when it would turn or crush a triangle of the star
        P[3 * v] = nx[0]!; P[3 * v + 1] = nx[1]!; P[3 * v + 2] = nx[2]!
        let ok = true
        for (let i = s0; i < s1 && ok; i++) {
          const t = star[i]!
          const a = T[3 * t]! * 3, b = T[3 * t + 1]! * 3, c = T[3 * t + 2]! * 3
          const ux = P[b]! - P[a]!, uy = P[b + 1]! - P[a + 1]!, uz = P[b + 2]! - P[a + 2]!, vx = P[c]! - P[a]!, vy = P[c + 1]! - P[a + 1]!, vz = P[c + 2]! - P[a + 2]!
          const dot = (uy * vz - uz * vy) * fn[3 * t]! + (uz * vx - ux * vz) * fn[3 * t + 1]! + (ux * vy - uy * vx) * fn[3 * t + 2]!
          if (dot <= 1e-9) ok = false
        }
        if (!ok) { P[3 * v] = x; P[3 * v + 1] = y; P[3 * v + 2] = z } else moved++
      }
    }
  }

  for (let round = 0; round < 3; round++) {
    let f = 0
    for (let sweep = 0; sweep < 8; sweep++) { const n = flipSweep(); f += n; if (n === 0) break }
    flips += f
    if (round === 2) break
    relax(3)
  }
  return { flips, moved, minAngleBefore: before, minAngleAfter: meanMinAngle(P, T, reg) }
}
