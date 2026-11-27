// Smoothing: Taubin lambda|mu relaxation of the vertices, with the triangles left exactly as they are (only positions move), so groups, segments and the
// triangle count are untouched and a closed solid stays a closed solid.
//
// One iteration is two passes over the vertices, with uniform (umbrella) weights:
//     x  <-  x + lambda * w * (mean of the neighbours - x)      lambda > 0   shrinks the details and the whole shape a little
//     x  <-  x + mu     * w * (mean of the neighbours - x)      mu < 0       gives the shape back, but not the details
// mu follows from lambda so that the pass band of the pair is 0.1: 1/lambda + 1/mu = 0.1. The pair is a low-pass filter that smooths the surface
// without shrinking it (a plain Laplacian pass, `keep_volume` off, shrinks every closed shape towards its centre). Both passes read the old
// positions and write new ones (Jacobi), so the result does not depend on the order of the vertices.
//
// Weights are uniform: each neighbour counts the same. That is the cheapest filter and is good on the near-regular triangles that marching
// cubes, remeshing and the plugins of this package make; on a very uneven triangulation (long thin triangles next to small ones) it also moves
// vertices along the surface, a known limit of the umbrella operator.
//
// Edges. An edge where the surface turns by more than `keepEdges` degrees (the angle between the two face normals) is a crease:
//   - a vertex with exactly two crease edges lies on a crease line and is smoothed along that line only (the mean of its two crease neighbours),
//     so a straight edge stays straight and a rough one becomes smooth, but it never rounds off;
//   - a vertex with one, or three or more crease edges (the end of a line, a corner) does not move.
//   An edge of more than two triangles counts as a crease. Border edges of an open mesh keep their vertices fixed (`keepBorders`), or are smoothed
//   along the border like a crease line.
//   `keepEdges` runs from 0 (every edge that is not flat is a crease, so almost nothing moves) to 180 (nothing is a crease: everything is smoothed).
//
// A part. With a triangle mask only the vertices of those triangles move. With `falloff` > 0 the vertices on the border of the part stay put and the
// weight grows smoothly (smoothstep of the distance along the surface) to 1 at `falloff` mm inside, so the smooth part blends into the rest.
// Vertices that no masked triangle touches are never written, so they stay bit for bit what they were.
//
// Vertices that lie at the same place (a mesh with split vertices at a seam) are treated as one and move together.
import { MeshError } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'

export interface SmoothOptions {
  iterations: number
  /** 0 to 1: how far lambda goes towards its largest stable value (see `taubinFactors`). 0 changes nothing. */
  strength: number
  /** Edges where the surface turns by more than this many degrees keep their shape. */
  keepEdges: number
  keepBorders: boolean
  /** True: Taubin (lambda then mu, no shrinking). False: plain Laplacian (lambda only). */
  keepVolume: boolean
  /** The most a vertex may end up from where it started, mm. 0 means no limit. */
  maxMove: number
  /** One byte per triangle, non-zero where the surface may be smoothed; null is the whole mesh. */
  region: Uint8Array | null
  /** mm over which the smoothing fades in from the border of the region. */
  falloff: number
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
}

export interface SmoothResult {
  mesh: Mesh
  /** Nothing was changed (strength 0, or nothing could move): the same mesh comes back. */
  identity: boolean
  iterations: number
  lambda: number
  mu: number
  maxDisplacement: number
  meanDisplacement: number
  /** Vertices that were allowed to move. */
  movable: number
  /** Vertices held in place: corners, ends of creases and fixed borders. */
  fixed: number
  creaseEdges: number
  /** Vertices held back by `maxMove` at the end. */
  capped: number
  ms: number
}

const PASS_BAND = 0.1
const LAMBDA_MAX = 0.6307

const cancelled = (o: { signal?: AbortSignal | undefined }): void => { if (o.signal?.aborted) throw new MeshError('run.cancelled') }
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())
const nextPow2 = (n: number): number => { let p = 1024; while (p < n) p <<= 1; return p }

/**
 * lambda and mu of one iteration for a strength between 0 and 1. mu is negative, and 0 when keepVolume is off.
 * With uniform weights the eigenvalues k of the operator lie in [0, 2], and one iteration multiplies a component by (1 - lambda k)(1 - mu k). That stays
 * within +-1 for every k up to 2 only while lambda is at most about 0.63 (Taubin's own choice: lambda 0.6307, mu -0.6732 for a pass band of 0.1), so a strength
 * of 1 means exactly that pair and smaller strengths scale lambda down. Plain smoothing (no mu) is stable for lambda up to 1; it stops at 0.9.
 */
export function taubinFactors(strength: number, keepVolume: boolean): { lambda: number; mu: number } {
  const s = Math.min(Math.max(strength, 0), 1)
  if (s === 0) return { lambda: 0, mu: 0 }
  if (!keepVolume) return { lambda: Math.min(s, 0.9), mu: 0 }
  const lambda = s * LAMBDA_MAX
  return { lambda, mu: 1 / (PASS_BAND - 1 / lambda) }
}

export function smoothMesh(mesh: Mesh, o: SmoothOptions): SmoothResult {
  const t0 = now()
  const nv = mesh.positions.length / 3, nt = mesh.indices.length / 3
  if (nv === 0 || nt === 0) throw new MeshError('smooth.bad_input', { reason: 'empty' })
  const { lambda, mu } = taubinFactors(o.strength, o.keepVolume)
  const untouched = (): SmoothResult => ({ mesh, identity: true, iterations: 0, lambda, mu, maxDisplacement: 0, meanDisplacement: 0, movable: 0, fixed: 0, creaseEdges: 0, capped: 0, ms: now() - t0 })
  if (lambda === 0 || o.iterations < 1) return untouched()

  // ---- vertices at the same place are one
  const X = new Float64Array(nv * 3)
  for (let i = 0; i < nv * 3; i++) X[i] = (mesh.positions[i] as number) + 0   // + 0 turns -0 into 0: the same place has one key
  const u32 = new Uint32Array(X.buffer, X.byteOffset, X.length * 2)
  const cap = nextPow2(nv * 2)
  const slot = new Int32Array(cap).fill(-1)
  const rep = new Int32Array(nv)
  for (let v = 0; v < nv; v++) {
    const k = 6 * v
    let h = Math.imul(u32[k] as number, 0x9e3779b1) ^ Math.imul(u32[k + 1] as number, 0x85ebca6b) ^ Math.imul(u32[k + 2] as number, 0xc2b2ae35) ^ Math.imul(u32[k + 3] as number, 0x27d4eb2f) ^ Math.imul(u32[k + 4] as number, 0x165667b1) ^ Math.imul(u32[k + 5] as number, 0x9e3779b9)
    h = (h ^ (h >>> 15)) & (cap - 1)
    for (;;) {
      const s = slot[h] as number
      if (s < 0) { slot[h] = v; rep[v] = v; break }
      if (X[3 * s] === X[3 * v] && X[3 * s + 1] === X[3 * v + 1] && X[3 * s + 2] === X[3 * v + 2]) { rep[v] = s; break }
      h = (h + 1) & (cap - 1)
    }
    if ((v & 0xffff) === 0) cancelled(o)
  }
  const idx = mesh.indices

  // ---- the edges of the surface, each once, with the one or two triangles on it
  let ecap = nextPow2(Math.ceil(nt * 2.2) + 16)
  let ea = new Int32Array(ecap).fill(-1), eb = new Int32Array(ecap), et0 = new Int32Array(ecap), et1 = new Int32Array(ecap).fill(-1), ec = new Uint8Array(ecap)
  let ecount = 0
  const grow = (): void => {
    const oa = ea, ob = eb, o0 = et0, o1 = et1, oc = ec, ocap = ecap
    ecap *= 2
    ea = new Int32Array(ecap).fill(-1); eb = new Int32Array(ecap); et0 = new Int32Array(ecap); et1 = new Int32Array(ecap).fill(-1); ec = new Uint8Array(ecap)
    for (let s = 0; s < ocap; s++) {
      if ((oa[s] as number) < 0) continue
      let h = edgeHash(oa[s] as number, ob[s] as number) & (ecap - 1)
      while ((ea[h] as number) >= 0) h = (h + 1) & (ecap - 1)
      ea[h] = oa[s] as number; eb[h] = ob[s] as number; et0[h] = o0[s] as number; et1[h] = o1[s] as number; ec[h] = oc[s] as number
    }
  }
  const edgeHash = (a: number, b: number): number => { let h = Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca6b); h ^= h >>> 15; return h >>> 0 }
  const addEdge = (a: number, b: number, tri: number): void => {
    if (a === b) return
    if (a > b) { const t = a; a = b; b = t }
    if (ecount * 10 > ecap * 7) grow()
    let h = edgeHash(a, b) & (ecap - 1)
    for (;;) {
      const s = ea[h] as number
      if (s < 0) { ea[h] = a; eb[h] = b; et0[h] = tri; ec[h] = 1; ecount++; return }
      if (s === a && eb[h] === b) { if (ec[h] === 1) et1[h] = tri; if ((ec[h] as number) < 255) ec[h] = (ec[h] as number) + 1; return }
      h = (h + 1) & (ecap - 1)
    }
  }
  for (let t = 0; t < nt; t++) {
    const a = rep[idx[3 * t] as number] as number, b = rep[idx[3 * t + 1] as number] as number, c = rep[idx[3 * t + 2] as number] as number
    addEdge(a, b, t); addEdge(b, c, t); addEdge(c, a, t)
    if ((t & 0xffff) === 0) cancelled(o)
  }

  // ---- face normals (only for the creases)
  const normal = new Float32Array(nt * 3)
  for (let t = 0; t < nt; t++) {
    const a = 3 * (rep[idx[3 * t] as number] as number), b = 3 * (rep[idx[3 * t + 1] as number] as number), c = 3 * (rep[idx[3 * t + 2] as number] as number)
    const ux = (X[b] as number) - (X[a] as number), uy = (X[b + 1] as number) - (X[a + 1] as number), uz = (X[b + 2] as number) - (X[a + 2] as number)
    const vx = (X[c] as number) - (X[a] as number), vy = (X[c + 1] as number) - (X[a + 1] as number), vz = (X[c + 2] as number) - (X[a + 2] as number)
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz)
    if (l > 0) { normal[3 * t] = nx / l; normal[3 * t + 1] = ny / l; normal[3 * t + 2] = nz / l }
  }

  // ---- crease edges, fixed borders, and the lists of neighbours
  const cosLimit = Math.cos((Math.min(Math.max(o.keepEdges, 0), 180) * Math.PI) / 180)
  const deg = new Int32Array(nv)
  const creaseCount = new Uint8Array(nv)
  const crease1 = new Int32Array(nv).fill(-1), crease2 = new Int32Array(nv).fill(-1)
  const pinned = new Uint8Array(nv)
  let creaseEdges = 0
  for (let s = 0; s < ecap; s++) {
    const a = ea[s] as number
    if (a < 0) continue
    const b = eb[s] as number
    deg[a]++; deg[b]++
    const n = ec[s] as number
    let crease = false
    if (n === 1) { if (o.keepBorders) { pinned[a] = 1; pinned[b] = 1 } else crease = true }
    else if (n > 2) crease = true
    else {
      const p = 3 * (et0[s] as number), q = 3 * (et1[s] as number)
      const dot = (normal[p] as number) * (normal[q] as number) + (normal[p + 1] as number) * (normal[q + 1] as number) + (normal[p + 2] as number) * (normal[q + 2] as number)
      const flat = (normal[p] === 0 && normal[p + 1] === 0 && normal[p + 2] === 0) || (normal[q] === 0 && normal[q + 1] === 0 && normal[q + 2] === 0)
      crease = !flat && dot < cosLimit
    }
    if (crease) {
      creaseEdges++
      for (const [u, w] of [[a, b], [b, a]] as const) {
        const k = creaseCount[u] as number
        if (k === 0) crease1[u] = w; else if (k === 1) crease2[u] = w
        if (k < 255) creaseCount[u] = k + 1
      }
    }
  }
  const start = new Int32Array(nv + 1)
  for (let v = 0; v < nv; v++) start[v + 1] = (start[v] as number) + (deg[v] as number)
  const adj = new Int32Array(start[nv] as number)
  const fill = new Int32Array(nv)
  for (let s = 0; s < ecap; s++) {
    const a = ea[s] as number
    if (a < 0) continue
    const b = eb[s] as number
    adj[(start[a] as number) + (fill[a] as number)++] = b
    adj[(start[b] as number) + (fill[b] as number)++] = a
  }
  cancelled(o)

  // ---- which vertices move, and how much
  const weight = new Float32Array(nv)   // 0 = fixed or outside the region
  const isCanon = (v: number): boolean => (rep[v] as number) === v
  const inRegion = new Uint8Array(nv), outRegion = new Uint8Array(nv)
  if (o.region) {
    for (let t = 0; t < nt; t++) {
      const flag = (o.region[t] as number) !== 0 ? inRegion : outRegion
      flag[rep[idx[3 * t] as number] as number] = 1; flag[rep[idx[3 * t + 1] as number] as number] = 1; flag[rep[idx[3 * t + 2] as number] as number] = 1
    }
  }
  let fixed = 0
  for (let v = 0; v < nv; v++) {
    if (!isCanon(v) || (deg[v] as number) === 0) continue
    const cc = creaseCount[v] as number
    const hold = pinned[v] === 1 || cc === 1 || cc >= 3
    if (hold) { fixed++; continue }
    weight[v] = o.region ? (inRegion[v] ? 1 : 0) : 1
  }
  if (o.region && o.falloff > 0) {
    // distance along the surface from the border of the part (a vertex the part shares with the rest), by Dijkstra, no further than `falloff`
    const dist = new Float64Array(nv).fill(Infinity)
    const heapV: number[] = [], heapD: number[] = []
    const push = (v: number, d: number): void => {
      let i = heapV.length; heapV.push(v); heapD.push(d)
      while (i > 0) { const p = (i - 1) >> 1; if ((heapD[p] as number) <= d) break; heapV[i] = heapV[p] as number; heapD[i] = heapD[p] as number; i = p }
      heapV[i] = v; heapD[i] = d
    }
    const pop = (): [number, number] => {
      const v = heapV[0] as number, d = heapD[0] as number
      const lv = heapV.pop() as number, ld = heapD.pop() as number
      const n = heapV.length
      if (n > 0) {
        let i = 0
        for (;;) {
          let c = 2 * i + 1
          if (c >= n) break
          if (c + 1 < n && (heapD[c + 1] as number) < (heapD[c] as number)) c++
          if ((heapD[c] as number) >= ld) break
          heapV[i] = heapV[c] as number; heapD[i] = heapD[c] as number; i = c
        }
        heapV[i] = lv; heapD[i] = ld
      }
      return [v, d]
    }
    for (let v = 0; v < nv; v++) if (isCanon(v) && inRegion[v] && outRegion[v]) { dist[v] = 0; push(v, 0) }
    while (heapV.length > 0) {
      const [v, d] = pop()
      if (d > (dist[v] as number) || d >= o.falloff) continue
      for (let k = start[v] as number; k < (start[v + 1] as number); k++) {
        const w = adj[k] as number
        if (!inRegion[w]) continue
        const nd = d + Math.hypot((X[3 * v] as number) - (X[3 * w] as number), (X[3 * v + 1] as number) - (X[3 * w + 1] as number), (X[3 * v + 2] as number) - (X[3 * w + 2] as number))
        if (nd < (dist[w] as number)) { dist[w] = nd; push(w, nd) }
      }
    }
    for (let v = 0; v < nv; v++) {
      if (!(weight[v] as number)) continue
      const t = Math.min(1, (dist[v] as number) / o.falloff)
      weight[v] = t * t * (3 - 2 * t)
    }
  }
  const moving: number[] = []
  for (let v = 0; v < nv; v++) if ((weight[v] as number) > 0) moving.push(v)
  if (moving.length === 0) return { ...untouched(), fixed, creaseEdges }
  const mv = Int32Array.from(moving)
  const X0 = Float64Array.from(X)

  // ---- the passes
  const D = new Float64Array(nv * 3)
  const pass = (factor: number): void => {
    for (let q = 0; q < mv.length; q++) {
      const v = mv[q] as number
      let mx: number, my: number, mz: number
      if (creaseCount[v] === 2) {
        const a = 3 * (crease1[v] as number), b = 3 * (crease2[v] as number)
        mx = ((X[a] as number) + (X[b] as number)) / 2; my = ((X[a + 1] as number) + (X[b + 1] as number)) / 2; mz = ((X[a + 2] as number) + (X[b + 2] as number)) / 2
      } else {
        let sx = 0, sy = 0, sz = 0
        const s0 = start[v] as number, s1 = start[v + 1] as number
        for (let k = s0; k < s1; k++) { const w = 3 * (adj[k] as number); sx += X[w] as number; sy += X[w + 1] as number; sz += X[w + 2] as number }
        const inv = 1 / (s1 - s0)
        mx = sx * inv; my = sy * inv; mz = sz * inv
      }
      const f = factor * (weight[v] as number)
      D[3 * v] = f * (mx - (X[3 * v] as number)); D[3 * v + 1] = f * (my - (X[3 * v + 1] as number)); D[3 * v + 2] = f * (mz - (X[3 * v + 2] as number))
    }
    for (let q = 0; q < mv.length; q++) { const v = 3 * (mv[q] as number); X[v] = (X[v] as number) + (D[v] as number); X[v + 1] = (X[v + 1] as number) + (D[v + 1] as number); X[v + 2] = (X[v + 2] as number) + (D[v + 2] as number) }
  }
  const clampMove = (): void => {
    if (!(o.maxMove > 0)) return
    for (let q = 0; q < mv.length; q++) {
      const v = 3 * (mv[q] as number)
      const dx = (X[v] as number) - (X0[v] as number), dy = (X[v + 1] as number) - (X0[v + 1] as number), dz = (X[v + 2] as number) - (X0[v + 2] as number)
      const l = Math.hypot(dx, dy, dz)
      if (l > o.maxMove) { const k = o.maxMove / l; X[v] = (X0[v] as number) + dx * k; X[v + 1] = (X0[v + 1] as number) + dy * k; X[v + 2] = (X0[v + 2] as number) + dz * k }
    }
  }
  for (let it = 0; it < o.iterations; it++) {
    cancelled(o)
    pass(lambda)
    if (o.keepVolume) pass(mu)
    clampMove()
    o.onProgress?.((it + 1) / o.iterations)
  }

  // ---- write back: only the vertices that moved (and their twins), so every other vertex keeps its bits
  const out = Float64Array.from(mesh.positions)
  const moved = new Uint8Array(nv)
  for (let q = 0; q < mv.length; q++) moved[mv[q] as number] = 1
  for (let v = 0; v < nv; v++) {
    const r = rep[v] as number
    if (moved[r]) { out[3 * v] = X[3 * r] as number; out[3 * v + 1] = X[3 * r + 1] as number; out[3 * v + 2] = X[3 * r + 2] as number }
  }
  let maxD = 0, sumD = 0, capped = 0
  for (let q = 0; q < mv.length; q++) {
    const v = 3 * (mv[q] as number)
    const l = Math.hypot((X[v] as number) - (X0[v] as number), (X[v + 1] as number) - (X0[v + 1] as number), (X[v + 2] as number) - (X0[v + 2] as number))
    if (l > maxD) maxD = l
    sumD += l
    if (o.maxMove > 0 && l >= o.maxMove * 0.999) capped++
  }
  return {
    mesh: { ...mesh, positions: out }, identity: false, iterations: o.iterations, lambda, mu, maxDisplacement: maxD, meanDisplacement: sumD / mv.length,
    movable: mv.length, fixed, creaseEdges, capped, ms: now() - t0,
  }
}
