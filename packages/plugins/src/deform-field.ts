// Wave and ripple: a displacement field applied to the vertices of the mesh, after the mesh is cut fine enough to follow it.
//
//   wave    every point moves by  f(u) * direction,   f(u) = A * fade(u) * sin(2 pi (u - u0) / lambda + phi)
//           u is the position along the travel axis, u0 the start of the range [from, to] of the model along it, `direction` an axis or the surface normal.
//   ripple  every point moves along the axis by  g(r) = A * decay(r) * edge(r) * sin(2 pi r / lambda + phi),
//           r the distance from the centre measured in the cross-section (the two coordinates that are not the axis).
//           decay(r) = exp(-r / decay) (1 without decay), edge(r) fades to 0 over the last quarter of `radius`.
//
// A displacement along an axis that does not depend on the position along that axis is a shear: it is one-to-one, volume preserving and leaves
// the thickness of a plate as it is, so a closed solid stays a closed solid and cannot cross itself. A wave that moves points along its own travel
// axis is not a shear (its Jacobian is 1 + f'(u)); that case is refused when the wave would fold the model (A * 2 pi / lambda >= 1). A displacement
// along the surface normal is not a shear either; it warns when the amplitude is large against the smallest side of the model.
//
// Refinement. The mesh is refined by splitting edges at their midpoints in rounds (an edge that is marked is split in every triangle that has it,
// so the mesh stays conforming; a triangle with one, two or three marked edges becomes two, three or four triangles). An edge is marked when it is
// longer than the longest edge that follows the field within the tolerance: a chord of a sine of amplitude A and wave number k = 2 pi / lambda
// that spans a length d sags by A * k^2 * d^2 / 8 from the curve, so
//       d_max = min( sqrt(8 * tolerance / (A * k^2)), lambda / 16 )         (times 0.5 fine, 0.25 extra fine, 2 coarse)
// and an edge is split when it is longer than 1.5 times that (halving in rounds would overshoot by up to 2 times, and the sag grows with the square).
// For the wave only the extent of the edge along the travel axis counts (an edge across the wave moves rigidly); for the ripple the length in the
// cross-section counts, and A is the largest amplitude the edge can meet (decay and radius taken into account; an edge where the ripple is smaller
// than a quarter of the tolerance is not split). Within one wavelength of the centre the edges are half as long (the ripple has a cone there).
// Children follow their parent in the list, so mesh groups keep contiguous ranges and every child keeps its parent's segment label.
import { MeshError, measureMesh } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'
import { remapGroups } from './deform'
import type { Axis, Detail } from './deform'

export interface FieldOptions {
  kind: 'wave' | 'ripple'
  /** Wave: the axis the wave travels along. Ripple: the axis the points move along (the ripples lie in the other two coordinates). */
  axis: Axis
  /** Wave: the direction of the displacement. */
  direction: Axis | 'normal'
  /** Ripple: the centre of the rings in the cross-section. */
  center: [number, number, number]
  wavelength: number
  amplitude: number
  /** Degrees. */
  phase: number
  /** Wave: the range of the model along the axis (0..1) in which the wave runs, and the length over which it fades in and out at the ends of that range. */
  from: number
  to: number
  falloff: number
  /** Ripple: amplitude falls as exp(-r / decay); 0 = no decay. */
  decay: number
  /** Ripple: the rings stop at this distance from the centre (a soft edge over the last quarter); 0 = unlimited. */
  radius: number
  detail: Detail
  maxTriangles: number
  signal?: AbortSignal
  onProgress?: (f: number) => void
}

export interface FieldResult {
  mesh: Mesh
  before: number
  after: number
  rounds: number
  tolerance: number
  /** The longest edge (mm) the wave or ripple allows at its strongest. */
  edgeLimit: number
  maxDisplacement: number
  /** Smallest Jacobian of the map (1 for a shear). */
  minJacobian: number
  identity: boolean
}

const AX = { x: 0, y: 1, z: 2 } as const
const smoothstep = (t: number): number => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x) }
const DETAIL = { coarse: 2, auto: 1, fine: 0.5, extra_fine: 0.25 } as const
const MAX_ROUNDS = 40
/** An edge is split when it is longer than this many times the limit: halving an edge in rounds can overshoot the limit by a factor of two, and the sag only grows with the square (at most 2.25 times the tolerance). */
const SLACK = 1.5
const KEY = 67108864 // 2^26: an edge key is lo * KEY + hi

function bbox(P: ArrayLike<number>): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { const v = P[i + k] as number; if (v < (min[k] as number)) min[k] = v; if (v > (max[k] as number)) max[k] = v }
  return { min, max }
}

export function fieldMesh(input: Mesh, o: FieldOptions): FieldResult {
  const nt0 = input.indices.length / 3
  if (nt0 === 0 || input.positions.length === 0) throw new MeshError('deform.bad_input', { reason: 'empty_mesh' })
  const bb = bbox(input.positions)
  const size = [0, 1, 2].map(k => (bb.max[k] as number) - (bb.min[k] as number))
  const ext = Math.max(...size)
  // the sag of a chord may be 0.02 mm, or 2.5 % of the amplitude for a large wave (a sine cut at lambda / 16 sags by 1.9 % of its amplitude, so for a large amplitude the wavelength rule decides)
  const baseTol = Math.max(Math.min(0.02, 0.005 * ext), 0.025 * Math.abs(o.amplitude))
  const dfac = DETAIL[o.detail] ?? 1
  const a = AX[o.axis]
  const k = (2 * Math.PI) / o.wavelength
  const phase = (o.phase * Math.PI) / 180
  const A = o.amplitude
  const identity = A === 0
  const wave = o.kind === 'wave'

  const lo = bb.min[a] as number, hi = bb.max[a] as number, extent = Math.max(hi - lo, 1e-9)
  const u0 = lo + Math.min(o.from, o.to) * extent, u1 = lo + Math.max(o.from, o.to) * extent
  const eps = 1e-9 * Math.max(extent, 1)
  const cc: [number, number] = a === 0 ? [1, 2] : a === 1 ? [0, 2] : [0, 1] // the cross-section coordinates of a ripple
  const dirAxis = o.direction === 'normal' ? -1 : AX[o.direction]
  // the displacement as a function of the original point
  const fade = (u: number): number => {
    if (u < u0 - eps || u > u1 + eps) return 0
    return o.falloff > 0 ? smoothstep(Math.min(u - u0, u1 - u) / o.falloff) : 1
  }
  const ripple = (x: number, y: number, z: number): number => {
    const p = [x, y, z]
    const r = Math.hypot((p[cc[0]] as number) - (o.center[cc[0]] as number), (p[cc[1]] as number) - (o.center[cc[1]] as number))
    let g = A * Math.sin(k * r + phase)
    if (o.decay > 0) g *= Math.exp(-r / o.decay)
    if (o.radius > 0) g *= r >= o.radius ? 0 : smoothstep((o.radius - r) / (0.25 * o.radius))
    return g
  }
  const field = (x: number, y: number, z: number): number => (wave ? A * fade([x, y, z][a] as number) * Math.sin((k * (([x, y, z][a] as number) - u0)) + phase) : ripple(x, y, z))

  // ---- how long an edge may be
  const lamLimit = o.wavelength / 16
  const strongest = Math.sqrt((8 * baseTol) / Math.max(A * k * k, 1e-12))
  const edgeLimit = Math.max(o.wavelength / 512, dfac * Math.min(strongest, lamLimit))
  const P: number[] = Array.from(input.positions)
  const wantSplit = (p: number, q: number): boolean => {
    const ax = P[3 * p] as number, ay = P[3 * p + 1] as number, az = P[3 * p + 2] as number
    const bx = P[3 * q] as number, by = P[3 * q + 1] as number, bz = P[3 * q + 2] as number
    if (wave) {
      const ua = [ax, ay, az][a] as number, ub = [bx, by, bz][a] as number
      const du = Math.abs(ua - ub)
      if (Math.max(ua, ub) < u0 - eps || Math.min(ua, ub) > u1 + eps) return false // the wave does not reach this edge
      return du > edgeLimit * SLACK
    }
    const pa = [ax, ay, az], pb = [bx, by, bz]
    const len = Math.hypot((pa[cc[0]] as number) - (pb[cc[0]] as number), (pa[cc[1]] as number) - (pb[cc[1]] as number))
    if (len < 1e-12) return false
    const mx = ((pa[cc[0]] as number) + (pb[cc[0]] as number)) / 2 - (o.center[cc[0]] as number), my = ((pa[cc[1]] as number) + (pb[cc[1]] as number)) / 2 - (o.center[cc[1]] as number)
    const rmid = Math.hypot(mx, my), rnear = Math.max(0, rmid - len / 2)
    if (o.radius > 0 && rnear >= o.radius) return false
    const strength = A * (o.decay > 0 ? Math.exp(-rnear / o.decay) : 1)
    if (strength < 0.25 * baseTol) return false
    const lim = Math.max(o.wavelength / 512, dfac * Math.min(Math.sqrt((8 * baseTol) / Math.max(strength * k * k, 1e-12)), lamLimit)) * (rnear < o.wavelength ? 0.5 : 1)
    return len > lim * SLACK
  }

  let tri: number[] = Array.from(input.indices)
  let owner: number[] = Array.from({ length: nt0 }, (_, i) => i)
  let lab: number[] | null = input.segments ? Array.from(input.segments.labels) : null
  let rounds = 0
  if (!identity) {
    for (; rounds < MAX_ROUNDS; rounds++) {
      if (o.signal?.aborted) throw new MeshError('run.cancelled')
      o.onProgress?.(0.7 * (rounds / MAX_ROUNDS))
      const nt = tri.length / 3
      const mid = new Map<number, number>() // edge -> -1 (keep), -2 (marked), >= 0 (its midpoint vertex)
      const marked = (p: number, q: number): boolean => {
        const key = Math.min(p, q) * KEY + Math.max(p, q)
        let m = mid.get(key)
        if (m === undefined) { m = wantSplit(p, q) ? -2 : -1; mid.set(key, m) }
        return m !== -1
      }
      let total = 0, any = false
      for (let t = 0; t < nt; t++) {
        const v0 = tri[3 * t] as number, v1 = tri[3 * t + 1] as number, v2 = tri[3 * t + 2] as number
        const m = (marked(v0, v1) ? 1 : 0) + (marked(v1, v2) ? 1 : 0) + (marked(v2, v0) ? 1 : 0)
        total += 1 + m
        if (m > 0) any = true
      }
      if (!any) break
      if (total > o.maxTriangles) throw new MeshError('deform.too_heavy', { triangles: total, limit: o.maxTriangles })
      for (const [key, v] of mid) {
        if (v !== -2) continue
        const p = Math.floor(key / KEY), q = key - p * KEY
        const id = P.length / 3
        P.push(((P[3 * p] as number) + (P[3 * q] as number)) / 2, ((P[3 * p + 1] as number) + (P[3 * q + 1] as number)) / 2, ((P[3 * p + 2] as number) + (P[3 * q + 2] as number)) / 2)
        mid.set(key, id)
      }
      const mOf = (p: number, q: number): number => { const v = mid.get(Math.min(p, q) * KEY + Math.max(p, q)) as number; return v >= 0 ? v : -1 }
      const dist = (p: number, q: number): number => Math.hypot((P[3 * p] as number) - (P[3 * q] as number), (P[3 * p + 1] as number) - (P[3 * q + 1] as number), (P[3 * p + 2] as number) - (P[3 * q + 2] as number))
      const nTri: number[] = [], nOwn: number[] = [], nLab: number[] | null = lab ? [] : null
      const put = (t: number, x: number, y: number, z: number): void => { nTri.push(x, y, z); nOwn.push(owner[t] as number); nLab?.push(lab![t] as number) }
      for (let t = 0; t < nt; t++) {
        let a0 = tri[3 * t] as number, b0 = tri[3 * t + 1] as number, c0 = tri[3 * t + 2] as number
        let ma = mOf(a0, b0), mb = mOf(b0, c0), mc = mOf(c0, a0)
        const count = (ma >= 0 ? 1 : 0) + (mb >= 0 ? 1 : 0) + (mc >= 0 ? 1 : 0)
        if (count === 0) { put(t, a0, b0, c0); continue }
        // turn the triangle until the marked edges are the first ones: (a, b) for one, (a, b) and (b, c) for two
        for (let r = 0; r < 3; r++) {
          const ok = count === 1 ? ma >= 0 : count === 2 ? ma >= 0 && mb >= 0 : true
          if (ok) break;
          [a0, b0, c0, ma, mb, mc] = [b0, c0, a0, mb, mc, ma]
        }
        if (count === 1) { put(t, a0, ma, c0); put(t, ma, b0, c0) }
        else if (count === 2) {
          put(t, ma, b0, mb)
          if (dist(ma, c0) <= dist(a0, mb)) { put(t, a0, ma, c0); put(t, ma, mb, c0) } else { put(t, a0, ma, mb); put(t, a0, mb, c0) }
        } else { put(t, a0, ma, mc); put(t, ma, b0, mb); put(t, mc, mb, c0); put(t, ma, mb, mc) }
      }
      tri = nTri; owner = nOwn; lab = nLab
    }
  }

  // ---- the displacement
  const nv = P.length / 3
  const out = new Float64Array(P.length)
  let normals: Float64Array | null = null
  if (wave && o.direction === 'normal' && !identity) {
    normals = new Float64Array(P.length)
    for (let t = 0; t < tri.length / 3; t++) {
      const p = tri[3 * t] as number, q = tri[3 * t + 1] as number, r = tri[3 * t + 2] as number
      const ux = (P[3 * q] as number) - (P[3 * p] as number), uy = (P[3 * q + 1] as number) - (P[3 * p + 1] as number), uz = (P[3 * q + 2] as number) - (P[3 * p + 2] as number)
      const vx = (P[3 * r] as number) - (P[3 * p] as number), vy = (P[3 * r + 1] as number) - (P[3 * p + 1] as number), vz = (P[3 * r + 2] as number) - (P[3 * p + 2] as number)
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx // the length is twice the area: the weight
      for (const v of [p, q, r]) { normals[3 * v]! += nx; normals[3 * v + 1]! += ny; normals[3 * v + 2]! += nz }
    }
    for (let v = 0; v < nv; v++) { const l = Math.hypot(normals[3 * v] as number, normals[3 * v + 1] as number, normals[3 * v + 2] as number) || 1; normals[3 * v]! /= l; normals[3 * v + 1]! /= l; normals[3 * v + 2]! /= l }
  }
  let maxDisp = 0
  for (let v = 0; v < nv; v++) {
    if ((v & 0xffff) === 0 && o.signal?.aborted) throw new MeshError('run.cancelled')
    const x = P[3 * v] as number, y = P[3 * v + 1] as number, z = P[3 * v + 2] as number
    const f = identity ? 0 : field(x, y, z)
    out[3 * v] = x; out[3 * v + 1] = y; out[3 * v + 2] = z
    if (f !== 0) {
      if (wave && normals) { out[3 * v] = x + f * (normals[3 * v] as number); out[3 * v + 1] = y + f * (normals[3 * v + 1] as number); out[3 * v + 2] = z + f * (normals[3 * v + 2] as number) }
      else out[3 * v + (wave ? dirAxis : a)] = ([x, y, z][wave ? dirAxis : a] as number) + f
      maxDisp = Math.max(maxDisp, Math.abs(f))
    }
  }
  // a wave along its own axis is not a shear: it folds where 1 + f'(u) reaches 0
  const longitudinal = wave && dirAxis === a
  const minJ = longitudinal && !identity ? 1 - A * k : 1
  if (longitudinal && minJ <= 1e-9) throw new MeshError('deform.folds', { at: 0 })
  o.onProgress?.(1)

  if (identity) return { mesh: input, before: nt0, after: nt0, rounds: 0, tolerance: baseTol, edgeLimit, maxDisplacement: 0, minJacobian: 1, identity: true }
  const groups = remapGroups(input, owner, nt0)
  const mesh: Mesh = { positions: out, indices: Uint32Array.from(tri), ...(groups ? { groups } : {}), ...(input.segments && lab ? { segments: { labels: Uint16Array.from(lab), table: input.segments.table.map(s => ({ ...s })) } } : {}) }
  return { mesh, before: nt0, after: tri.length / 3, rounds, tolerance: baseTol, edgeLimit, maxDisplacement: maxDisp, minJacobian: minJ, identity: false }
}

/** Volume change of the displaced mesh relative to the original, in percent (null when the original encloses no volume). */
export function fieldVolumeChange(before: Mesh, after: Mesh): number | null {
  const v0 = measureMesh(before).volume, v1 = measureMesh(after).volume
  return v0 > 1e-9 ? ((v1 - v0) / v0) * 100 : null
}
