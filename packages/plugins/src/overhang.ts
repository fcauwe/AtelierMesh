// The shared overhang measure (SPEC section 5A.3): the area of the surface that faces downward beyond an angle, for a given way up.
// A way up is a unit vector `up` in the mesh's own frame. A triangle with outward normal n needs support when it faces down more
// steeply than the limit: -n.up > sin(angle). A face lying on the bed is not an overhang. Pure geometry, no printer data.
import type { Mesh } from '@ateliermesh/core'
import { volumeCentroid } from './geometry'

export interface OverhangResult {
  /** Area that needs support, mm². */
  area: number
  /** Total surface area, mm². */
  surface: number
  /** Area of the faces that lie on the bed (all three vertices at the lowest height). */
  bed_area: number
  /** Lowest to highest point along `up`, mm. */
  height: number
  /** Height of the centre of mass above the bed, mm; null for a mesh that encloses no volume. */
  com_height: number | null
  /** Number of triangles that need support. */
  count: number
  /** Per-triangle flags (1 = needs support), only when asked for. */
  flags?: Uint8Array
}

export function overhangForUp(mesh: Mesh, up: [number, number, number], angleDeg: number, opts: { flags?: boolean } = {}): OverhangResult {
  const P = mesh.positions, T = mesh.indices
  const nt = T.length / 3
  const limit = Math.sin((angleDeg * Math.PI) / 180) + 1e-9
  const h = new Float64Array(P.length / 3)
  let lo = Infinity, hi = -Infinity
  for (let v = 0; v < h.length; v++) {
    h[v] = (P[3 * v] as number) * up[0] + (P[3 * v + 1] as number) * up[1] + (P[3 * v + 2] as number) * up[2]
    if ((h[v] as number) < lo) lo = h[v] as number
    if ((h[v] as number) > hi) hi = h[v] as number
  }
  const tol = 1e-9 + 1e-7 * Math.max(1, hi - lo)
  const flags = opts.flags ? new Uint8Array(nt) : undefined
  let area = 0, surface = 0, bed = 0, count = 0
  for (let t = 0; t < nt; t++) {
    const a = T[3 * t] as number, b = T[3 * t + 1] as number, c = T[3 * t + 2] as number
    const ax = P[3 * a] as number, ay = P[3 * a + 1] as number, az = P[3 * a + 2] as number
    const ux = (P[3 * b] as number) - ax, uy = (P[3 * b + 1] as number) - ay, uz = (P[3 * b + 2] as number) - az
    const vx = (P[3 * c] as number) - ax, vy = (P[3 * c + 1] as number) - ay, vz = (P[3 * c + 2] as number) - az
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz)
    if (len === 0) continue
    const tri = len / 2
    surface += tri
    const down = -(nx * up[0] + ny * up[1] + nz * up[2]) / len
    const onBed = (h[a] as number) <= lo + tol && (h[b] as number) <= lo + tol && (h[c] as number) <= lo + tol
    if (onBed) { bed += tri; continue }
    if (down > limit) { area += tri; count++; if (flags) flags[t] = 1 }
  }
  const com = volumeCentroid(mesh)
  const comH = com ? com[0] * up[0] + com[1] * up[1] + com[2] * up[2] - lo : null
  return { area, surface, bed_area: bed, height: hi - lo, com_height: comH, count, ...(flags ? { flags } : {}) }
}

/** Flag runs `[start, length]` of consecutive flagged triangles: a compact form for a report. */
export function flagRuns(flags: Uint8Array, maxRuns = 4000): { runs: Array<[number, number]>; truncated: boolean } {
  const runs: Array<[number, number]> = []
  for (let i = 0; i < flags.length; ) {
    if (!flags[i]) { i++; continue }
    let j = i
    while (j < flags.length && flags[j]) j++
    if (runs.length >= maxRuns) return { runs, truncated: true }
    runs.push([i, j - i]); i = j
  }
  return { runs, truncated: false }
}

/** Triangle indices from runs. */
export function expandRuns(runs: Array<[number, number]>): number[] {
  const out: number[] = []
  for (const [s, n] of runs) for (let k = 0; k < n; k++) out.push(s + k)
  return out
}
