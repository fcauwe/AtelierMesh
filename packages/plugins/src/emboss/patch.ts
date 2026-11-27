// The patch: the part of the surface around the anchor that the text is mapped onto, grown by triangle adjacency.
import type { Mesh } from '@ateliermesh/core'
import { closestOnTri, faceNormal, pointOf } from './adjacency'
import type { Adjacency } from './adjacency'
import { vcross, vdot, vlen, vscale, vsub } from './vec'
import type { V3 } from './vec'

export interface Patch {
  nv: number
  nt: number
  /** Patch vertex positions (3 per vertex) and triangles (indices into the patch vertices). */
  P: Float64Array
  T: Uint32Array
  /** Patch vertex -> mesh vertex, patch triangle -> mesh triangle. */
  gverts: number[]
  gtris: number[]
  boundaryVerts: Uint8Array
  anchorLocalTri: number
  topology: { euler: number; boundaryEdges: number; loops: number; nonManifold: number; pinchedBoundary: number; disk: boolean }
  /** Per triangle flat frame: x0=(0,0), x1=(a,0), x2=(b,c). 6 numbers per triangle. */
  X: Float64Array
  area: Float64Array
  stoppedAtCrease: number
}

export interface PatchOptions {
  /** Largest angle between a triangle's normal and the anchor's normal, degrees. */
  maxNormalDeg: number
  /** Growth stops at an edge sharper than this, degrees. */
  creaseDeg: number
}

/**
 * Grow from the anchor triangle: a neighbour joins when `accept` says so, it faces roughly the way the anchor does, and the edge to it
 * is not a sharp crease.
 */
export function extractPatch(m: Mesh, adj: Adjacency, anchorTri: number, accept: (tri: number) => boolean, opts: PatchOptions): Patch {
  const na = faceNormal(m, anchorTri)
  const cosN = Math.cos((opts.maxNormalDeg * Math.PI) / 180), cosC = Math.cos((opts.creaseDeg * Math.PI) / 180)
  const cache = new Map<number, V3>()
  const fn = (t: number): V3 => { let n = cache.get(t); if (!n) { n = faceNormal(m, t); cache.set(t, n) } return n }
  // a triangle whose normal points the other way from two or more of its neighbours is turned over (real models have a few, and reduced
  // meshes more): its normal says nothing about the surface, so it is let through without the angle tests and the next triangle is
  // compared with the last trustworthy normal instead
  const turnedOver = (t: number): boolean => { let opp = 0; for (let e = 0; e < 3; e++) { const w = adj.adj[3 * t + e] as number; if (w >= 0 && vdot(fn(w), fn(t)) < -0.3) opp++ } return opp >= 2 }
  const flipMemo = new Map<number, boolean>()
  const isTurned = (t: number): boolean => { let s = flipMemo.get(t); if (s === undefined) { s = turnedOver(t); flipMemo.set(t, s) } return s }
  const ref = new Map<number, V3>([[anchorTri, na]])
  const seen = new Set<number>([anchorTri])
  const q: number[] = [anchorTri], tris: number[] = []
  let stoppedAtCrease = 0
  while (q.length > 0) {
    const t = q.pop() as number
    tris.push(t)
    for (let e = 0; e < 3; e++) {
      const n = adj.adj[3 * t + e] as number
      if (n < 0 || seen.has(n)) continue
      if (!accept(n)) continue
      const rt = ref.get(t) as V3
      if (isTurned(n)) { ref.set(n, rt); seen.add(n); q.push(n); continue }
      if (vdot(fn(n), na) < cosN) continue
      if (vdot(fn(n), rt) < cosC) { stoppedAtCrease++; continue }
      ref.set(n, fn(n)); seen.add(n); q.push(n)
    }
  }
  fillSmallGaps(adj, seen, tris)
  const p = buildPatch(m, tris, anchorTri)
  p.stoppedAtCrease = stoppedAtCrease
  return p
}

/**
 * A few odd triangles inside a smooth area (slivers left by a reduced mesh, whose normal points elsewhere) fail the crease test and leave
 * small gaps in the patch. A gap that is closed on all sides by the patch and holds only a handful of triangles is added to it, so the
 * patch is still one piece of surface without holes. A real hole in the part is much bigger and is left alone.
 */
const GAP_MAX_TRIANGLES = 24
function fillSmallGaps(adj: Adjacency, inPatch: Set<number>, tris: number[]): void {
  const checked = new Set<number>()
  for (const t of [...tris]) {
    for (let e = 0; e < 3; e++) {
      const n = adj.adj[3 * t + e] as number
      if (n < 0 || inPatch.has(n) || checked.has(n)) continue
      const comp: number[] = [n], mark = new Set<number>([n])
      let open = false
      for (let i = 0; i < comp.length; i++) {
        const c = comp[i] as number
        for (let k = 0; k < 3; k++) {
          const w = adj.adj[3 * c + k] as number
          if (w < 0) { open = true; continue }
          if (inPatch.has(w) || mark.has(w)) continue
          mark.add(w); comp.push(w)
          if (comp.length > GAP_MAX_TRIANGLES) { open = true; break }
        }
        if (open) break
      }
      for (const c of mark) checked.add(c)
      if (!open) for (const c of comp) { inPatch.add(c); tris.push(c) }
    }
  }
}

export function buildPatch(m: Mesh, tris: number[], anchorTri: number): Patch {
  const vmap = new Map<number, number>(), gverts: number[] = []
  const lt = new Uint32Array(3 * tris.length)
  tris.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const g = m.indices[3 * t + k] as number
      let l = vmap.get(g)
      if (l === undefined) { l = gverts.length; vmap.set(g, l); gverts.push(g) }
      lt[3 * i + k] = l
    }
  })
  const nv = gverts.length, nt = tris.length
  const P = new Float64Array(3 * nv)
  gverts.forEach((g, i) => { P[3 * i] = m.positions[3 * g] as number; P[3 * i + 1] = m.positions[3 * g + 1] as number; P[3 * i + 2] = m.positions[3 * g + 2] as number })
  const edgeCount = new Map<number, number>()
  const keyOf = (a: number, b: number): number => (a < b ? a * nv + b : b * nv + a)
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) { const key = keyOf(lt[3 * t + k] as number, lt[3 * t + ((k + 1) % 3)] as number); edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1) }
  let boundary = 0, nonManifold = 0
  for (const c of edgeCount.values()) { if (c === 1) boundary++; else if (c > 2) nonManifold++ }
  const next = new Map<number, number>()
  let multi = 0
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
    const a = lt[3 * t + k] as number, b = lt[3 * t + ((k + 1) % 3)] as number
    if (edgeCount.get(keyOf(a, b)) === 1) { if (next.has(a)) multi++; next.set(a, b) }
  }
  let loops = 0
  const vis = new Set<number>()
  for (const s of next.keys()) { if (vis.has(s)) continue; loops++; let c = s; while (!vis.has(c) && next.has(c)) { vis.add(c); c = next.get(c) as number } }
  const euler = nv - edgeCount.size + nt
  const boundaryVerts = new Uint8Array(nv)
  for (const s of next.keys()) boundaryVerts[s] = 1
  const X = new Float64Array(6 * nt), area = new Float64Array(nt)
  for (let t = 0; t < nt; t++) {
    const p0 = pointOf(P, lt[3 * t] as number), p1 = pointOf(P, lt[3 * t + 1] as number), p2 = pointOf(P, lt[3 * t + 2] as number)
    const e1 = vsub(p1, p0), e2 = vsub(p2, p0), a = vlen(e1), ex = vscale(e1, 1 / a)
    X[6 * t + 2] = a; X[6 * t + 4] = vdot(e2, ex); X[6 * t + 5] = vlen(vcross(ex, e2)); area[t] = 0.5 * a * (X[6 * t + 5] as number)
  }
  return { nv, nt, P, T: lt, gverts, gtris: tris, boundaryVerts, anchorLocalTri: tris.indexOf(anchorTri), X, area, stoppedAtCrease: 0,
    topology: { euler, boundaryEdges: boundary, loops, nonManifold, pinchedBoundary: multi, disk: euler === 1 && loops === 1 && nonManifold === 0 && multi === 0 } }
}

export { closestOnTri }
