// STL, binary and ASCII. STL stores float32, so a written file loses double precision; that is the format, not a bug.
import { MeshError } from './errors'
import type { Mesh } from './types'
import { weldGen } from './weld'
import { CHUNK, runAsync, runSync } from './progress'
import type { ProgressOptions } from './progress'

export interface StlReadOptions {
  /** Refuse files with more triangles than this, before reading them. */
  maxTriangles?: number
  weldTolerance?: number
}

export interface StlReadResult {
  mesh: Mesh
  format: 'binary' | 'ascii'
  /** Triangles in the file. */
  trianglesInFile: number
  /** Triangles dropped because they had a repeated corner after welding. */
  degenerate: number
}

export function parseStl(bytes: Uint8Array, opts: StlReadOptions = {}): StlReadResult { return runSync(parseStlGen(bytes, opts)) }

/** The same, letting the event loop run between chunks: reports progress (0 to 1) and can be stopped with `signal`. */
export function parseStlAsync(bytes: Uint8Array, opts: StlReadOptions & ProgressOptions = {}): Promise<StlReadResult> { return runAsync(parseStlGen(bytes, opts), opts) }

function* parseStlGen(bytes: Uint8Array, opts: StlReadOptions): Generator<number, StlReadResult> {
  const max = opts.maxTriangles ?? Infinity
  if (bytes.length >= 84) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const n = dv.getUint32(80, true)
    if (bytes.length === 84 + 50 * n) {
      if (n > max) throw new MeshError('budget.triangles', { triangles: n, max, of: 'file' })
      const soup = new Float32Array(9 * n)
      for (let t = 0; t < n; t++) {
        if (t > 0 && t % CHUNK === 0) yield (0.4 * t) / n
        const o = 84 + 50 * t + 12
        for (let k = 0; k < 9; k++) soup[9 * t + k] = dv.getFloat32(o + 4 * k, true)
      }
      return yield* finish(soup, 'binary', n, opts)
    }
  }
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 512))).trimStart().toLowerCase()
  if (!head.startsWith('solid')) throw new MeshError('import.invalid_stl', { reason: 'not_stl' })
  const text = new TextDecoder().decode(bytes)
  const nums: number[] = []
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi
  for (let m = re.exec(text); m; m = re.exec(text)) {
    nums.push(Number(m[1]), Number(m[2]), Number(m[3]))
    if (nums.length % (9 * CHUNK) === 0) yield 0.2
    if (nums.length / 9 > max) throw new MeshError('budget.triangles', { triangles: Math.floor(nums.length / 9), max, of: 'file' })
  }
  if (nums.length === 0 || nums.length % 9 !== 0) throw new MeshError('import.invalid_stl', { reason: nums.length === 0 ? 'no_facets' : 'vertex_count_not_multiple_of_3' })
  if (nums.some(v => !Number.isFinite(v))) throw new MeshError('import.invalid_stl', { reason: 'bad_number' })
  return yield* finish(nums, 'ascii', nums.length / 9, opts)
}

function* finish(soup: ArrayLike<number>, format: 'binary' | 'ascii', n: number, opts: StlReadOptions): Generator<number, StlReadResult> {
  for (let i = 0; i < soup.length; i++) { if (i > 0 && i % (9 * CHUNK) === 0) yield 0.4 + (0.1 * i) / soup.length; if (!Number.isFinite(soup[i])) throw new MeshError('import.invalid_stl', { reason: 'bad_number' }) }
  const g = weldGen(soup, opts.weldTolerance ?? 1e-5)
  let r = g.next()
  while (!r.done) { yield 0.5 + 0.5 * r.value; r = g.next() }
  const w = r.value
  return { mesh: w.mesh, format, trianglesInFile: n, degenerate: w.degenerate }
}

function normal(P: Float64Array, a: number, b: number, c: number): [number, number, number] {
  const ux = (P[3 * b] as number) - (P[3 * a] as number), uy = (P[3 * b + 1] as number) - (P[3 * a + 1] as number), uz = (P[3 * b + 2] as number) - (P[3 * a + 2] as number)
  const vx = (P[3 * c] as number) - (P[3 * a] as number), vy = (P[3 * c + 1] as number) - (P[3 * a + 1] as number), vz = (P[3 * c + 2] as number) - (P[3 * a + 2] as number)
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
  const l = Math.hypot(nx, ny, nz)
  return l > 0 ? [nx / l, ny / l, nz / l] : [0, 0, 0]
}

/** Binary STL. The 80-byte header must not start with "solid", or some readers take the file for ASCII. */
export function writeStlBinary(mesh: Mesh, header = 'ateliermesh binary stl'): Uint8Array {
  const n = mesh.indices.length / 3
  const out = new Uint8Array(84 + 50 * n)
  const dv = new DataView(out.buffer)
  const h = new TextEncoder().encode(header.startsWith('solid') ? '_' + header : header).subarray(0, 80)
  out.set(h, 0)
  dv.setUint32(80, n, true)
  const P = mesh.positions, T = mesh.indices
  for (let t = 0; t < n; t++) {
    const a = T[3 * t] as number, b = T[3 * t + 1] as number, c = T[3 * t + 2] as number
    const o = 84 + 50 * t
    const nr = normal(P, a, b, c)
    for (let k = 0; k < 3; k++) dv.setFloat32(o + 4 * k, nr[k] as number, true)
    ;[a, b, c].forEach((v, i) => { for (let k = 0; k < 3; k++) dv.setFloat32(o + 12 + 12 * i + 4 * k, P[3 * v + k] as number, true) })
  }
  return out
}

export function writeStlAscii(mesh: Mesh, name = 'ateliermesh'): Uint8Array {
  const P = mesh.positions, T = mesh.indices
  const lines: string[] = [`solid ${name.replace(/\s+/g, '_')}`]
  for (let t = 0; t < T.length / 3; t++) {
    const a = T[3 * t] as number, b = T[3 * t + 1] as number, c = T[3 * t + 2] as number
    const n = normal(P, a, b, c)
    lines.push(`facet normal ${n[0]} ${n[1]} ${n[2]}`, 'outer loop')
    for (const v of [a, b, c]) lines.push(`vertex ${P[3 * v]} ${P[3 * v + 1]} ${P[3 * v + 2]}`)
    lines.push('endloop', 'endfacet')
  }
  lines.push(`endsolid ${name.replace(/\s+/g, '_')}`)
  return new TextEncoder().encode(lines.join('\n') + '\n')
}
