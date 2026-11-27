// Surface texture: the surface of a mesh is moved along its normal by a height pattern, so a plate gets knurls, a mug gets leather or a block gets hexagons.
//
// Method, in four steps:
//  1. Cut. The triangles of the region are split until no edge is longer than a target length L. L follows from the pattern (a quarter of its smallest
//     feature, but not below 0.15 mm), so the displacement is sampled finely enough to follow the pattern and never aliases. Splitting is done per EDGE:
//     every edge longer than L gets one midpoint, shared by the two triangles on its sides, and each triangle is cut by the midpoints of its own edges
//     (1 to 2, 1 to 3 or 1 to 4 triangles). No point is left hanging in the middle of an edge, so a closed mesh stays closed and manifold. Children are
//     listed right after their parent, so mesh groups keep contiguous ranges, and a child keeps the segment label of its parent.
//  2. Direction and weight. Every vertex gets a normal (the angle weighted mean of the faces around it, optionally relaxed once over its neighbours) and
//     a weight between 0 and 1: 1 well inside the region and 0 at a sharp crease (dihedral angle over 30 degrees), at the border of the region and at an open edge,
//     growing smoothly over `edge_falloff` mm (a shortest-path distance along the surface). So the texture fades out before an edge and the edge stays crisp.
//  3. Height. The pattern is read at the vertex with one of the mappings (triplanar, planar, cylindrical, spherical, box).
//  4. Move. p' = p + n * amplitude * (h - zeroLevel) * weight.
// Moving the vertices of a closed mesh keeps it closed. It can still cross itself where the surface bends harder than the displacement allows: the
// result is checked for turned triangles and for displacements that are large against the local radius, and `texture.may_self_intersect` says so.
import { MeshError, measureMesh, segmentTable } from '@ateliermesh/core'
import type { Mesh, MeshGroup, SegmentInfo } from '@ateliermesh/core'
import { patternAspect, patternFeature, patternHeight } from './texture/patterns'
import type { PatternName, PatternParams } from './texture/patterns'
import { sampleImage } from './texture/image'
import { improveTriangles } from './texture/remesh'
import { makeCreaseField } from './texture/creases'
import type { HeightImage } from './texture/image'

export type Mapping = 'triplanar' | 'planar' | 'cylindrical' | 'spherical' | 'box'
export type Detail = 'auto' | 'fine' | 'coarse'

export interface TextureOptions {
  pattern: PatternName
  amplitude: number
  scale: number
  /** The zero level of the pattern: 0 raises from the surface, 1 cuts into it, 0.5 does both. */
  offset: number
  pattern_params: PatternParams
  invert: boolean
  image?: HeightImage | null
  /** An image: repeated over the surface (`tile`) or placed once (`fit`). */
  tiling: 'tile' | 'fit'
  mapping: Mapping
  axis: 'x' | 'y' | 'z'
  blend: number
  rotation: number
  offsetU: number
  offsetV: number
  /** One flag per triangle of the input: 1 = textured. null = all. */
  region: Uint8Array | null
  falloff: number
  /** A segment name given to the textured triangles; '' for none. */
  segmentName: string
  detail: Detail
  maxTriangles: number
  smoothNormals: boolean
  /** Flip edges and relax vertices of the flat patches after the cut, so the triangles are round (default true). */
  improve?: boolean
  signal?: AbortSignal
  onProgress?: (stage: 'subdivide' | 'displace', fraction: number) => void
}

export interface TextureResult {
  mesh: Mesh
  before: number
  after: number
  edgeLength: number
  maxDisplacement: number
  /** Triangles whose normal turned over: the surface crosses itself there. */
  flipped: number
  /** Vertices where the displacement is large against the local radius of curvature. */
  tight: number
  textured: number
  identity: boolean
  /** Triangle quality (mean of the smallest angles, degrees) of the textured region before and after the flips and relaxation; 0 when not measured. */
  minAngleBefore: number
  minAngleAfter: number
  flips: number
}

export const MIN_EDGE = 0.15
/** Patterns that are flat over much of the surface (dots, stipple): the cut is only made fine where the pattern changes or an edge is near. */
const ADAPTIVE = new Set<string>(['dots', 'hex_dots', 'stipple'])

const AXI = { x: 0, y: 1, z: 2 } as const
const smooth = (t: number): number => { const x = t < 0 ? 0 : t > 1 ? 1 : t; return x * x * (3 - 2 * x) }

/** The target edge length for a pattern, scale and detail. */
export function targetEdge(o: Pick<TextureOptions, 'pattern' | 'scale' | 'detail' | 'pattern_params' | 'image'>): number {
  const feat = patternFeature(o.pattern, o.pattern_params, o.image ? Math.max(o.image.width, o.image.height) : 64)
  const base = Math.max(MIN_EDGE, (feat * o.scale) / 4)
  return o.detail === 'fine' ? Math.max(0.1, base / 2) : o.detail === 'coarse' ? base * 2 : base
}

function cancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new MeshError('run.cancelled') }

export function textureMesh(input: Mesh, o: TextureOptions): TextureResult {
  const nt0 = input.indices.length / 3
  if (nt0 === 0 || input.positions.length === 0) throw new MeshError('texture.bad_input', { reason: 'empty_mesh' })
  if (o.region && o.region.length !== nt0) throw new MeshError('texture.bad_input', { reason: 'region_size' })
  const nReg0 = o.region ? o.region.reduce((n, f) => n + (f ? 1 : 0), 0) : nt0
  const L = targetEdge(o)
  if (o.amplitude === 0 || nReg0 === 0) {
    return { mesh: input, before: nt0, after: nt0, edgeLength: L, maxDisplacement: 0, flipped: 0, tight: 0, textured: nReg0, identity: true, minAngleBefore: 0, minAngleAfter: 0, flips: 0 }
  }

  // ---- what the pattern is made of: the middle of the model, how many tiles go round a cylinder or sphere, and the height at any point
  const P0 = input.positions, I0 = input.indices
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < P0.length; i += 3) for (let k = 0; k < 3; k++) { const x = P0[i + k] as number; if (x < (mn[k] as number)) mn[k] = x; if (x > (mx[k] as number)) mx[k] = x }
  const centre = [0, 1, 2].map(k => ((mn[k] as number) + (mx[k] as number)) / 2)
  const ax = AXI[o.axis]
  const c1 = ax === 0 ? 1 : 0, c2 = ax === 2 ? 1 : 2    // the two other axes, in x, y, z order
  // mean distance from the axis of the textured vertices (of the input mesh): how many tiles fit round a cylinder or a sphere
  const seenV = new Uint8Array(P0.length / 3)
  let rSum = 0, rN = 0
  for (let t = 0; t < nt0; t++) {
    if (o.region && !o.region[t]) continue
    for (let k = 0; k < 3; k++) {
      const v = I0[3 * t + k] as number
      if (seenV[v]) continue
      seenV[v] = 1
      rSum += Math.hypot((P0[3 * v + c1] as number) - (centre[c1] as number), (P0[3 * v + c2] as number) - (centre[c2] as number)); rN++
    }
  }
  const rRef = Math.max(rN ? rSum / rN : 1, 1e-6)
  const turns = Math.max(1, Math.round((2 * Math.PI * rRef) / o.scale))
  const image = o.pattern === 'image' ? o.image ?? null : null
  const aspect = patternAspect(o.pattern, image ? image.height / image.width : 1)
  const cosR = Math.cos((o.rotation * Math.PI) / 180), sinR = Math.sin((o.rotation * Math.PI) / 180)
  const height = (a: number, b: number): number => {
    // a, b: millimetres in the plane of the pattern; rotate, move, divide by the tile size
    const ra = a * cosR - b * sinR - o.offsetU, rb = a * sinR + b * cosR - o.offsetV
    const u = ra / o.scale, v = rb / (o.scale * aspect)
    let h = image ? sampleImage(image, u, v, o.tiling === 'tile') : patternHeight(o.pattern, u, v, o.pattern_params)
    h = h < 0 ? 0 : h > 1 ? 1 : h
    return o.invert ? 1 - h : h
  }
  const heightTiles = (u0: number, v0: number): number => {   // coordinates already in tiles: cylinder and sphere
    const u = u0 * cosR - v0 * sinR - o.offsetU / o.scale, v = u0 * sinR + v0 * cosR - o.offsetV / (o.scale * aspect)
    let h = image ? sampleImage(image, u, v, o.tiling === 'tile') : patternHeight(o.pattern, u, v, o.pattern_params)
    h = h < 0 ? 0 : h > 1 ? 1 : h
    return o.invert ? 1 - h : h
  }
  const planes: Array<[number, number]> = [[1, 2], [0, 2], [0, 1]]   // the pattern plane of each axis: (y, z), (x, z), (x, y)
  /** The pattern height at a point `p` of the surface with unit normal `n`, through the chosen mapping. */
  const heightAt = (p: number[], n: number[]): number => {
    let h = 0
    const sampleAxis = (k: number): number => height(p[(planes[k] as [number, number])[0]] as number, p[(planes[k] as [number, number])[1]] as number)
    if (o.mapping === 'planar') h = sampleAxis(ax)
    else if (o.mapping === 'box') {
      const k = Math.abs(n[0] as number) >= Math.abs(n[1] as number) && Math.abs(n[0] as number) >= Math.abs(n[2] as number) ? 0 : Math.abs(n[1] as number) >= Math.abs(n[2] as number) ? 1 : 2
      h = sampleAxis(k)
    } else if (o.mapping === 'triplanar') {
      const wk = n.map(c => Math.pow(Math.abs(c), o.blend))
      const sum = (wk[0] as number) + (wk[1] as number) + (wk[2] as number) || 1
      for (let k = 0; k < 3; k++) { const wt = (wk[k] as number) / sum; if (wt > 0.005) h += wt * sampleAxis(k) }
    } else {
      // cylinder and sphere about the axis through the centre; the caps of a cylinder are planar
      const q1 = (p[c1] as number) - (centre[c1] as number), q2 = (p[c2] as number) - (centre[c2] as number)
      const theta = Math.atan2(q2, q1)
      const along = (p[ax] as number) - (centre[ax] as number)
      if (o.mapping === 'cylindrical') {
        const nax = Math.abs(n[ax] as number), nside = Math.sqrt(Math.max(0, 1 - nax * nax))
        const wc = Math.pow(nax, o.blend), ws = Math.pow(nside, o.blend), sum = wc + ws || 1
        const side = ws > 0.005 ? heightTiles((theta / (2 * Math.PI)) * turns, along / (o.scale * aspect)) : 0
        const cap = wc > 0.005 ? height(q1, q2) : 0
        h = (ws * side + wc * cap) / sum
      } else {
        const r = Math.hypot(q1, q2, along) || 1
        const lat = Math.asin(Math.max(-1, Math.min(1, along / r)))
        h = heightTiles((theta / (2 * Math.PI)) * turns, (lat * rRef) / (o.scale * aspect))
      }
    }
    return h
  }
  // the sharp edges and region borders of the input, and how far a point is from them (for the fade and for the finer cut near them)
  const creases = o.falloff > 0 ? makeCreaseField(P0, I0, o.region, o.falloff) : null
  cancelled(o.signal)

  // ---- what it will cost, before any work: about 4 triangles per L x L of surface in the region
  let area = 0
  for (let t = 0; t < nt0; t++) {
    if (o.region && !o.region[t]) continue
    const a = (I0[3 * t] as number) * 3, b = (I0[3 * t + 1] as number) * 3, c = (I0[3 * t + 2] as number) * 3
    const ux = (P0[b] as number) - (P0[a] as number), uy = (P0[b + 1] as number) - (P0[a + 1] as number), uz = (P0[b + 2] as number) - (P0[a + 2] as number)
    const vx = (P0[c] as number) - (P0[a] as number), vy = (P0[c + 1] as number) - (P0[a + 1] as number), vz = (P0[c + 2] as number) - (P0[a + 2] as number)
    area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
  }
  const adaptive = ADAPTIVE.has(o.pattern) && !image
  const estimate = Math.round(nt0 - nReg0 + Math.max(nReg0, (4.1 * area) / (L * L) * (adaptive ? 0.5 : 1)))
  if (estimate > o.maxTriangles * (adaptive ? 2 : 1)) throw new MeshError('texture.too_heavy', { triangles: estimate, limit: o.maxTriangles, edge: Math.round(L * 1000) / 1000 })

  // ---- 1. cut
  let pos: number[] = Array.from(P0)
  let tri: number[] = Array.from(I0)
  let reg = new Uint8Array(nt0); if (o.region) reg.set(o.region); else reg.fill(1)
  let lab: number[] | null = input.segments ? Array.from(input.segments.labels) : null
  let own = new Int32Array(nt0); for (let t = 0; t < nt0; t++) own[t] = t
  const L2 = L * L
  for (let round = 0; round < 30; round++) {
    cancelled(o.signal)
    const nv = pos.length / 3, nt = tri.length / 3
    const marks = new Map<number, number>()
    const key = (a: number, b: number): number => (a < b ? a * nv + b : b * nv + a)
    const len2 = (a: number, b: number): number => { const dx = (pos[3 * a] as number) - (pos[3 * b] as number), dy = (pos[3 * a + 1] as number) - (pos[3 * b + 1] as number), dz = (pos[3 * a + 2] as number) - (pos[3 * b + 2] as number); return dx * dx + dy * dy + dz * dz }
    const seenEdge = new Map<number, boolean>()    // adaptive: has this edge been looked at (true = split it)
    const LC2 = (4 * L) * (4 * L)                  // adaptive: edges longer than this are always split; between L and this only where the surface needs it
    const LF = o.falloff > 0 ? Math.max(MIN_EDGE, Math.min(L, o.falloff / 2)) : L   // near a sharp edge the cut goes down to half the fade (two edges across it)
    const LF2 = LF * LF
    for (let t = 0; t < nt; t++) {
      if ((t & 0x3ffff) === 0) cancelled(o.signal)
      if (!reg[t]) continue
      const a = tri[3 * t] as number, b = tri[3 * t + 1] as number, c = tri[3 * t + 2] as number
      let n: number[] | null = null
      const want = (u: number, v: number): void => {
        const l2 = len2(u, v)
        if (l2 <= LF2) return
        const k = key(u, v)
        if ((!adaptive && l2 > L2) || l2 > LC2) { marks.set(k, -1); return }
        // an edge between the finest length near a sharp edge (half the fade) and the target length, or (adaptive) up to four times the target:
        // split it near a sharp edge or the border of the region, so the fade is followed; and (adaptive) where the pattern changes along it
        let w = seenEdge.get(k)
        if (w === undefined) {
          const ux = pos[3 * u] as number, uy = pos[3 * u + 1] as number, uz = pos[3 * u + 2] as number, vx = pos[3 * v] as number, vy = pos[3 * v + 1] as number, vz = pos[3 * v + 2] as number
          const mxp = (ux + vx) / 2, myp = (uy + vy) / 2, mzp = (uz + vz) / 2
          w = creases !== null && creases.near(mxp, myp, mzp)
          if (!w && adaptive && l2 > L2) {
            if (!n) {
              const ex = (pos[3 * b] as number) - (pos[3 * a] as number), ey = (pos[3 * b + 1] as number) - (pos[3 * a + 1] as number), ez = (pos[3 * b + 2] as number) - (pos[3 * a + 2] as number)
              const fx = (pos[3 * c] as number) - (pos[3 * a] as number), fy = (pos[3 * c + 1] as number) - (pos[3 * a + 1] as number), fz = (pos[3 * c + 2] as number) - (pos[3 * a + 2] as number)
              const nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx, nl = Math.hypot(nx, ny, nz) || 1
              n = [nx / nl, ny / nl, nz / nl]
            }
            const h0 = heightAt([ux, uy, uz], n), h1 = heightAt([vx, vy, vz], n), hm = heightAt([mxp, myp, mzp], n)
            const lo = Math.min(h0, h1, hm), hi = Math.max(h0, h1, hm)
            w = hi - lo > 0.03 || (hm < 0.97 && hm > 0.03)          // the pattern is not flat here
          }
          seenEdge.set(k, w)
        }
        if (w) marks.set(k, -1)
      }
      want(a, b); want(b, c); want(c, a)
    }
    if (marks.size === 0) break
    // red-green closure (adaptive cuts only): a triangle with two marked edges is cut fully (its third edge is marked too), so the cut makes round triangles
    // (1 to 4) or plain halves (1 to 2) and never the thin pieces of a 1 to 3 cut, which kept being cut again round after round. A uniform cut does not need it.
    for (let pass = 0; pass < (adaptive ? 6 : 0); pass++) {
      let changed = 0
      for (let t = 0; t < nt; t++) {
        const a = tri[3 * t] as number, b = tri[3 * t + 1] as number, c = tri[3 * t + 2] as number
        const m0 = marks.has(key(a, b)), m1 = marks.has(key(b, c)), m2 = marks.has(key(c, a))
        const cnt = (m0 ? 1 : 0) + (m1 ? 1 : 0) + (m2 ? 1 : 0)
        if (cnt === 2) { if (!m0) marks.set(key(a, b), -1); else if (!m1) marks.set(key(b, c), -1); else marks.set(key(c, a), -1); changed++ }
      }
      if (changed === 0) break
    }
    let add = 0
    for (let t = 0; t < nt; t++) {
      const a = tri[3 * t] as number, b = tri[3 * t + 1] as number, c = tri[3 * t + 2] as number
      add += (marks.has(key(a, b)) ? 1 : 0) + (marks.has(key(b, c)) ? 1 : 0) + (marks.has(key(c, a)) ? 1 : 0)
    }
    if (nt + add > o.maxTriangles) throw new MeshError('texture.too_heavy', { triangles: nt + add, limit: o.maxTriangles, edge: Math.round(L * 1000) / 1000 })
    let next = nv
    for (const k of marks.keys()) {
      const lo = Math.floor(k / nv), hi = k - lo * nv
      pos.push(((pos[3 * lo] as number) + (pos[3 * hi] as number)) / 2, ((pos[3 * lo + 1] as number) + (pos[3 * hi + 1] as number)) / 2, ((pos[3 * lo + 2] as number) + (pos[3 * hi + 2] as number)) / 2)
      marks.set(k, next++)
    }
    const nTri: number[] = [], nReg: number[] = [], nOwn: number[] = [], nLab: number[] | null = lab ? [] : null
    const out = (t: number, a: number, b: number, c: number): void => { nTri.push(a, b, c); nReg.push(reg[t] as number); nOwn.push(own[t] as number); nLab?.push(lab![t] as number) }
    const shorter = (a: number, b: number, c: number, d: number): boolean => len2(a, b) <= len2(c, d) // is the diagonal a-b the shorter one
    for (let t = 0; t < nt; t++) {
      if ((t & 0x3ffff) === 0) cancelled(o.signal)
      const a = tri[3 * t] as number, b = tri[3 * t + 1] as number, c = tri[3 * t + 2] as number
      const m01 = marks.get(key(a, b)) ?? -1, m12 = marks.get(key(b, c)) ?? -1, m20 = marks.get(key(c, a)) ?? -1
      const mask = (m01 >= 0 ? 1 : 0) | (m12 >= 0 ? 2 : 0) | (m20 >= 0 ? 4 : 0)
      switch (mask) {
        case 0: out(t, a, b, c); break
        case 1: out(t, a, m01, c); out(t, m01, b, c); break
        case 2: out(t, b, m12, a); out(t, m12, c, a); break
        case 4: out(t, c, m20, b); out(t, m20, a, b); break
        case 3: // corner at b is cut off; a, m01, m12, c remain
          out(t, m01, b, m12)
          if (shorter(a, m12, m01, c)) { out(t, a, m01, m12); out(t, a, m12, c) } else { out(t, a, m01, c); out(t, m01, m12, c) }
          break
        case 6: // corner at c; a, b, m12, m20 remain
          out(t, m12, c, m20)
          if (shorter(a, m12, b, m20)) { out(t, a, b, m12); out(t, a, m12, m20) } else { out(t, a, b, m20); out(t, b, m12, m20) }
          break
        case 5: // corner at a; m01, b, c, m20 remain
          out(t, a, m01, m20)
          if (shorter(m01, c, b, m20)) { out(t, m01, b, c); out(t, m01, c, m20) } else { out(t, m01, b, m20); out(t, b, c, m20) }
          break
        default: // all three
          out(t, a, m01, m20); out(t, m01, b, m12); out(t, m20, m12, c); out(t, m01, m12, m20)
      }
    }
    tri = nTri; reg = Uint8Array.from(nReg); own = Int32Array.from(nOwn); lab = nLab
    o.onProgress?.('subdivide', Math.min(0.95, round / 8))
  }
  o.onProgress?.('subdivide', 1)
  cancelled(o.signal)

  // ---- 2. normals, region vertices, weights
  const nv = pos.length / 3, nt = tri.length / 3
  const P = Float64Array.from(pos); pos = []
  const T = Uint32Array.from(tri); tri = []
  // ---- 1b. triangle quality: flip edges and relax vertices inside the flat patches (the surface itself does not change)
  let qBefore = 0, qAfter = 0, nFlips = 0
  if (o.improve !== false) {
    const groupOfOwn = new Int32Array(nt0).fill(-1)
    if (input.groups) input.groups.forEach((g, gi) => { for (let t = g.start; t < g.start + g.count && t < nt0; t++) groupOfOwn[t] = gi })
    const tag = new Int32Array(nt)
    for (let t = 0; t < nt; t++) tag[t] = (lab ? (lab[t] as number) : 0) + 65536 * ((groupOfOwn[own[t] as number] as number) + 1)
    const st = improveTriangles({ P, T, reg, tag, ...(o.signal ? { signal: o.signal } : {}) })
    qBefore = st.minAngleBefore; qAfter = st.minAngleAfter; nFlips = st.flips
  }
  cancelled(o.signal)
  const fn = new Float32Array(3 * nt)
  const vn = new Float64Array(3 * nv)
  const inRegion = new Uint8Array(nv)
  for (let t = 0; t < nt; t++) {
    const a = (T[3 * t] as number) * 3, b = (T[3 * t + 1] as number) * 3, c = (T[3 * t + 2] as number) * 3
    const ux = (P[b] as number) - (P[a] as number), uy = (P[b + 1] as number) - (P[a + 1] as number), uz = (P[b + 2] as number) - (P[a + 2] as number)
    const vx = (P[c] as number) - (P[a] as number), vy = (P[c + 1] as number) - (P[a + 1] as number), vz = (P[c + 2] as number) - (P[a + 2] as number)
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz) || 1
    nx /= l; ny /= l; nz /= l
    fn[3 * t] = nx; fn[3 * t + 1] = ny; fn[3 * t + 2] = nz
    for (let k = 0; k < 3; k++) {
      const i = T[3 * t + k] as number, j = T[3 * t + (k + 1) % 3] as number, m = T[3 * t + (k + 2) % 3] as number
      const e1x = (P[3 * j] as number) - (P[3 * i] as number), e1y = (P[3 * j + 1] as number) - (P[3 * i + 1] as number), e1z = (P[3 * j + 2] as number) - (P[3 * i + 2] as number)
      const e2x = (P[3 * m] as number) - (P[3 * i] as number), e2y = (P[3 * m + 1] as number) - (P[3 * i + 1] as number), e2z = (P[3 * m + 2] as number) - (P[3 * i + 2] as number)
      const d = Math.hypot(e1x, e1y, e1z) * Math.hypot(e2x, e2y, e2z) || 1
      const w = Math.acos(Math.max(-1, Math.min(1, (e1x * e2x + e1y * e2y + e1z * e2z) / d)))
      vn[3 * i] += nx * w; vn[3 * i + 1] += ny * w; vn[3 * i + 2] += nz * w
      if (reg[t]) inRegion[i] = 1
    }
    if ((t & 0x3ffff) === 0) cancelled(o.signal)
  }
  const norm = (a: Float64Array): void => { for (let v = 0; v < nv; v++) { const l = Math.hypot(a[3 * v] as number, a[3 * v + 1] as number, a[3 * v + 2] as number) || 1; a[3 * v] = (a[3 * v] as number) / l; a[3 * v + 1] = (a[3 * v + 1] as number) / l; a[3 * v + 2] = (a[3 * v + 2] as number) / l } }
  norm(vn)

  // neighbours (each edge appears once per side: fine for averaging and for shortest paths)
  // a compact adjacency: two neighbours per triangle corner
  const degree = new Int32Array(nv)
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) degree[T[3 * t + k] as number]! += 2
  const off = new Int32Array(nv + 1)
  for (let v = 0; v < nv; v++) off[v + 1] = (off[v] as number) + (degree[v] as number)
  const nb = new Int32Array(off[nv] as number)
  const cur = Int32Array.from(off.subarray(0, nv))
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
    const v = T[3 * t + k] as number, a = T[3 * t + (k + 1) % 3] as number, b = T[3 * t + (k + 2) % 3] as number
    nb[cur[v]!++] = a; nb[cur[v]!++] = b
  }

  if (o.smoothNormals) {
    const sm = new Float64Array(3 * nv)
    for (let v = 0; v < nv; v++) {
      let x = (vn[3 * v] as number) * 2, y = (vn[3 * v + 1] as number) * 2, z = (vn[3 * v + 2] as number) * 2
      const s = off[v] as number, e = off[v + 1] as number
      for (let i = s; i < e; i++) { const u = nb[i] as number; x += (vn[3 * u] as number) / Math.max(1, (e - s) / 2); y += (vn[3 * u + 1] as number) / Math.max(1, (e - s) / 2); z += (vn[3 * u + 2] as number) / Math.max(1, (e - s) / 2) }
      sm[3 * v] = x; sm[3 * v + 1] = y; sm[3 * v + 2] = z
    }
    norm(sm); vn.set(sm)
  }

  // the weight of every vertex: 1 inside, falling to 0 at creases, region borders and open edges over `falloff` mm (the straight distance to the edge segments)
  const weight = new Float32Array(nv).fill(1)
  if (creases) {
    for (let v = 0; v < nv; v++) {
      if (!inRegion[v]) continue
      const x = P[3 * v] as number, y = P[3 * v + 1] as number, z = P[3 * v + 2] as number
      if (!creases.near(x, y, z)) continue
      const d = creases.dist(x, y, z)
      if (d < o.falloff) weight[v] = smooth(d / o.falloff)
    }
  }

  // ---- 3 and 4. move: p' = p + n * amplitude * (h - zeroLevel) * weight
  const out = Float64Array.from(P)
  const disp = new Float32Array(nv)
  let maxDisp = 0
  for (let v = 0; v < nv; v++) {
    if ((v & 0x3fff) === 0) { cancelled(o.signal); o.onProgress?.('displace', v / nv) }
    if (!inRegion[v]) continue
    const w = weight[v] as number
    if (w <= 0) continue
    const x = P[3 * v] as number, y = P[3 * v + 1] as number, z = P[3 * v + 2] as number
    const p = [x, y, z], n = [vn[3 * v] as number, vn[3 * v + 1] as number, vn[3 * v + 2] as number]
    const h = heightAt(p, n)
    const d = o.amplitude * (h - o.offset) * w
    disp[v] = d
    if (Math.abs(d) > maxDisp) maxDisp = Math.abs(d)
    out[3 * v] = x + (n[0] as number) * d; out[3 * v + 1] = y + (n[1] as number) * d; out[3 * v + 2] = z + (n[2] as number) * d
  }
  o.onProgress?.('displace', 1)

  // ---- checks: turned triangles, and a displacement that is large against the bend of the surface
  let flipped = 0
  for (let t = 0; t < nt; t++) {
    if (!reg[t]) continue
    const a = (T[3 * t] as number) * 3, b = (T[3 * t + 1] as number) * 3, c = (T[3 * t + 2] as number) * 3
    if (disp[a / 3] === 0 && disp[b / 3] === 0 && disp[c / 3] === 0) continue
    const ux = (out[b] as number) - (out[a] as number), uy = (out[b + 1] as number) - (out[a + 1] as number), uz = (out[b + 2] as number) - (out[a + 2] as number)
    const vx = (out[c] as number) - (out[a] as number), vy = (out[c + 1] as number) - (out[a + 1] as number), vz = (out[c + 2] as number) - (out[a + 2] as number)
    const dot = (uy * vz - uz * vy) * (fn[3 * t] as number) + (uz * vx - ux * vz) * (fn[3 * t + 1] as number) + (ux * vy - uy * vx) * (fn[3 * t + 2] as number)
    if (dot <= 0) flipped++
  }
  let tight = 0
  for (let v = 0; v < nv; v++) {
    const d = Math.abs(disp[v] as number)
    if (d === 0) continue
    let kappa = 0
    for (let i = off[v] as number; i < (off[v + 1] as number); i += 2) {
      const u = nb[i] as number
      const e = Math.hypot((P[3 * u] as number) - (P[3 * v] as number), (P[3 * u + 1] as number) - (P[3 * v + 1] as number), (P[3 * u + 2] as number) - (P[3 * v + 2] as number)) || 1
      const ang = Math.acos(Math.max(-1, Math.min(1, (vn[3 * v] as number) * (vn[3 * u] as number) + (vn[3 * v + 1] as number) * (vn[3 * u + 1] as number) + (vn[3 * v + 2] as number) * (vn[3 * u + 2] as number))))
      kappa = Math.max(kappa, ang / e)
    }
    if (d * kappa > 0.5) tight++
  }

  // ---- the new mesh: groups follow their parents; the textured triangles can be labelled
  let groups: MeshGroup[] | undefined
  if (input.groups && input.groups.length > 0) {
    const first = new Int32Array(nt0).fill(-1), cnt = new Int32Array(nt0)
    for (let i = 0; i < nt; i++) { const p = own[i] as number; if (first[p] === -1) first[p] = i; cnt[p]!++ }
    groups = input.groups.map(g => {
      let s = -1, n = 0
      for (let t = g.start; t < g.start + g.count; t++) { if (s === -1) s = first[t] as number; n += cnt[t] as number }
      return { ...g, start: Math.max(0, s), count: n }
    })
  }
  let segments: Mesh['segments']
  if (lab || o.segmentName) {
    const table: SegmentInfo[] = segmentTable(input).map(s => ({ ...s }))
    const labels = new Uint16Array(nt)
    if (lab) for (let i = 0; i < nt; i++) labels[i] = lab[i] as number
    if (o.segmentName) {
      let id = table.find(s => s.name === o.segmentName)?.id
      if (id === undefined) { id = table.reduce((m, s) => Math.max(m, s.id), 0) + 1; table.push({ id, name: o.segmentName }) }
      for (let t = 0; t < nt; t++) {
        if (!reg[t]) continue
        if ((disp[(T[3 * t] as number)] as number) !== 0 || (disp[(T[3 * t + 1] as number)] as number) !== 0 || (disp[(T[3 * t + 2] as number)] as number) !== 0) labels[t] = id
      }
    }
    segments = { labels, table }
  }
  const mesh: Mesh = { positions: out, indices: T, ...(groups ? { groups } : {}), ...(segments ? { segments } : {}) }
  return { mesh, before: nt0, after: nt, edgeLength: L, maxDisplacement: maxDisp, flipped, tight, textured: reg.reduce((n, f) => n + (f ? 1 : 0), 0), identity: false, minAngleBefore: qBefore, minAngleAfter: qAfter, flips: nFlips }
}

/** Volume change of the textured mesh relative to the original, in percent (null when the original encloses no volume). */
export function textureVolumeChange(before: Mesh, after: Mesh): number | null {
  const v0 = measureMesh(before).volume, v1 = measureMesh(after).volume
  return v0 > 1e-9 ? ((v1 - v0) / v0) * 100 : null
}
