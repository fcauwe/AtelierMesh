// auto_orient: score candidate ways to put the part on the bed and report the best as `rotate` parameters.
// Candidates: the six axis directions, plus the larger flat faces of the part (faces whose normals agree within one degree).
import type { Mesh } from '@ateliermesh/core'
import { identity, rotation } from './geometry'
import type { Matrix } from './geometry'
import { overhangForUp } from './overhang'
import type { OverhangResult } from './overhang'

type V3 = [number, number, number]
export type OrientGoal = 'min_support' | 'min_height' | 'max_stability'

export interface Candidate {
  /** The direction, in the mesh's own frame, that becomes "up". */
  up: V3
  /** Area of the flat face that suggested this candidate, mm²; null for the six axis candidates. */
  flat_area: number | null
  /** `rotate` angles (degrees, order XYZ) that bring `up` to +Z. */
  angles: V3
  overhang_area: number
  base_area: number
  height: number
  com_height: number | null
}

const AXES: V3[] = [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]]
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const COS_1DEG = Math.cos(Math.PI / 180)

/** Rotation matrix taking the unit vector `u` to +Z (Rodrigues). */
function toUp(u: V3): Matrix {
  const c = u[2]
  if (c > 1 - 1e-12) return identity()
  if (c < -1 + 1e-12) return rotation('X', 180)
  const ax = u[1], ay = -u[0] // axis = u x z, with z = (0,0,1)
  const n = Math.hypot(ax, ay), x = ax / n, y = ay / n
  const s = n, k = 1 - c
  return [c + x * x * k, x * y * k, y * s, 0, x * y * k, c + y * y * k, -x * s, 0, -y * s, x * s, c, 0, 0, 0, 0, 1]
}

/** Angles (degrees) such that rotating about world X, then Y, then Z gives the matrix: R = Rz Ry Rx. */
export function anglesXYZ(m: Matrix): V3 {
  const r = (i: number, j: number): number => m[4 * i + j] as number
  const sy = -r(2, 0)
  const beta = Math.asin(Math.max(-1, Math.min(1, sy)))
  const cb = Math.cos(beta)
  let alpha: number, gamma: number
  if (Math.abs(cb) > 1e-9) { alpha = Math.atan2(r(2, 1), r(2, 2)); gamma = Math.atan2(r(1, 0), r(0, 0)) }
  else { gamma = 0; alpha = Math.atan2(-r(1, 2), r(1, 1)) } // gimbal lock: put the whole turn in X
  const deg = (x: number): number => { const d = (x * 180) / Math.PI; return Math.abs(d) < 1e-9 ? 0 : Math.round(d * 1e9) / 1e9 }
  return [deg(alpha), deg(beta), deg(gamma)]
}

function flatFaces(mesh: Mesh, limit: number): Array<{ n: V3; area: number }> {
  const P = mesh.positions, T = mesh.indices
  const faces: Array<{ n: V3; area: number; w: V3 }> = []
  const tris: Array<{ n: V3; area: number }> = []
  for (let t = 0; t < T.length; t += 3) {
    const a = 3 * (T[t] as number), b = 3 * (T[t + 1] as number), c = 3 * (T[t + 2] as number)
    const ux = (P[b] as number) - (P[a] as number), uy = (P[b + 1] as number) - (P[a + 1] as number), uz = (P[b + 2] as number) - (P[a + 2] as number)
    const vx = (P[c] as number) - (P[a] as number), vy = (P[c + 1] as number) - (P[a + 1] as number), vz = (P[c + 2] as number) - (P[a + 2] as number)
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz)
    if (len > 0) tris.push({ n: [nx / len, ny / len, nz / len], area: len / 2 })
  }
  tris.sort((p, q) => q.area - p.area)
  for (const tr of tris) {
    const f = faces.find(g => dot(g.n, tr.n) > COS_1DEG)
    if (f) { f.area += tr.area; f.w = [f.w[0] + tr.n[0] * tr.area, f.w[1] + tr.n[1] * tr.area, f.w[2] + tr.n[2] * tr.area] }
    else faces.push({ n: tr.n, area: tr.area, w: [tr.n[0] * tr.area, tr.n[1] * tr.area, tr.n[2] * tr.area] })
  }
  return faces.sort((p, q) => q.area - p.area).slice(0, limit).map(f => { const l = Math.hypot(...f.w); return { n: [f.w[0] / l, f.w[1] / l, f.w[2] / l], area: f.area } })
}

export function orientCandidates(mesh: Mesh, count: number, overhangAngle: number): Candidate[] {
  const ups: Array<{ up: V3; flat: number | null }> = AXES.map(up => ({ up, flat: null }))
  for (const f of flatFaces(mesh, Math.max(0, count) + 6)) {
    if (ups.length >= Math.max(6, count)) break
    const up: V3 = [-f.n[0], -f.n[1], -f.n[2]] // the face goes down, so its outward normal points down
    const same = ups.find(u => dot(u.up, up) > Math.cos(0.5 * Math.PI / 180))
    if (same) { if (same.flat === null) same.flat = f.area; continue }
    ups.push({ up, flat: f.area })
  }
  return ups.map(({ up, flat }) => {
    const r: OverhangResult = overhangForUp(mesh, up, overhangAngle)
    return { up, flat_area: flat, angles: anglesXYZ(toUp(up)), overhang_area: r.area, base_area: r.bed_area, height: r.height, com_height: r.com_height }
  })
}

/** The six axis directions only (no flat-face search, so it is O(triangles)): what the printability check uses for its turn advice. */
export function axisCandidates(mesh: Mesh, overhangAngle: number): Candidate[] {
  return AXES.map(up => {
    const r: OverhangResult = overhangForUp(mesh, up, overhangAngle)
    return { up, flat_area: null, angles: anglesXYZ(toUp(up)), overhang_area: r.area, base_area: r.bed_area, height: r.height, com_height: r.com_height }
  })
}

/** Index of the best candidate for a goal. Ties are broken by the other measures, then by order, so the answer is stable. */
export function bestCandidate(c: Candidate[], goal: OrientGoal): number {
  const eps = (a: number, b: number): number => (Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b)) ? 0 : a - b)
  const keys: Array<(x: Candidate) => number> =
    goal === 'min_support' ? [x => x.overhang_area, x => x.height, x => -x.base_area]
    : goal === 'min_height' ? [x => x.height, x => x.overhang_area, x => -x.base_area]
    : [x => -x.base_area, x => x.com_height ?? Infinity, x => x.overhang_area]
  let best = 0
  for (let i = 1; i < c.length; i++) {
    for (const k of keys) { const d = eps(k(c[i] as Candidate), k(c[best] as Candidate)); if (d < 0) { best = i; break } if (d > 0) break }
  }
  return best
}

