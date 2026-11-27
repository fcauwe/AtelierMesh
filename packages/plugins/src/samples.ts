// Sample parts with known shapes: used by the app and by the tests. Welded, closed, outward facing, millimetres, Z up.
import type { Mesh } from '@ateliermesh/core'

class Builder {
  P: number[] = []
  T: number[] = []
  private map = new Map<string, number>()
  v(x: number, y: number, z: number): number {
    const k = `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`
    let i = this.map.get(k)
    if (i === undefined) { i = this.P.length / 3; this.P.push(x, y, z); this.map.set(k, i) }
    return i
  }
  tri(a: number, b: number, c: number): void { this.T.push(a, b, c) }
  mesh(): Mesh { return { positions: Float64Array.from(this.P), indices: Uint32Array.from(this.T) } }
}

/** A box w x d x h centred in x and y, standing on z = 0, with a lattice nx x ny x nz on every face so that the edges match. */
export function gridBox(w: number, d: number, h: number, nx: number, ny: number, nz: number): Mesh {
  const B = new Builder()
  const X = (i: number): number => (i / nx - 0.5) * w, Y = (j: number): number => (j / ny - 0.5) * d, Z = (k: number): number => (k / nz) * h
  const quad = (a: number, b: number, c: number, e: number, flip: boolean): void => { if (!flip) { B.tri(a, b, c); B.tri(a, c, e) } else { B.tri(a, c, b); B.tri(a, e, c) } }
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    quad(B.v(X(i), Y(j), 0), B.v(X(i + 1), Y(j), 0), B.v(X(i + 1), Y(j + 1), 0), B.v(X(i), Y(j + 1), 0), true)
    quad(B.v(X(i), Y(j), h), B.v(X(i + 1), Y(j), h), B.v(X(i + 1), Y(j + 1), h), B.v(X(i), Y(j + 1), h), false)
  }
  for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
    quad(B.v(X(i), Y(0), Z(k)), B.v(X(i + 1), Y(0), Z(k)), B.v(X(i + 1), Y(0), Z(k + 1)), B.v(X(i), Y(0), Z(k + 1)), false)
    quad(B.v(X(i), Y(ny), Z(k)), B.v(X(i + 1), Y(ny), Z(k)), B.v(X(i + 1), Y(ny), Z(k + 1)), B.v(X(i), Y(ny), Z(k + 1)), true)
  }
  for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
    quad(B.v(X(0), Y(j), Z(k)), B.v(X(0), Y(j + 1), Z(k)), B.v(X(0), Y(j + 1), Z(k + 1)), B.v(X(0), Y(j), Z(k + 1)), true)
    quad(B.v(X(nx), Y(j), Z(k)), B.v(X(nx), Y(j + 1), Z(k)), B.v(X(nx), Y(j + 1), Z(k + 1)), B.v(X(nx), Y(j), Z(k + 1)), false)
  }
  return B.mesh()
}

/** A frustum (a cylinder when r0 = r1) around z with `seg` sides and `rings` rows, fan caps. */
export function frustum(r0: number, r1: number, h: number, seg: number, rings: number): Mesh {
  const B = new Builder()
  const ring = (r: number) => { const z = (h * r) / rings, R = r0 + ((r1 - r0) * r) / rings; return (s: number): number => B.v(R * Math.cos((2 * Math.PI * s) / seg), R * Math.sin((2 * Math.PI * s) / seg), z) }
  for (let r = 0; r < rings; r++) {
    const a = ring(r), b = ring(r + 1)
    for (let s = 0; s < seg; s++) { const s1 = (s + 1) % seg; B.tri(a(s), a(s1), b(s1)); B.tri(a(s), b(s1), b(s)) }
  }
  const c0 = B.v(0, 0, 0), c1 = B.v(0, 0, h), bot = ring(0), top = ring(rings)
  for (let s = 0; s < seg; s++) { const s1 = (s + 1) % seg; B.tri(c0, bot(s1), bot(s)); B.tri(c1, top(s), top(s1)) }
  return B.mesh()
}

/** An L-shaped letter outline (bar 2 wide and 10 tall, foot 4 long and 2 high), counter-clockwise, lower left corner at the origin. */
export const letterL = (): Array<[number, number]> => [[0, 0], [6, 0], [6, 2], [2, 2], [2, 10], [0, 10]]
export const rect = (x0: number, y0: number, x1: number, y1: number): Array<[number, number]> => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]

/** A sphere of the given radius as an icosphere (no poles): 20 * 4^subdivisions triangles, centred on the origin, outward facing. */
export function sphere(radius: number, subdivisions = 3): Mesh {
  const B = new Builder()
  const g = (1 + Math.sqrt(5)) / 2
  const base: Array<[number, number, number]> = [[-1, g, 0], [1, g, 0], [-1, -g, 0], [1, -g, 0], [0, -1, g], [0, 1, g], [0, -1, -g], [0, 1, -g], [g, 0, -1], [g, 0, 1], [-g, 0, -1], [-g, 0, 1]]
  const faces: Array<[number, number, number]> = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]]
  const norm = (v: [number, number, number]): [number, number, number] => { const l = Math.hypot(v[0], v[1], v[2]); return [(v[0] / l) * radius, (v[1] / l) * radius, (v[2] / l) * radius] }
  const mid = (a: [number, number, number], b: [number, number, number]): [number, number, number] => norm([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2])
  const corners = base.map(norm)
  const tri = (a: [number, number, number], b: [number, number, number], c: [number, number, number], depth: number): void => {
    if (depth === 0) { B.tri(B.v(...a), B.v(...b), B.v(...c)); return }
    const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a)
    tri(a, ab, ca, depth - 1); tri(b, bc, ab, depth - 1); tri(c, ca, bc, depth - 1); tri(ab, bc, ca, depth - 1)
  }
  for (const [a, b, c] of faces) tri(corners[a] as [number, number, number], corners[b] as [number, number, number], corners[c] as [number, number, number], subdivisions)
  return B.mesh()
}
