// Shared geometry for the transform operations: pivots, rotation matrices, applying a matrix. Plain functions on plain arrays.
import { measureMesh } from '@ateliermesh/core'
import type { Mesh, Vec3 } from '@ateliermesh/core'

/** Row-major 4x4 matrix, 16 numbers. Points are columns: p' = M * [p, 1]. */
export type Matrix = number[]

export const identity = (): Matrix => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

export function multiply(a: Matrix, b: Matrix): Matrix {
  const r = new Array<number>(16).fill(0)
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += (a[4 * i + k] as number) * (b[4 * k + j] as number); r[4 * i + j] = s }
  return r
}

export const translation = (t: Vec3): Matrix => [1, 0, 0, t[0], 0, 1, 0, t[1], 0, 0, 1, t[2], 0, 0, 0, 1]
/** A scale with its own factor per axis (a stretch in one direction only has two of them at 1). */
export const scalingXYZ = (fx: number, fy: number, fz: number): Matrix => [fx, 0, 0, 0, 0, fy, 0, 0, 0, 0, fz, 0, 0, 0, 0, 1]
export const scaling = (f: number): Matrix => [f, 0, 0, 0, 0, f, 0, 0, 0, 0, f, 0, 0, 0, 0, 1]

export function rotation(axis: 'X' | 'Y' | 'Z', degrees: number): Matrix {
  const a = (degrees * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
  // exact values at right angles: no 6e-17 noise in positions
  const cc = Math.abs(c) < 1e-15 ? 0 : c, ss = Math.abs(s) < 1e-15 ? 0 : s
  if (axis === 'X') return [1, 0, 0, 0, 0, cc, -ss, 0, 0, ss, cc, 0, 0, 0, 0, 1]
  if (axis === 'Y') return [cc, 0, ss, 0, 0, 1, 0, 0, -ss, 0, cc, 0, 0, 0, 0, 1]
  return [cc, -ss, 0, 0, ss, cc, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}

/** The matrix that does `m` around `pivot`: move the pivot to the origin, apply, move back. */
export function aroundPivot(m: Matrix, pivot: Vec3): Matrix {
  return multiply(translation(pivot), multiply(m, translation([-pivot[0], -pivot[1], -pivot[2]])))
}

export type PivotKind = 'bbox_center' | 'bbox_bottom_center' | 'origin' | 'centroid' | 'point'

export function pivotPoint(mesh: Mesh, kind: PivotKind, point: number[] = [0, 0, 0]): Vec3 {
  switch (kind) {
    case 'origin': return [0, 0, 0]
    case 'point': return [point[0] ?? 0, point[1] ?? 0, point[2] ?? 0]
    case 'bbox_center': case 'bbox_bottom_center': {
      const { bbox } = measureMesh(mesh)
      return [(bbox.min[0] + bbox.max[0]) / 2, (bbox.min[1] + bbox.max[1]) / 2, kind === 'bbox_center' ? (bbox.min[2] + bbox.max[2]) / 2 : bbox.min[2]]
    }
    case 'centroid': return volumeCentroid(mesh) ?? pivotPoint(mesh, 'bbox_center')
  }
}

/** Centre of mass of the enclosed volume (signed tetrahedra from the origin); null when the mesh encloses no volume. */
export function volumeCentroid(mesh: Mesh): Vec3 | null {
  const P = mesh.positions, T = mesh.indices
  let v = 0, cx = 0, cy = 0, cz = 0
  for (let t = 0; t < T.length; t += 3) {
    const a = 3 * (T[t] as number), b = 3 * (T[t + 1] as number), c = 3 * (T[t + 2] as number)
    const ax = P[a] as number, ay = P[a + 1] as number, az = P[a + 2] as number
    const bx = P[b] as number, by = P[b + 1] as number, bz = P[b + 2] as number
    const px = P[c] as number, py = P[c + 1] as number, pz = P[c + 2] as number
    const d = ax * (by * pz - bz * py) - ay * (bx * pz - bz * px) + az * (bx * py - by * px)
    v += d
    cx += d * (ax + bx + px); cy += d * (ay + by + py); cz += d * (az + bz + pz)
  }
  if (Math.abs(v) < 1e-12) return null
  return [cx / (4 * v), cy / (4 * v), cz / (4 * v)]
}

/** A new mesh with every position moved by `m`. Triangles, segments and groups are shared (they do not change). */
export function transformMesh(mesh: Mesh, m: Matrix): Mesh {
  const src = mesh.positions
  const out = new Float64Array(src.length)
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i] as number, y = src[i + 1] as number, z = src[i + 2] as number
    out[i] = (m[0] as number) * x + (m[1] as number) * y + (m[2] as number) * z + (m[3] as number)
    out[i + 1] = (m[4] as number) * x + (m[5] as number) * y + (m[6] as number) * z + (m[7] as number)
    out[i + 2] = (m[8] as number) * x + (m[9] as number) * y + (m[10] as number) * z + (m[11] as number)
  }
  return { ...mesh, positions: out }
}
