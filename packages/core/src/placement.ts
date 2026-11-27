// Limits on where and how a customer may move something the designer placed (SPEC section 5A.7, `limits`).
// The designer's placement carries `limits`; a customer's placement is checked against the designer's, and may be clamped into it.
import type { StructuredError } from './errors'
import type { Step } from './stack'
import type { Vec3 } from './types'

export interface PlacementLimits {
  /** Farthest the anchor may move from the designer's anchor, millimetres in a straight line. */
  max_distance?: number
  /** Allowed direction, degrees, `[min, max]`, within -180 to 180. */
  direction?: [number, number]
  /** Allowed value of the size parameter, `[min, max]`. */
  size?: [number, number]
  /** Which parameter `size` limits. Default `size`. */
  size_param?: string
}

export interface PlacementValue {
  /**
   * The cumulative matrix of all earlier steps at the moment the placement was made (16 numbers, row-major, as the transform steps
   * report them). A host that follows earlier steps (see `followEarlierSteps`) moves the anchor by what those steps do now compared
   * with then, so a resize or a rotation before this step does not make the text jump.
   */
  frame?: number[]
  anchor: { point: Vec3; normal: Vec3; tri?: number; bary?: Vec3; fingerprint?: string }
  up_ref?: 'x' | 'y' | 'z'
  direction?: number
  offset?: [number, number]
  align?: { h: 'left' | 'center' | 'right'; v: 'baseline' | 'middle' }
  limits?: PlacementLimits
}

export const isPlacement = (v: unknown): v is PlacementValue => typeof v === 'object' && v !== null && typeof (v as PlacementValue).anchor === 'object'

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const off = (p: PlacementValue): [number, number] => p.offset ?? [0, 0]
/** How far the content has moved: the anchor's straight-line move plus the shift on the map. A shift is a move too, so it cannot be used to get around the limit. */
export function placementTravel(base: PlacementValue, proposed: PlacementValue): number {
  return dist(base.anchor.point, proposed.anchor.point) + Math.hypot(off(proposed)[0] - off(base)[0], off(proposed)[1] - off(base)[1])
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Structural check of the `limits` object itself (used by the placement check in validate.ts). Returns the bad field or null. */
export function badLimitsField(l: unknown): string | null {
  if (l === undefined) return null
  if (typeof l !== 'object' || l === null || Array.isArray(l)) return 'limits'
  const o = l as Record<string, unknown>
  const pair = (v: unknown, lo: number, hi: number): boolean => Array.isArray(v) && v.length === 2 && v.every(x => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi) && (v[0] as number) <= (v[1] as number)
  if (o['max_distance'] !== undefined && !(typeof o['max_distance'] === 'number' && Number.isFinite(o['max_distance']) && o['max_distance'] >= 0)) return 'limits.max_distance'
  if (o['direction'] !== undefined && !pair(o['direction'], -180, 180)) return 'limits.direction'
  if (o['size'] !== undefined && !pair(o['size'], 0, 1e6)) return 'limits.size'
  if (o['size_param'] !== undefined && !(typeof o['size_param'] === 'string' && /^[a-z][a-z0-9_]*$/.test(o['size_param']))) return 'limits.size_param'
  return null
}

/**
 * Problems with a customer's placement compared with the designer's. The limits belong to the designer: a customer who changes them
 * is refused. `sizeValue` is the customer's value of the size parameter, when the designer limited it.
 */
export function checkPlacementLimits(base: PlacementValue, proposed: PlacementValue, sizeValue?: number): StructuredError[] {
  const errors: StructuredError[] = []
  const lim = base.limits
  if (!same(proposed.limits, lim)) errors.push({ code: 'placement.limits_changed' })
  if (!lim) return errors
  if (lim.max_distance !== undefined) {
    const d = placementTravel(base, proposed)
    if (d > lim.max_distance + 1e-9) errors.push({ code: 'placement.too_far', params: { distance: d, max: lim.max_distance } })
  }
  if (lim.direction) {
    const a = proposed.direction ?? 0
    if (a < lim.direction[0] - 1e-9 || a > lim.direction[1] + 1e-9) errors.push({ code: 'placement.direction_out_of_range', params: { direction: a, min: lim.direction[0], max: lim.direction[1] } })
  }
  if (lim.size && sizeValue !== undefined && (sizeValue < lim.size[0] - 1e-9 || sizeValue > lim.size[1] + 1e-9)) {
    errors.push({ code: 'placement.size_out_of_range', params: { size: sizeValue, min: lim.size[0], max: lim.size[1] } })
  }
  return errors
}

/** The nearest placement inside the designer's limits: the anchor is pulled back towards the designer's, the direction is clamped. */
export function clampPlacementToLimits(base: PlacementValue, proposed: PlacementValue): PlacementValue {
  const lim = base.limits
  const out: PlacementValue = { ...proposed, ...(lim ? { limits: lim } : {}) }
  if (!lim) return out
  if (lim.max_distance !== undefined) {
    const d = dist(base.anchor.point, proposed.anchor.point)
    if (d > lim.max_distance && d > 0) {
      // too far already: pull the anchor back along the line to the designer's, and drop any extra shift
      const k = lim.max_distance / d, b = base.anchor.point, p = proposed.anchor.point
      out.anchor = { ...proposed.anchor, point: [b[0] + (p[0] - b[0]) * k, b[1] + (p[1] - b[1]) * k, b[2] + (p[2] - b[2]) * k] }
      delete out.anchor.tri; delete out.anchor.bary // the point moved, so the triangle hint no longer applies
      out.offset = off(base)
    } else {
      const extra = Math.hypot(off(proposed)[0] - off(base)[0], off(proposed)[1] - off(base)[1]), room = lim.max_distance - d
      if (extra > room && extra > 0) { const k = Math.max(0, room) / extra; out.offset = [off(base)[0] + (off(proposed)[0] - off(base)[0]) * k, off(base)[1] + (off(proposed)[1] - off(base)[1]) * k] }
    }
  }
  if (lim.direction) out.direction = Math.min(lim.direction[1], Math.max(lim.direction[0], proposed.direction ?? 0))
  return out
}

// ------------------------------------------------------------------ the reading frame

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm3 = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l] }

export interface ReadingFrame { ex: Vec3; ey: Vec3; n: Vec3; fallback: boolean }

/**
 * The reading direction `ex` and the up direction `ey` of content placed on a surface with normal `n`: `upRef` is the world axis that should
 * point up (projected onto the surface), `deg` turns the content about the normal. When the normal is parallel to `upRef` the horizontal is
 * undefined: the frame falls back to world Y and says so.
 */
export function readingFrame(n: Vec3, upRef: Vec3 = [0, 0, 1], deg = 0): ReadingFrame {
  let up = sub3(upRef, scale3(n, dot3(upRef, n)))
  let fallback = false
  if (Math.hypot(up[0], up[1], up[2]) < 1e-6) { up = sub3([0, 1, 0], scale3(n, n[1])); fallback = true }
  up = norm3(up)
  const ex = norm3(cross3(up, n)), ey = up
  const th = (deg * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th)
  const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
  return { ex: add(scale3(ex, c), scale3(ey, s)), ey: add(scale3(ey, c), scale3(ex, -s)), n, fallback }
}

const upRefAxis = (r: 'x' | 'y' | 'z' | undefined): Vec3 => (r === 'x' ? [1, 0, 0] : r === 'y' ? [0, 1, 0] : [0, 0, 1])

// ------------------------------------------------------------------ following earlier steps

export type Mat4 = number[]
export const IDENTITY4: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

export function mul4(a: Mat4, b: Mat4): Mat4 {
  const r = new Array<number>(16).fill(0)
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += (a[4 * i + k] as number) * (b[4 * k + j] as number); r[4 * i + j] = s }
  return r
}

/** Inverse of an affine matrix (last row 0 0 0 1). Null when the matrix is singular. */
export function invert4(m: Mat4): Mat4 | null {
  const a = m[0] as number, b = m[1] as number, c = m[2] as number, d = m[4] as number, e = m[5] as number, f = m[6] as number, g = m[8] as number, h = m[9] as number, i = m[10] as number
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  if (Math.abs(det) < 1e-12) return null
  const r = [
    (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ]
  const tx = m[3] as number, ty = m[7] as number, tz = m[11] as number
  return [
    r[0] as number, r[1] as number, r[2] as number, -((r[0] as number) * tx + (r[1] as number) * ty + (r[2] as number) * tz),
    r[3] as number, r[4] as number, r[5] as number, -((r[3] as number) * tx + (r[4] as number) * ty + (r[5] as number) * tz),
    r[6] as number, r[7] as number, r[8] as number, -((r[6] as number) * tx + (r[7] as number) * ty + (r[8] as number) * tz),
    0, 0, 0, 1,
  ]
}

const isMat4 = (v: unknown): v is Mat4 => Array.isArray(v) && v.length === 16 && v.every(x => typeof x === 'number' && Number.isFinite(x))

/** The matrix of every step before `index` multiplied in order, taken from the `matrix` each transform step reports. */
export function cumulativeMatrix(results: ReadonlyArray<{ report?: Record<string, unknown>; status?: string } | undefined>, index: number): Mat4 {
  let m = IDENTITY4
  for (let k = 0; k < index; k++) {
    const r = results[k]
    const step = r?.report?.['matrix']
    if (r && r.status !== 'disabled' && isMat4(step)) m = mul4(step, m)
  }
  return m
}

/** Move a placement by a matrix: the anchor point, and the normal by the inverse transpose of the linear part. Limits, direction and offset stay. */
export function transformPlacement(p: PlacementValue, m: Mat4): PlacementValue {
  const [x, y, z] = p.anchor.point
  const point: Vec3 = [(m[0] as number) * x + (m[1] as number) * y + (m[2] as number) * z + (m[3] as number), (m[4] as number) * x + (m[5] as number) * y + (m[6] as number) * z + (m[7] as number), (m[8] as number) * x + (m[9] as number) * y + (m[10] as number) * z + (m[11] as number)]
  const inv = invert4(m)
  const [nx, ny, nz] = p.anchor.normal
  let n: Vec3 = [nx, ny, nz]
  if (inv) n = [(inv[0] as number) * nx + (inv[4] as number) * ny + (inv[8] as number) * nz, (inv[1] as number) * nx + (inv[5] as number) * ny + (inv[9] as number) * nz, (inv[2] as number) * nx + (inv[6] as number) * ny + (inv[10] as number) * nz]
  const l = Math.hypot(n[0], n[1], n[2]) || 1
  const normal: Vec3 = [n[0] / l, n[1] / l, n[2] / l]
  const anchor = { ...p.anchor, point, normal }
  delete anchor.tri; delete anchor.bary; delete anchor.fingerprint // the mesh moved, so these hints no longer apply
  // the text turns with the part: carry the reading direction through the matrix and read its angle in the new frame
  const old = readingFrame(p.anchor.normal, upRefAxis(p.up_ref), p.direction ?? 0)
  const through = (v: Vec3): Vec3 => [(m[0] as number) * v[0] + (m[1] as number) * v[1] + (m[2] as number) * v[2], (m[4] as number) * v[0] + (m[5] as number) * v[1] + (m[6] as number) * v[2], (m[8] as number) * v[0] + (m[9] as number) * v[1] + (m[10] as number) * v[2]]
  const d = through(old.ex)
  const base = readingFrame(normal, upRefAxis(p.up_ref), 0)
  const dn = sub3(d, scale3(normal, dot3(d, normal)))
  let direction = p.direction ?? 0
  if (Math.hypot(dn[0], dn[1], dn[2]) > 1e-9) {
    direction = (Math.atan2(dot3(dn, base.ey), dot3(dn, base.ex)) * 180) / Math.PI
    if (Math.abs(direction) < 1e-9) direction = 0
  }
  return { ...p, anchor, direction }
}

/**
 * A `prepareStep` for the runner: before a step runs, every placement in it that records a `frame` is moved by
 * (matrix of the earlier steps now) x (matrix of the earlier steps when it was placed)^-1.
 */
export function followEarlierSteps<S extends { params: Record<string, unknown> } = Step>(): (step: S, index: number, results: ReadonlyArray<{ report?: Record<string, unknown>; status?: string } | undefined>) => S {
  return (step, index, results) => {
    let changed = false
    const params: Record<string, unknown> = { ...step.params }
    // the matrix is the same for every placement of the step: worked out once, when the first one needs it
    let now: number[] | undefined
    const follow = (v: unknown): unknown => {
      if (!isPlacement(v) || !isMat4(v.frame)) return v
      const inv = invert4(v.frame)
      if (!inv) return v
      now ??= cumulativeMatrix(results, index)
      const delta = mul4(now, inv)
      if (delta.every((x, i) => Math.abs(x - (IDENTITY4[i] as number)) < 1e-12)) return v
      changed = true
      return { ...transformPlacement(v, delta), frame: now }
    }
    for (const [k, v] of Object.entries(step.params)) {
      if (Array.isArray(v)) {
        // a list whose rows hold placements (several clicked points)
        const rows = v.map(row => {
          if (typeof row !== 'object' || row === null || Array.isArray(row)) return row
          let rowChanged = false
          const out: Record<string, unknown> = { ...(row as Record<string, unknown>) }
          for (const [f, x] of Object.entries(out)) { const y = follow(x); if (y !== x) { out[f] = y; rowChanged = true } }
          return rowChanged ? out : row
        })
        if (rows.some((r, i) => r !== v[i])) params[k] = rows
      } else {
        const y = follow(v)
        if (y !== v) params[k] = y
      }
    }
    return changed ? { ...step, params } : step
  }
}
