// The second kind of payload: a flat drawing (vector paths). A workflow can start from a drawing and an operation can turn it into a mesh (extrude), or the
// other way round. Units are millimetres, y up. Curves are already flattened to points; a path is a polyline, closed or open.
import { MeshError } from './errors'

export interface DrawingPath {
  /** At least two points (a closed path at least three). */
  points: Array<[number, number]>
  closed: boolean
  /** Name of the segment this path belongs to (`^[a-z][a-z0-9_]*$`), if any. A host gives a segment its meaning (for example an operation or a colour). */
  segment?: string
}

export interface DrawingSegment {
  name: string
  /** Display colour `#rrggbb`. */
  color?: string
}

export interface Drawing {
  kind: 'drawing'
  paths: DrawingPath[]
  /** Optional table that names the segments the paths refer to. */
  segments?: DrawingSegment[]
  /** How closed paths are filled where they nest: `nonzero` (default, like SVG) or `evenodd`. */
  fillRule?: 'nonzero' | 'evenodd'
}

export interface DrawingLimits {
  maxPaths?: number
  maxPoints?: number
}

export const isDrawing = (x: unknown): x is Drawing => typeof x === 'object' && x !== null && (x as { kind?: unknown }).kind === 'drawing' && Array.isArray((x as { paths?: unknown }).paths)

export function drawingPointCount(d: Drawing): number {
  let n = 0
  for (const p of d.paths) n += p.points.length
  return n
}

/** `[minX, minY, maxX, maxY]`, or null for an empty drawing. */
export function drawingBounds(d: Drawing): [number, number, number, number] | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of d.paths) for (const [x, y] of p.points) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  return x0 === Infinity ? null : [x0, y0, x1, y1]
}

/** Is this a usable drawing? Plain arrays of finite numbers, closed paths with three points. Returns the first problem or null. Used on every drawing from a file or an untrusted plugin. */
export function drawingShapeProblem(x: unknown): string | null {
  if (!isDrawing(x)) return 'not a drawing'
  const names = new Set<string>()
  if (x.segments !== undefined) {
    if (!Array.isArray(x.segments)) return 'segments is not an array'
    for (const s of x.segments) {
      if (typeof s?.name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(s.name)) return 'bad segment name'
      if (s.color !== undefined && !(typeof s.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.color))) return 'bad segment colour'
      names.add(s.name)
    }
  }
  if (x.fillRule !== undefined && x.fillRule !== 'nonzero' && x.fillRule !== 'evenodd') return 'bad fill rule'
  for (let i = 0; i < x.paths.length; i++) {
    const p = x.paths[i] as DrawingPath | undefined
    if (!p || !Array.isArray(p.points) || typeof p.closed !== 'boolean') return `path ${i} is malformed`
    if (p.points.length < (p.closed ? 3 : 2)) return `path ${i} has too few points`
    for (const q of p.points) if (!Array.isArray(q) || q.length !== 2 || !Number.isFinite(q[0]) || !Number.isFinite(q[1])) return `path ${i} has a point that is not two finite numbers`
    if (p.segment !== undefined && (typeof p.segment !== 'string' || (x.segments !== undefined && !names.has(p.segment)))) return `path ${i} names an unknown segment`
  }
  return null
}

export function checkDrawingBudget(d: Drawing, limits: DrawingLimits, of: 'source' | 'result' | 'file' = 'source'): void {
  if (limits.maxPaths !== undefined && d.paths.length > limits.maxPaths) throw new MeshError('budget.paths', { paths: d.paths.length, max: limits.maxPaths, of })
  const n = limits.maxPoints !== undefined ? drawingPointCount(d) : 0
  if (limits.maxPoints !== undefined && n > limits.maxPoints) throw new MeshError('budget.points', { points: n, max: limits.maxPoints, of })
}

const hex8 = (n: number): string => (n >>> 0).toString(16).padStart(8, '0')

/** A fast key for the content of a drawing (two 32-bit lanes over the numbers and the names). Decides only whether a cached result can be reused. */
export function drawingKey(d: Drawing): string {
  let a = 0x9747b28c | 0, b = 0x7f4a7c15 | 0
  const mix = (n: number): void => {
    const lo = Math.imul(n | 0, 0xcc9e2d51), hi = Math.imul((n / 4294967296) | 0, 0x1b873593)
    a = Math.imul((a ^ lo) << 13 | (a ^ lo) >>> 19, 5) + 0xe6546b64 | 0
    b = Math.imul((b ^ hi ^ lo) << 15 | (b ^ hi ^ lo) >>> 17, 0x85ebca6b) + 0xc2b2ae35 | 0
  }
  const str = (s: string): void => { for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i)); mix(s.length) }
  for (const p of d.paths) {
    mix(p.closed ? 1 : 2); mix(p.points.length); str(p.segment ?? '')
    for (const [x, y] of p.points) { mix(Math.round(x * 1e6)); mix(Math.round(y * 1e6)) }
  }
  str(JSON.stringify(d.segments ?? [])); str(d.fillRule ?? '')
  return `${d.paths.length}p${drawingPointCount(d)}-${hex8(a)}${hex8(b)}`
}

/** Memory the drawing takes, roughly: 16 bytes a point plus a little a path. For the cache budget. */
export const drawingBytes = (d: Drawing): number => drawingPointCount(d) * 16 + d.paths.length * 64

const FORMAT = 'amdraw'

export function encodeDrawing(d: Drawing): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ format: FORMAT, version: 1, paths: d.paths, ...(d.segments ? { segments: d.segments } : {}), ...(d.fillRule ? { fillRule: d.fillRule } : {}) }))
}

export function decodeDrawing(bytes: Uint8Array, limits: DrawingLimits = {}): Drawing {
  const bad = (reason: string): MeshError => new MeshError('import.invalid_drawing', { reason })
  let j: Record<string, unknown>
  try { j = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown> } catch { throw bad('not_json') }
  if (!j || typeof j !== 'object' || j['format'] !== FORMAT) throw bad('not_a_drawing')
  if (j['version'] !== 1) throw bad('unsupported_version')
  const d = { kind: 'drawing', paths: j['paths'], ...(j['segments'] !== undefined ? { segments: j['segments'] } : {}), ...(j['fillRule'] !== undefined ? { fillRule: j['fillRule'] } : {}) } as Drawing
  const why = drawingShapeProblem(d)
  if (why) throw bad(why)
  checkDrawingBudget(d, limits, 'file')
  return d
}
