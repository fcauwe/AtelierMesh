import { describe, expect, it } from 'vitest'
import { boxMesh, sphereMesh } from '@ateliermesh/core/testing'
import { creaseNormals } from '../src/normals'

const len = (a: ArrayLike<number>, o: number): number => Math.hypot(a[o] as number, a[o + 1] as number, a[o + 2] as number)

describe('smooth shading normals', () => {
  it('a box keeps flat faces: every corner normal is the normal of its own face', () => {
    const b = boxMesh(10, 10, 10)
    const n = creaseNormals(b.positions, b.indices, 35)
    // the corner normals have unit length and are axis aligned (no averaging across the 90 degree edges)
    for (let i = 0; i < n.length; i += 3) {
      expect(len(n, i)).toBeCloseTo(1, 5)
      expect(Math.max(Math.abs(n[i]!), Math.abs(n[i + 1]!), Math.abs(n[i + 2]!))).toBeCloseTo(1, 5)
    }
  })
  it('a sphere is smooth: corner normals point away from the centre, much closer than the flat face normals', () => {
    const s = sphereMesh(10, 2)
    const smooth = creaseNormals(s.positions, s.indices, 35)
    const flat = creaseNormals(s.positions, s.indices, 0.001)
    const err = (nrm: Float32Array): number => {
      let worst = 0
      for (let t = 0; t < s.indices.length / 3; t++) for (let k = 0; k < 3; k++) {
        const v = s.indices[3 * t + k] as number
        const px = s.positions[3 * v]!, py = s.positions[3 * v + 1]!, pz = s.positions[3 * v + 2]!, l = Math.hypot(px, py, pz)
        const d = (px * nrm[9 * t + 3 * k]! + py * nrm[9 * t + 3 * k + 1]! + pz * nrm[9 * t + 3 * k + 2]!) / l
        worst = Math.max(worst, Math.acos(Math.min(1, d)))
      }
      return worst
    }
    expect(err(smooth)).toBeLessThan(err(flat) * 0.5)
  })
  it('a subset of triangles gives normals for just those', () => {
    const b = boxMesh(4, 4, 4)
    expect(creaseNormals(b.positions, b.indices, 35, [0, 5]).length).toBe(2 * 9)
  })
})
