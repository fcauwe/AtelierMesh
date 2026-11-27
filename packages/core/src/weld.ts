// Welding: turn a triangle soup (three separate vertices per triangle, as in STL) into an indexed mesh.
import type { Mesh } from './types'
import { CHUNK, runAsync, runSync } from './progress'
import type { ProgressOptions } from './progress'

export interface WeldResult {
  mesh: Mesh
  /** Triangles removed because two of their corners became the same vertex. */
  degenerate: number
}

/**
 * `soup` holds 9 numbers per triangle. Corners closer than `tolerance` (millimetres, per axis, on a grid) become one vertex.
 * STL stores float32 copies of the same point, so the default is far below any real feature.
 */
export function weldSoup(soup: ArrayLike<number>, tolerance = 1e-5): WeldResult { return runSync(weldGen(soup, tolerance)) }

/** The same, letting the event loop run between chunks (progress 0 to 1 over the corners). */
export function weldSoupAsync(soup: ArrayLike<number>, tolerance = 1e-5, opts: ProgressOptions = {}): Promise<WeldResult> { return runAsync(weldGen(soup, tolerance), opts) }

export function* weldGen(soup: ArrayLike<number>, tolerance: number): Generator<number, WeldResult> {
  const nCorners = soup.length / 3
  const nTri = nCorners / 3
  const positions = new Float64Array(soup.length)
  const indices = new Uint32Array(nCorners)
  let size = 4; while (size < nCorners * 2) size <<= 1
  const mask = size - 1
  const table = new Int32Array(size).fill(-1)
  const inv = 1 / tolerance
  let nv = 0
  for (let c = 0; c < nCorners; c++) {
    if (c > 0 && c % (3 * CHUNK) === 0) yield (0.9 * c) / nCorners
    const x = soup[3 * c] as number, y = soup[3 * c + 1] as number, z = soup[3 * c + 2] as number
    const qx = Math.round(x * inv), qy = Math.round(y * inv), qz = Math.round(z * inv)
    let h = (Math.imul(qx | 0, 0x9e3779b1) ^ Math.imul(qy | 0, 0x85ebca6b) ^ Math.imul(qz | 0, 0xc2b2ae35)) >>> 0
    h = (h ^ (h >>> 15)) & mask
    for (;;) {
      const v = table[h] as number
      if (v === -1) {
        positions[3 * nv] = x; positions[3 * nv + 1] = y; positions[3 * nv + 2] = z
        table[h] = nv; indices[c] = nv; nv++
        break
      }
      if (Math.round((positions[3 * v] as number) * inv) === qx && Math.round((positions[3 * v + 1] as number) * inv) === qy && Math.round((positions[3 * v + 2] as number) * inv) === qz) { indices[c] = v; break }
      h = (h + 1) & mask
    }
  }
  // drop degenerate triangles
  let kept = 0
  const out = new Uint32Array(indices.length)
  for (let t = 0; t < nTri; t++) {
    const a = indices[3 * t] as number, b = indices[3 * t + 1] as number, c = indices[3 * t + 2] as number
    if (a === b || b === c || a === c) continue
    out[3 * kept] = a; out[3 * kept + 1] = b; out[3 * kept + 2] = c; kept++
  }
  // vertices that only belonged to removed triangles are dropped, so no vertex is left unused
  const remap = new Int32Array(nv).fill(-1)
  let used = 0
  const outPos = new Float64Array(3 * nv)
  for (let i = 0; i < 3 * kept; i++) {
    const v = out[i] as number
    let r = remap[v] as number
    if (r < 0) { r = used++; remap[v] = r; outPos[3 * r] = positions[3 * v] as number; outPos[3 * r + 1] = positions[3 * v + 1] as number; outPos[3 * r + 2] = positions[3 * v + 2] as number }
    out[i] = r
  }
  return { mesh: { positions: outPos.slice(0, 3 * used), indices: out.slice(0, 3 * kept) }, degenerate: nTri - kept }
}
