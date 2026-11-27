// Twist, taper and bend: a smooth map of space applied to every vertex of the mesh, after the mesh is cut fine enough for the map to be followed.
//
// The map F works on the position along one axis (w) and the two other coordinates (u, v), measured from a centre:
//   twist  (u, v) -> rotation of (u, v) by angle * e(t)        t = fraction along the axis inside [from, to], clamped to 0..1
//   taper  (u, v) -> scaling of (u, v) by 1 + (scale_end - 1) * e(t)
//   bend   the model is bent round a circle: the axis (w) becomes an arc of constant curvature k = angle / length, the offset d from the neutral line in the
//          fold direction (b) is measured along the radius. A point at arc length s (clamped to the range) and offset d goes to
//            w' = w0 + s * sinc(k s) - d * sin(k s)          b' = b0 + s * (1 - cos(k s)) / (k s) + d * cos(k s)
//          and what lies beyond the range ends is carried on rigidly along the tangent. The Jacobian is 1 - k d: the inner side (d towards the centre
//          of the circle) is compressed, the outer side stretched, and the map folds where k d reaches 1 (the point is at the centre of the circle).
// e is the easing (linear or smoothstep). Outside the range t is clamped, so the part below stays where it is and the part above is moved
// rigidly (turned or scaled as a whole): the model never tears. Both maps are one-to-one and keep the orientation (the Jacobian is 1 for a
// twist and the product of the scales for a taper), so a closed solid stays a closed solid and cannot cross itself.
//
// Subdivision (before the map, in the original coordinates): the mesh is cut by parallel planes across the axis, N of them evenly spread over the
// range [from, to] (the range ends are always planes, because the map bends there). N follows from the tolerance: for a twist the chord of the
// arc a point travels between two planes sags by r * d^2 / 8 (r the largest distance from the axis, d the turn between two planes), for a taper
// the straight edge between the images of two points differs from the image of the edge by |du| * |ds| / 4, du being the widest sideways reach of a triangle (plus the bend of a smooth easing).
// A triangle that crosses planes is cut into strips along them (a zipper between the long edge and the two short edges), and the point where an
// edge crosses a plane is shared by the triangles on both sides through an edge table, so the mesh stays conforming and closed. Children follow
// their parent in the list, so mesh groups keep contiguous ranges and every child keeps its parent's segment label. The number of triangles
// grows with the number of planes (not with its square), and a triangle that lies in a plane (the flat ends of a part) is never cut.
import { MeshError, measureMesh } from '@ateliermesh/core'
import type { Mesh, MeshGroup } from '@ateliermesh/core'

export type Axis = 'x' | 'y' | 'z'
export type Easing = 'linear' | 'smooth'
export type Detail = 'auto' | 'fine' | 'extra_fine' | 'coarse'

export interface DeformOptions {
  kind: 'twist' | 'taper' | 'bend'
  axis: Axis
  /** Centre of the turn or the scaling in the cross-section: the two coordinates that are not the axis. */
  center: [number, number, number]
  from: number
  to: number
  easing: Easing
  detail: Detail
  maxTriangles: number
  /** Twist: total angle in degrees. Bend: the total bend over the range, in degrees (positive folds towards +bendAxis). */
  angle?: number
  /** Bend: the direction the model folds towards (an axis that is not `axis`). */
  bendAxis?: Axis
  /** Taper: scale at `to` relative to 1 at `from`. */
  scaleEnd?: number
  /** Taper: which cross-section axes scale. `x` is the first of the two other axes in x, y, z order, `y` the second. */
  uniform?: 'both' | 'x' | 'y'
  signal?: AbortSignal
  onProgress?: (f: number) => void
}

export interface DeformResult {
  mesh: Mesh
  before: number
  after: number
  rounds: number
  tolerance: number
  maxDisplacement: number
  /** Smallest value of the Jacobian determinant of the map over the model (1 for a twist). */
  minJacobian: number
  /** Largest stretch of a surface line, as a factor (1 = none). */
  maxStretch: number
  /** The edges that were still marked when the rounds ran out; 0 when the surface follows the map within the tolerance. */
  unresolved: number
  /** Position along the axis (0..1 of the model) where the map is hardest on the surface. */
  worst: number
  identity: boolean
}

export const MAX_ROUNDS = 16
const AX = { x: 0, y: 1, z: 2 } as const
const smooth = (t: number): number => t * t * (3 - 2 * t)

/** The map as a function on one point, plus the bits the checks need. */
function makeMap(mesh: Mesh, o: DeformOptions): { jac?: (x: number, y: number, z: number) => number; F: (x: number, y: number, z: number, out: Float64Array, off: number) => void; extent: number; w0: number; w1: number; slope: number; wMin: number; wMax: number; jacobian: (w: number) => number; stretch: (w: number, r: number) => number; bound: (wa: number, wb: number, ra: number, rb: number) => number } {
  const a = AX[o.axis]
  const wMin = bbox(mesh).min[a] as number, wMax = bbox(mesh).max[a] as number
  const extent = Math.max(wMax - wMin, 1e-9)
  const w0 = wMin + Math.min(o.from, o.to) * extent, w1 = wMin + Math.max(o.from, o.to) * extent
  const span = Math.max(w1 - w0, 1e-9)
  const e = (w: number): number => { const t = Math.min(1, Math.max(0, (w - w0) / span)); return o.easing === 'smooth' ? smooth(t) : t }
  const slope = o.easing === 'smooth' ? 1.5 / span : 1 / span // the largest slope of e per mm
  // cross-section coordinates: cyclic for the turn (so a positive angle turns right-handed about the axis), sorted for the scaling
  const cyc: [number, number] = a === 0 ? [1, 2] : a === 1 ? [2, 0] : [0, 1]
  const srt: [number, number] = a === 0 ? [1, 2] : a === 1 ? [0, 2] : [0, 1]
  const c = o.center
  if (o.kind === 'twist') {
    const ang = ((o.angle ?? 0) * Math.PI) / 180
    return {
      F(x, y, z, out, off) {
        const p = [x, y, z], w = p[a] as number
        const th = ang * e(w), cs = Math.cos(th), sn = Math.sin(th)
        const du = (p[cyc[0]] as number) - (c[cyc[0]] as number), dv = (p[cyc[1]] as number) - (c[cyc[1]] as number)
        p[cyc[0]] = (c[cyc[0]] as number) + cs * du - sn * dv
        p[cyc[1]] = (c[cyc[1]] as number) + sn * du + cs * dv
        out[off] = p[0] as number; out[off + 1] = p[1] as number; out[off + 2] = p[2] as number
      },
      extent, w0, w1, slope, wMin, wMax,
      jacobian: () => 1,
      stretch: (_w, r) => Math.sqrt(1 + (Math.abs(ang) * slope * r) ** 2),
      // the chord of an arc of angle d at radius r is r * d^2 / 8 away from the arc; a sample of three points cannot see a turn of a whole circle, this does
      bound: (wa, wb, ra, rb) => { const d = Math.abs(ang * (e(wb) - e(wa))); return d >= Math.PI ? Infinity : (Math.max(ra, rb) * d * d) / 8 },
    }
  }
  if (o.kind === 'bend') {
    const b = AX[o.bendAxis ?? 'x']
    const span = Math.max(w1 - w0, 1e-9)
    const alpha = ((o.angle ?? 0) * Math.PI) / 180
    const k = alpha / span
    const cb = c[b] as number
    const endC = Math.cos(alpha), endS = Math.sin(alpha)
    return {
      F(x, y, z, out, off) {
        const p = [x, y, z], w = p[a] as number, d = (p[b] as number) - cb
        const sArc = Math.min(span, Math.max(0, w - w0)), th = k * sArc, cs = Math.cos(th), sn = Math.sin(th)
        const small = Math.abs(th) < 1e-6
        let wN = w0 + sArc * (small ? 1 - (th * th) / 6 : sn / th) - d * sn
        let bN = cb + sArc * (small ? th / 2 : (1 - cs) / th) + d * cs
        if (w > w1) { const t = w - w1; wN += t * endC; bN += t * endS } else if (w < w0) wN += w - w0
        p[a] = wN; p[b] = bN
        out[off] = p[0] as number; out[off + 1] = p[1] as number; out[off + 2] = p[2] as number
      },
      jac(x, y, z) { const p = [x, y, z], w = p[a] as number; return w < w0 || w > w1 ? 1 : 1 - k * ((p[b] as number) - cb) },
      extent, w0, w1, slope, wMin, wMax,
      jacobian: () => 1,
      stretch: () => 1,
      bound: () => 0,
    }
  }
  const k = o.scaleEnd ?? 1
  const su = o.uniform === 'y' ? 0 : 1, sv = o.uniform === 'x' ? 0 : 1 // 1 = this coordinate scales
  const sc = (w: number): number => 1 + (k - 1) * e(w)
  return {
    F(x, y, z, out, off) {
      const p = [x, y, z], s = sc(p[a] as number)
      if (su) p[srt[0]] = (c[srt[0]] as number) + s * ((p[srt[0]] as number) - (c[srt[0]] as number))
      if (sv) p[srt[1]] = (c[srt[1]] as number) + s * ((p[srt[1]] as number) - (c[srt[1]] as number))
      out[off] = p[0] as number; out[off + 1] = p[1] as number; out[off + 2] = p[2] as number
    },
    extent, w0, w1, slope, wMin, wMax,
    jacobian: w => (su ? sc(w) : 1) * (sv ? sc(w) : 1),
    stretch: () => 1,
    bound: () => 0,
  }
}

function bbox(mesh: Mesh): { min: number[]; max: number[] } {
  const P = mesh.positions
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { const v = P[i + k] as number; if (v < (min[k] as number)) min[k] = v; if (v > (max[k] as number)) max[k] = v }
  return { min, max }
}

export function deformMesh(input: Mesh, o: DeformOptions): DeformResult {
  const nt0 = input.indices.length / 3
  if (nt0 === 0 || input.positions.length === 0) throw new MeshError('deform.bad_input', { reason: 'empty_mesh' })
  const map = makeMap(input, o)
  const ext = Math.max(...[0, 1, 2].map(k => (bbox(input).max[k] as number) - (bbox(input).min[k] as number)))
  const baseTol = Math.min(0.02, 0.005 * ext)
  const tol = o.detail === 'fine' ? baseTol / 4 : o.detail === 'extra_fine' ? baseTol / 16 : o.detail === 'coarse' ? Math.min(baseTol * 4, 0.01 * ext) : baseTol
  const identity = o.kind === 'taper' ? Math.abs((o.scaleEnd ?? 1) - 1) < 1e-12 : (o.angle ?? 0) === 0

  // ---- where to cut
  const a = AX[o.axis]
  const cyc: [number, number] = a === 0 ? [1, 2] : a === 1 ? [2, 0] : [0, 1]
  const sorted: [number, number] = a === 0 ? [1, 2] : a === 1 ? [0, 2] : [0, 1]
  const P0 = input.positions
  let rmax = 0, umax = 0, dLo = Infinity, dHi = -Infinity
  const bAxis = AX[o.bendAxis ?? 'x']
  for (let i = 0; i < P0.length; i += 3) {
    const w = P0[i + a] as number
    if (w < map.w0 - 1e-12 || w > map.w1 + 1e-12) continue
    if (o.kind === 'bend') { const d = (P0[i + bAxis] as number) - (o.center[bAxis] as number); if (d < dLo) dLo = d; if (d > dHi) dHi = d }
    rmax = Math.max(rmax, Math.hypot((P0[i + cyc[0]] as number) - (o.center[cyc[0]] as number), (P0[i + cyc[1]] as number) - (o.center[cyc[1]] as number)))
    for (const k of sorted) umax = Math.max(umax, Math.abs((P0[i + k] as number) - (o.center[k] as number)))
  }
  const span = Math.max(map.w1 - map.w0, 1e-9)
  const sf = o.easing === 'smooth' ? 1.5 : 1
  let slices = 0
  if (!identity) {
    if (o.kind === 'twist') slices = Math.ceil(Math.abs(((o.angle ?? 0) * Math.PI) / 180) * sf * Math.sqrt(rmax / (8 * tol)))
    else if (o.kind === 'bend') {
      // an edge between two planes becomes a chord of an arc of radius |R - d| that turns by phi = k * (plane spacing): it sags by |R - d| * phi^2 / 8
      const alpha = Math.abs(((o.angle ?? 0) * Math.PI) / 180), R = span / alpha
      const rho = Math.max(Math.abs(R - (Number.isFinite(dLo) ? dLo : 0)), Math.abs(R - (Number.isFinite(dHi) ? dHi : 0)), 1e-9)
      slices = Math.ceil(alpha * Math.sqrt(rho / (8 * tol)))
    }
    else {
      const k1 = Math.abs((o.scaleEnd ?? 1) - 1)
      // the widest a triangle that is not flat across the axis stretches in the cross-section: that is how far an edge between two planes can reach sideways
      let reach = 0
      for (let t = 0; t < nt0; t++) {
        const i0 = (input.indices[3 * t] as number) * 3, i1 = (input.indices[3 * t + 1] as number) * 3, i2 = (input.indices[3 * t + 2] as number) * 3
        const w0v = P0[i0 + a] as number, w1v = P0[i1 + a] as number, w2v = P0[i2 + a] as number
        if (Math.max(w0v, w1v, w2v) - Math.min(w0v, w1v, w2v) <= 2 * 1e-9 * Math.max(map.extent, 1)) continue
        for (const k of sorted) reach = Math.max(reach, Math.max(P0[i0 + k] as number, P0[i1 + k] as number, P0[i2 + k] as number) - Math.min(P0[i0 + k] as number, P0[i1 + k] as number, P0[i2 + k] as number))
      }
      slices = Math.max(Math.ceil((reach * k1 * sf) / (4 * tol)), o.easing === 'smooth' ? Math.ceil(Math.sqrt((6 * umax * k1) / (8 * tol))) : 0)
    }
    slices = Math.max(1, slices)
  }
  const h = span / Math.max(slices, 1)
  const planeAt = (k: number): number => map.w0 + k * h
  const eps = 1e-9 * Math.max(map.extent, 1)

  const pos: number[] = Array.from(input.positions)
  const tri: number[] = []
  const lab: number[] | null = input.segments ? [] : null
  const owner: number[] = []
  const cutVertex = new Map<string, number>() // (edge, plane) -> vertex
  const crossing = (u: number, v: number, k: number): number => {
    const lo = Math.min(u, v), hi = Math.max(u, v)
    const key = `${lo}:${hi}:${k}`
    let id = cutVertex.get(key)
    if (id === undefined) {
      const wl = pos[3 * lo + a] as number, wh = pos[3 * hi + a] as number, t = (planeAt(k) - wl) / (wh - wl)
      id = pos.length / 3
      pos.push((pos[3 * lo] as number) + t * ((pos[3 * hi] as number) - (pos[3 * lo] as number)), (pos[3 * lo + 1] as number) + t * ((pos[3 * hi + 1] as number) - (pos[3 * lo + 1] as number)), (pos[3 * lo + 2] as number) + t * ((pos[3 * hi + 2] as number) - (pos[3 * lo + 2] as number)))
      pos[3 * id + a] = planeAt(k) // exactly on the plane
      cutVertex.set(key, id)
    }
    return id
  }
  // the planes strictly between two heights
  const between = (wa: number, wb: number): [number, number] => {
    if (slices === 0 || wb - wa <= 2 * eps) return [1, 0]
    const k0 = Math.floor((wa + eps - map.w0) / h) + 1, k1 = Math.ceil((wb - eps - map.w0) / h) - 1
    return [Math.max(k0, 0), Math.min(k1, slices)]
  }
  let planned = 0
  const nt0r = input.indices
  for (let t = 0; t < nt0; t++) {
    const ws = [0, 1, 2].map(i => P0[3 * (nt0r[3 * t + i] as number) + a] as number)
    const [k0, k1] = between(Math.min(...ws), Math.max(...ws))
    planned += k1 >= k0 ? 2 * (k1 - k0 + 1) + 1 : 1
  }
  if (planned > o.maxTriangles) throw new MeshError('deform.too_heavy', { triangles: planned, limit: o.maxTriangles })

  const emit = (t: number, p: number, q: number, r: number, nx: number, ny: number, nz: number): void => {
    const ux = (pos[3 * q] as number) - (pos[3 * p] as number), uy = (pos[3 * q + 1] as number) - (pos[3 * p + 1] as number), uz = (pos[3 * q + 2] as number) - (pos[3 * p + 2] as number)
    const vx = (pos[3 * r] as number) - (pos[3 * p] as number), vy = (pos[3 * r + 1] as number) - (pos[3 * p + 1] as number), vz = (pos[3 * r + 2] as number) - (pos[3 * p + 2] as number)
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx
    if (cx * cx + cy * cy + cz * cz < 1e-24) return // no area
    if (cx * nx + cy * ny + cz * nz >= 0) tri.push(p, q, r); else tri.push(p, r, q)
    lab?.push(input.segments!.labels[t] as number); owner.push(t)
  }
  for (let t = 0; t < nt0; t++) {
    if ((t & 0x3fff) === 0) { if (o.signal?.aborted) throw new MeshError('run.cancelled'); o.onProgress?.(0.8 * (t / nt0)) }
    const v0 = nt0r[3 * t] as number, v1 = nt0r[3 * t + 1] as number, v2 = nt0r[3 * t + 2] as number
    const w = (v: number): number => pos[3 * v + a] as number
    const [lo, mi, hi] = [v0, v1, v2].sort((x, y) => w(x) - w(y) || x - y) as [number, number, number]
    // the original normal decides the orientation of every piece
    const ax = (P0[3 * v1] as number) - (P0[3 * v0] as number), ay = (P0[3 * v1 + 1] as number) - (P0[3 * v0 + 1] as number), az = (P0[3 * v1 + 2] as number) - (P0[3 * v0 + 2] as number)
    const bx = (P0[3 * v2] as number) - (P0[3 * v0] as number), by = (P0[3 * v2 + 1] as number) - (P0[3 * v0 + 1] as number), bz = (P0[3 * v2 + 2] as number) - (P0[3 * v0 + 2] as number)
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx
    const [k0, k1] = between(w(lo), w(hi))
    if (k1 < k0) { tri.push(v0, v1, v2); lab?.push(input.segments!.labels[t] as number); owner.push(t); continue }
    // the two chains from lo to hi: A along the long edge, B along lo-mi-hi
    const A: number[] = [lo], B: number[] = [lo]
    for (let k = k0; k <= k1; k++) A.push(crossing(lo, hi, k))
    for (let k = k0; k <= k1; k++) if (planeAt(k) < w(mi) - eps) B.push(crossing(lo, mi, k))
    B.push(mi)
    for (let k = k0; k <= k1; k++) if (planeAt(k) > w(mi) + eps) B.push(crossing(mi, hi, k))
    A.push(hi); B.push(hi)
    let i = 0, j = 0
    while (i < A.length - 1 || j < B.length - 1) {
      const nextA = i < A.length - 1 ? w(A[i + 1] as number) : Infinity, nextB = j < B.length - 1 ? w(B[j + 1] as number) : Infinity
      if (nextB <= nextA) { emit(t, A[i] as number, B[j] as number, B[j + 1] as number, nx, ny, nz); j++ } else { emit(t, A[i] as number, B[j] as number, A[i + 1] as number, nx, ny, nz); i++ }
    }
  }
  const rounds = slices, unresolved = 0

  // apply the map
  const nv = pos.length / 3
  const out = new Float64Array(pos.length)
  let maxDisp = 0, minJ = Infinity, maxStretch = 1, worst = 0, worstS = 0
  for (let v = 0; v < nv; v++) {
    if ((v & 0xffff) === 0 && o.signal?.aborted) throw new MeshError('run.cancelled')
    const x = pos[3 * v] as number, y = pos[3 * v + 1] as number, z = pos[3 * v + 2] as number
    map.F(x, y, z, out, 3 * v)
    maxDisp = Math.max(maxDisp, Math.hypot((out[3 * v] as number) - x, (out[3 * v + 1] as number) - y, (out[3 * v + 2] as number) - z))
    const w = [x, y, z][a] as number
    if (map.jac) {
      // a bend: the Jacobian is 1 - k d, so a surface line is stretched by it (outside) or squeezed by it (inside)
      const j = map.jac(x, y, z)
      if (j < minJ) { minJ = j; worstS = Math.max(worstS, 1 / Math.max(j, 1e-9)); worst = (w - map.wMin) / map.extent }
      const st = Math.max(j, 1 / Math.max(j, 1e-9))
      if (st > maxStretch) maxStretch = st
      continue
    }
    minJ = Math.min(minJ, map.jacobian(w))
    const r = Math.hypot(([x, y, z][cyc[0]] as number) - (o.center[cyc[0]] as number), ([x, y, z][cyc[1]] as number) - (o.center[cyc[1]] as number))
    const s = o.kind === 'twist' ? map.stretch(w, r) : 1
    if (s > worstS) { worstS = s; worst = (w - map.wMin) / map.extent }
    if (s > maxStretch) maxStretch = s
  }
  const shape = minJ < Infinity ? minJ : 1
  if ((o.kind === 'taper' || o.kind === 'bend') && shape <= 1e-9) throw new MeshError('deform.folds', { at: Math.round(worst * 100) / 100 })
  if (o.kind === 'taper') { worst = 1 }

  // groups: every child follows its parent, so a group's new range is the children of its old triangles
  let groups: MeshGroup[] | undefined
  if (input.groups && input.groups.length > 0) {
    const first = new Int32Array(nt0).fill(-1), cnt = new Int32Array(nt0)
    owner.forEach((p, i) => { if (first[p] === -1) first[p] = i; cnt[p]!++ })
    groups = input.groups.map(g => {
      let start = -1, count = 0
      for (let t = g.start; t < g.start + g.count; t++) { if (start === -1) start = first[t] as number; count += cnt[t] as number }
      return { ...g, start: Math.max(0, start), count }
    })
  }
  const mesh: Mesh = { positions: out, indices: Uint32Array.from(tri), ...(groups ? { groups } : {}), ...(input.segments && lab ? { segments: { labels: Uint16Array.from(lab as number[]), table: input.segments.table.map(s => ({ ...s })) } } : {}) }
  o.onProgress?.(1)
  return { mesh, before: nt0, after: tri.length / 3, rounds, tolerance: tol, maxDisplacement: maxDisp, minJacobian: shape, maxStretch, unresolved, worst: Math.min(1, Math.max(0, worst)), identity }
}

/** Volume change of the deformed mesh relative to the original, in percent (null when the original encloses no volume). */
export function deformVolumeChange(before: Mesh, after: Mesh): number | null {
  const v0 = measureMesh(before).volume, v1 = measureMesh(after).volume
  return v0 > 1e-9 ? ((v1 - v0) / v0) * 100 : null
}

/** The groups of the refined mesh: every child follows its parent, so a group's new range is the children of its old triangles (`owner[i]` is the parent of triangle i). */
export function remapGroups(input: Mesh, owner: ArrayLike<number>, nt0: number): MeshGroup[] | undefined {
  if (!input.groups || input.groups.length === 0) return undefined
  const first = new Int32Array(nt0).fill(-1), cnt = new Int32Array(nt0)
  for (let i = 0; i < owner.length; i++) { const p = owner[i] as number; if (first[p] === -1) first[p] = i; cnt[p]!++ }
  return input.groups.map(g => {
    let start = -1, count = 0
    for (let t = g.start; t < g.start + g.count; t++) { if (start === -1) start = first[t] as number; count += cnt[t] as number }
    return { ...g, start: Math.max(0, start), count }
  })
}
