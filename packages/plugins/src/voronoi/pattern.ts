// The outlines of a Voronoi pattern on a flat map (millimetres, origin at the region's centre): seeds from a small seeded generator, relaxed towards
// even cells (Lloyd), the cells cut out by clipping the region with the bisector of every close pair of seeds, then the wall lines (or the cells
// themselves) as closed outlines for the cutter, which fills them with the even-odd rule. No Math.random: one seed gives one pattern, everywhere.
import ClipperLib from 'clipper-lib'
import { MeshError } from '@ateliermesh/core'
import type { Ring } from '../emboss/cut'
import { bboxOfRings } from '../emboss/shape'

const SCALE = 10000 // clipper works on integers: 0.1 micrometre
type Pt = [number, number]

export interface PatternOptions {
  region: 'rectangle' | 'circle'
  width: number
  height: number
  radius: number
  /** Clearance between the pattern and the edge of the region, mm. */
  margin: number
  cells: number
  seed: number
  /** 0 = even, hexagon-like cells (many relaxation steps); 1 = random seeds, no relaxation. */
  irregularity: number
  lineWidth: number
  /** `true`: the cells themselves are the shape (pads with gaps of `lineWidth`); `false`: the lines between them are. */
  fill: boolean
  /** Corner radius of the cells, mm. */
  rounding: number
  /** Largest distance between the flattened curve and the true arc, mm. */
  tolerance: number
  signal?: AbortSignal
}

export interface Pattern {
  rings: Ring[]
  bbox: [number, number, number, number]
  /** The cells asked for, and how many have a pad left after the gap and the rounding. */
  cells: number
  cellsKept: number
  /** Mean width of the shape: twice its area over its outline length. */
  meanStroke: number
  vertices: number
  /** Average distance between neighbouring seeds, mm. */
  cellSize: number
  regionArea: number
}

export const MAX_CELLS = 2000
/** More outline points than this cannot be cut in a reasonable time. */
export const MAX_VERTICES = 60000

/** A small seeded generator (mulberry32): the same seed gives the same numbers on every machine. */
export function rng(seed: number): () => number {
  let a = (seed | 0) + 0x6d2b79f5
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const cancelled = (o: PatternOptions): void => { if (o.signal?.aborted) throw new MeshError('run.cancelled') }

/** The region as a convex polygon, counter-clockwise, shrunk by the margin. */
export function regionPolygon(o: Pick<PatternOptions, 'region' | 'width' | 'height' | 'radius' | 'margin' | 'tolerance'>): Pt[] {
  if (o.region === 'circle') {
    const r = o.radius - o.margin
    if (!(r > 0)) throw new MeshError('voronoi.empty_pattern', { reason: 'margin' })
    const n = Math.min(256, Math.max(24, Math.ceil(Math.PI / Math.acos(Math.max(0, 1 - Math.min(o.tolerance, r) / r)))))
    return Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)] as Pt)
  }
  const hw = o.width / 2 - o.margin, hh = o.height / 2 - o.margin
  if (!(hw > 0 && hh > 0)) throw new MeshError('voronoi.empty_pattern', { reason: 'margin' })
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
}

const polyArea = (p: Pt[]): number => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i] as Pt, r = p[(i + 1) % p.length] as Pt; a += q[0] * r[1] - r[0] * q[1] } return a / 2 }

/** Keep the part of a convex polygon where (p - m) . n <= 0 (the side of the seed). */
function clipHalf(poly: Pt[], nx: number, ny: number, mx: number, my: number): Pt[] {
  const out: Pt[] = []
  const side = (p: Pt): number => (p[0] - mx) * nx + (p[1] - my) * ny
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Pt, b = poly[(i + 1) % poly.length] as Pt
    const da = side(a), db = side(b)
    if (da <= 0) out.push(a)
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) { const t = da / (da - db); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]) }
  }
  return out
}

/** The Voronoi cell of every seed inside the convex region. A grid of seeds finds the near ones ring by ring and stops when no farther seed can reach the cell. */
export function voronoiCells(seeds: Pt[], region: Pt[], o: { signal?: AbortSignal } = {}): Pt[][] {
  const n = seeds.length
  const area = Math.abs(polyArea(region))
  const gs = Math.max(1e-6, Math.sqrt(area / Math.max(1, n)))
  let minX = Infinity, minY = Infinity
  for (const p of region) { minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]) }
  const cellOf = (v: number, m: number): number => Math.floor((v - m) / gs)
  const grid = new Map<number, number[]>()
  const key = (i: number, j: number): number => (i + 1000) * 100003 + (j + 1000)
  let maxI = 0, maxJ = 0
  seeds.forEach((s, idx) => {
    const i = cellOf(s[0], minX), j = cellOf(s[1], minY)
    maxI = Math.max(maxI, i); maxJ = Math.max(maxJ, j)
    const k = key(i, j); const l = grid.get(k); if (l) l.push(idx); else grid.set(k, [idx])
  })
  const maxK = Math.max(maxI, maxJ) + 2
  const cells: Pt[][] = []
  for (let a = 0; a < n; a++) {
    if ((a & 63) === 0 && o.signal?.aborted) throw new MeshError('run.cancelled')
    const s = seeds[a] as Pt
    let poly = region.slice()
    const ci = cellOf(s[0], minX), cj = cellOf(s[1], minY)
    for (let k = 0; k <= maxK; k++) {
      for (let i = ci - k; i <= ci + k; i++) for (let j = cj - k; j <= cj + k; j++) {
        if (k > 0 && Math.abs(i - ci) !== k && Math.abs(j - cj) !== k) continue
        const l = grid.get(key(i, j)); if (!l) continue
        for (const b of l) {
          if (b === a) continue
          const t = seeds[b] as Pt
          const nx = t[0] - s[0], ny = t[1] - s[1]
          if (nx === 0 && ny === 0) continue
          poly = clipHalf(poly, nx, ny, (s[0] + t[0]) / 2, (s[1] + t[1]) / 2)
          if (poly.length < 3) break
        }
      }
      if (poly.length < 3) break
      let r2 = 0
      for (const p of poly) r2 = Math.max(r2, (p[0] - s[0]) ** 2 + (p[1] - s[1]) ** 2)
      if (Math.sqrt(r2) * 2 <= k * gs) break // every seed not yet looked at is at least k * gs away
    }
    cells.push(poly)
  }
  return cells
}

function centroid(poly: Pt[]): Pt | null {
  let a = 0, cx = 0, cy = 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i] as Pt, q = poly[(i + 1) % poly.length] as Pt
    const w = p[0] * q[1] - q[0] * p[1]
    a += w; cx += (p[0] + q[0]) * w; cy += (p[1] + q[1]) * w
  }
  return Math.abs(a) < 1e-12 ? null : [cx / (3 * a), cy / (3 * a)]
}

const toClipper = (r: Pt[]): Array<{ X: number; Y: number }> => r.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }))
const fromClipper = (p: Array<{ X: number; Y: number }>): Ring => p.map(q => [q.X / SCALE, q.Y / SCALE] as Pt)

/** Offset closed polygons by `delta` mm (negative shrinks). Miter joins keep the corners of the cells sharp; round joins make them round. */
function offset(polys: Pt[][], delta: number, round: boolean, tolerance: number): Pt[][] {
  if (polys.length === 0) return []
  const co = new ClipperLib.ClipperOffset(3, Math.max(1, tolerance * SCALE))
  co.AddPaths(polys.map(toClipper), round ? ClipperLib.JoinType.jtRound : ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon)
  const out = new ClipperLib.Paths()
  co.Execute(out, delta * SCALE)
  return out.map(fromClipper).filter(r => r.length >= 3)
}

function boolean(subject: Pt[][], clip: Pt[][], type: number): Pt[][] {
  const c = new ClipperLib.Clipper()
  c.AddPaths(subject.map(toClipper), ClipperLib.PolyType.ptSubject, true)
  c.AddPaths(clip.map(toClipper), ClipperLib.PolyType.ptClip, true)
  const out = new ClipperLib.Paths()
  c.Execute(type, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
  return out.map(fromClipper).filter(r => r.length >= 3)
}

/** Net area and total outline length of outlines that come out of clipper (outer boundaries counter-clockwise, holes clockwise). */
function areaAndLength(rings: Ring[]): { area: number; length: number } {
  let area = 0, length = 0
  for (const r of rings) {
    area += polyArea(r as Pt[])
    for (let i = 0; i < r.length; i++) { const a = r[i] as Pt, b = r[(i + 1) % r.length] as Pt; length += Math.hypot(b[0] - a[0], b[1] - a[1]) }
  }
  return { area: Math.abs(area), length }
}

export function voronoiPattern(o: PatternOptions): Pattern {
  if (!(o.cells >= 2)) throw new MeshError('voronoi.bad_cells', { cells: o.cells })
  if (o.cells > MAX_CELLS) throw new MeshError('voronoi.too_many_cells', { cells: o.cells, max: MAX_CELLS })
  const region = regionPolygon(o)
  const regionArea = Math.abs(polyArea(region))
  const cellSize = Math.sqrt(regionArea / o.cells)
  // the gap between two cells is one line width: cells not much bigger than that leave nothing to print
  if (cellSize <= o.lineWidth * 1.2) throw new MeshError('voronoi.cells_too_small', { cells: o.cells, max_cells: Math.max(2, Math.floor(regionArea / (2.25 * o.lineWidth * o.lineWidth))), line_width: o.lineWidth, cell_size: cellSize })
  const rand = rng(o.seed)
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const p of region) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]) }
  const inside = (p: Pt): boolean => { for (let i = 0; i < region.length; i++) { const a = region[i] as Pt, b = region[(i + 1) % region.length] as Pt; if ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) < 0) return false } return true }
  let seeds: Pt[] = []
  while (seeds.length < o.cells) {
    const p: Pt = [x0 + rand() * (x1 - x0), y0 + rand() * (y1 - y0)]
    if (inside(p)) seeds.push(p)
  }
  const steps = Math.ceil((1 - Math.min(1, Math.max(0, o.irregularity))) * 10)
  for (let s = 0; s < steps; s++) {
    cancelled(o)
    const cells = voronoiCells(seeds, region, o)
    seeds = seeds.map((p, i) => centroid(cells[i] as Pt[]) ?? p)
  }
  const cells = voronoiCells(seeds, region, o)
  cancelled(o)
  // each cell shrinks by half a line width: two neighbours then leave a gap of one line width
  let pads = offset(cells.filter(c => c.length >= 3), -o.lineWidth / 2, false, o.tolerance)
  if (o.rounding > 0) pads = offset(offset(pads, -o.rounding, true, o.tolerance), o.rounding, true, o.tolerance)
  let rings: Pt[][]
  if (o.fill) rings = pads
  else {
    // the lines: the whole region minus the pads, which also keep a full line width away from the edge (a frame)
    const frame = offset([region], -o.lineWidth, false, o.tolerance)
    const kept = boolean(pads, frame, ClipperLib.ClipType.ctIntersection)
    rings = boolean([region], kept, ClipperLib.ClipType.ctDifference)
    pads = kept
  }
  if (pads.length === 0 || rings.length === 0) throw new MeshError('voronoi.empty_pattern', { reason: 'cells_vanish', line_width: o.lineWidth })
  const vertices = rings.reduce((s, r) => s + r.length, 0)
  if (vertices > MAX_VERTICES) throw new MeshError('voronoi.too_heavy', { vertices, max: MAX_VERTICES, cells: o.cells })
  const { area, length } = areaAndLength(rings)
  return { rings, bbox: bboxOfRings(rings), cells: o.cells, cellsKept: pads.length, meanStroke: length > 0 ? (2 * area) / length : 0, vertices, cellSize, regionArea }
}
