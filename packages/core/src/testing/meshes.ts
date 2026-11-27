// Small test meshes with known measurements. Closed, welded, outward-facing triangles; millimetres, Z up.
import type { Mesh } from '../types'

const mesh = (positions: number[], indices: number[]): Mesh => ({ positions: Float64Array.from(positions), indices: Uint32Array.from(indices) })

/** A box centred on the z axis, standing on z = 0. 12 triangles. Volume w*d*h. */
export function boxMesh(w: number, d: number, h: number): Mesh {
  const x = w / 2, y = d / 2
  return mesh(
    [-x, -y, 0, x, -y, 0, x, y, 0, -x, y, 0, -x, -y, h, x, -y, h, x, y, h, -x, y, h],
    [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7],
  )
}

/** A closed cylinder around the z axis from z = 0 to h, with fan caps. `segments` around. */
export function cylinderMesh(r: number, h: number, segments = 48): Mesh {
  const p: number[] = [], t: number[] = []
  for (let i = 0; i < segments; i++) { const a = (2 * Math.PI * i) / segments; p.push(r * Math.cos(a), r * Math.sin(a), 0) }
  for (let i = 0; i < segments; i++) { const a = (2 * Math.PI * i) / segments; p.push(r * Math.cos(a), r * Math.sin(a), h) }
  const c0 = p.length / 3; p.push(0, 0, 0)
  const c1 = p.length / 3; p.push(0, 0, h)
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments
    t.push(i, j, segments + j, i, segments + j, segments + i) // side, outward
    t.push(c0, j, i) // bottom, facing down
    t.push(c1, segments + i, segments + j) // top, facing up
  }
  return mesh(p, t)
}

/** An icosphere. Volume approaches 4/3 π r³ as `subdivisions` grows. */
export function sphereMesh(r: number, subdivisions = 3): Mesh {
  const g = (1 + Math.sqrt(5)) / 2
  let v: number[][] = [[-1, g, 0], [1, g, 0], [-1, -g, 0], [1, -g, 0], [0, -1, g], [0, 1, g], [0, -1, -g], [0, 1, -g], [g, 0, -1], [g, 0, 1], [-g, 0, -1], [-g, 0, 1]]
    .map(a => { const l = Math.hypot(a[0] as number, a[1] as number, a[2] as number); return [(a[0] as number) / l, (a[1] as number) / l, (a[2] as number) / l] })
  let f: number[][] = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]]
  for (let s = 0; s < subdivisions; s++) {
    const cache = new Map<number, number>(), next: number[][] = []
    const mid = (a: number, b: number): number => {
      const k = a < b ? a * 1e7 + b : b * 1e7 + a
      let i = cache.get(k)
      if (i === undefined) {
        const m = [((v[a] as number[])[0] as number + (v[b] as number[])[0] as number) / 2, ((v[a] as number[])[1] as number + (v[b] as number[])[1] as number) / 2, ((v[a] as number[])[2] as number + (v[b] as number[])[2] as number) / 2]
        const l = Math.hypot(m[0] as number, m[1] as number, m[2] as number)
        v.push([(m[0] as number) / l, (m[1] as number) / l, (m[2] as number) / l]); i = v.length - 1; cache.set(k, i)
      }
      return i
    }
    for (const [a, b, c] of f as Array<[number, number, number]>) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]) }
    f = next
  }
  v = v.map(a => [(a[0] as number) * r, (a[1] as number) * r, (a[2] as number) * r])
  return mesh(v.flat(), f.flat())
}

/**
 * An asymmetric part (not a cube): an L-shaped prism, 40 long, 20 wide, 10 high, with a 20 x 10 notch cut from one corner.
 * Its three sizes are all different, so a swapped axis or a wrong unit is visible. Volume 40*20*10 - 20*10*10 = 6000.
 */
export function lBracketMesh(): Mesh {
  // outline in the xy plane, counter-clockwise; the L is star-shaped from its first corner, so a fan from vertex 0 triangulates it
  const o: Array<[number, number]> = [[0, 0], [40, 0], [40, 10], [20, 10], [20, 20], [0, 20]]
  const h = 10, n = o.length
  const p: number[] = []
  for (const [x, y] of o) p.push(x, y, 0)
  for (const [x, y] of o) p.push(x, y, h)
  const t: number[] = []
  const tri = [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 5]]
  for (const [a, b, c] of tri as Array<[number, number, number]>) { t.push(a, c, b); t.push(n + a, n + b, n + c) }
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; t.push(i, j, n + j, i, n + j, n + i) }
  return mesh(p, t)
}
