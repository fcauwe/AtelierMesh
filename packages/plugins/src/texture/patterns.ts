// The built-in height patterns of the texture operation: pure functions h(u, v) -> [0, 1] on tile coordinates.
// One tile is the square (0..1) x (0..1) in the pattern's own units; every pattern repeats with period 1 in u and v (an image excepted),
// so a surface that is covered with tiles never shows a seam. `patternAspect` says how tall a tile is compared with its width in millimetres
// (the hexagon patterns need two rows of hexagons to repeat, which is sqrt(3) times as tall as wide). Everything is deterministic: the only source
// of variation is the integer `seed`, mixed into an integer hash (no Math.random, no clock).

export const PATTERNS = ['noise', 'knurl', 'ridges', 'waves', 'dots', 'hex_dots', 'hexagons', 'bricks', 'weave', 'grid', 'leather', 'wood', 'stipple', 'image'] as const
export type PatternName = (typeof PATTERNS)[number]

export interface PatternParams {
  seed: number
  /** 0..1: how strongly the finer layers of a noise show (noise, leather, wood, stipple). */
  roughness: number
  /** 1..6: the layers of a fractal noise (noise, wood). */
  octaves: number
  /** 0.1..0.95: how much of a cell the raised feature takes (ridges, dots, hexagons, bricks, weave, grid). */
  fill: number
}

const SQRT3 = Math.sqrt(3)
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
const smooth = (t: number): number => { const x = clamp01(t); return x * x * (3 - 2 * x) }
const fract = (x: number): number => x - Math.floor(x)
/** A triangle wave: 0 at the integers, 1 halfway. */
const tri = (x: number): number => 1 - Math.abs(2 * fract(x) - 1)
const mod = (a: number, n: number): number => ((a % n) + n) % n

/** A 32-bit integer hash of two integers and the seed, as a number in [0, 1). */
export function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul((seed | 0) + 0x9e3779b9, 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

/** Smooth value noise on a lattice that repeats every `period` cells across (and `periodY` cells up, by default the same). x and y are in lattice units. */
function valueNoise(x: number, y: number, period: number, seed: number, periodY = period): number {
  const ix = Math.floor(x), iy = Math.floor(y)
  const fx = smooth(x - ix), fy = smooth(y - iy)
  const x0 = mod(ix, period), x1 = mod(ix + 1, period), y0 = mod(iy, periodY), y1 = mod(iy + 1, periodY)
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed), c = hash2(x0, y1, seed), d = hash2(x1, y1, seed)
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
}

/** Fractal noise that repeats once per tile: four lattice cells per tile in the first layer, twice as many in each next one. */
function fbm(u: number, v: number, p: PatternParams): number {
  const oct = Math.max(1, Math.min(6, Math.round(p.octaves)))
  const g = clamp01(p.roughness) * 0.8 + 0.1
  let sum = 0, amp = 1, norm = 0
  for (let k = 0; k < oct; k++) {
    const period = 4 << k
    sum += amp * valueNoise(u * period, v * period, period, p.seed + 101 * k)
    norm += amp; amp *= g
  }
  return sum / norm
}

/** Cellular noise: the distances to the nearest and second nearest of one jittered point per cell, on a lattice of `cells` x `cells` per tile. */
function worley(u: number, v: number, cells: number, seed: number): { f1: number; f2: number; id: number } {
  const x = u * cells, y = v * cells
  const ix = Math.floor(x), iy = Math.floor(y)
  let f1 = Infinity, f2 = Infinity, id = 0
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = ix + i, cy = iy + j
    const wx = mod(cx, cells), wy = mod(cy, cells)
    const px = cx + hash2(wx, wy, seed), py = cy + hash2(wx, wy, seed + 7)
    const d = Math.hypot(px - x, py - y)
    if (d < f1) { f2 = f1; f1 = d; id = wx * cells + wy } else if (d < f2) f2 = d
  }
  return { f1, f2, id }
}

/** The nearest centre of a hexagon lattice with centres one unit apart, and the distance from the point to the edge of its cell. x runs 0..1 per tile, y 0..sqrt(3). */
function hexCell(x: number, y: number): { dist: number; edge: number } {
  const rowH = SQRT3 / 2
  const j0 = Math.floor(y / rowH)
  let d1 = Infinity, d2 = Infinity, x1 = 0, y1 = 0, x2 = 0, y2 = 0
  for (let j = j0 - 1; j <= j0 + 1; j++) {
    const off = mod(j, 2) * 0.5
    const i0 = Math.floor(x - off)
    for (let i = i0 - 1; i <= i0 + 1; i++) {
      const px = i + off, py = j * rowH
      const d = Math.hypot(px - x, py - y)
      if (d < d1) { d2 = d1; x2 = x1; y2 = y1; d1 = d; x1 = px; y1 = py } else if (d < d2) { d2 = d; x2 = px; y2 = py }
    }
  }
  // the distance from the point to the straight line that divides its cell from the next nearest one
  const gap = Math.hypot(x2 - x1, y2 - y1) || 1
  return { dist: d1, edge: Math.max(0, (d2 * d2 - d1 * d1) / (2 * gap)) }
}

/** The tile height divided by its width, in millimetres. */
export function patternAspect(name: PatternName, imageAspect = 1): number {
  if (name === 'hex_dots' || name === 'hexagons') return SQRT3
  if (name === 'image') return imageAspect
  return 1
}

/** The smallest feature of the pattern as a fraction of the tile width; the surface needs edges about a quarter of that to follow it. */
export function patternFeature(name: PatternName, p: PatternParams, imageSize = 64): number {
  switch (name) {
    case 'noise': return Math.round(p.octaves) <= 1 ? 0.25 : 0.125   // the finer layers are weaker (each by `roughness`), so two layers decide
    case 'knurl': return 0.35
    case 'ridges': return 0.3
    case 'waves': return 0.3
    case 'dots': return 0.2
    case 'hex_dots': return 0.2
    case 'hexagons': return 0.2
    case 'bricks': return 0.15
    case 'weave': return 0.3
    case 'grid': return 0.15
    case 'leather': return 0.15
    case 'wood': return 0.15
    case 'stipple': return 0.08
    case 'image': return Math.max(0.01, 1 / Math.max(2, imageSize))
  }
}

/** The height of a pattern at tile coordinates (u, v), in [0, 1]. `image` is handled by the caller. */
export function patternHeight(name: PatternName, u: number, v: number, p: PatternParams): number {
  const fill = Math.min(0.95, Math.max(0.1, p.fill))
  switch (name) {
    case 'noise': return clamp01(fbm(u, v, p))
    case 'knurl': return Math.min(tri(u + v), tri(u - v))
    case 'ridges': return smooth(tri(u) / Math.max(0.05, 1 - fill))
    case 'waves': return 0.5 + 0.25 * (Math.sin(2 * Math.PI * u) + Math.sin(2 * Math.PI * v))
    case 'dots': {
      const R = 0.15 + 0.35 * fill
      const r = Math.hypot(fract(u) - 0.5, fract(v) - 0.5)
      return r >= R ? 0 : Math.sqrt(1 - (r / R) * (r / R))
    }
    case 'hex_dots': {
      const R = 0.2 + 0.3 * fill
      const { dist } = hexCell(fract(u), fract(v) * SQRT3)
      return dist >= R ? 0 : Math.sqrt(1 - (dist / R) * (dist / R))
    }
    case 'hexagons': {
      const { edge } = hexCell(fract(u), fract(v) * SQRT3)
      const groove = 0.01 + (1 - fill) * 0.16
      return smooth(edge / (groove * 1.6))
    }
    case 'bricks': {
      const row = Math.floor(fract(v) * 4)
      const off = (row & 1) * 0.25
      const bu = fract((u + off) / 0.5), bv = fract(v * 4)
      const brick = mod(Math.floor((u + off) / 0.5), 2) + 2 * row
      const mortar = 0.01 + (1 - fill) * 0.08
      const d = Math.min(Math.min(bu, 1 - bu) * 0.5, Math.min(bv, 1 - bv) * 0.25)
      return smooth(d / (mortar * 1.5)) * (0.88 + 0.12 * hash2(brick, 3, p.seed))
    }
    case 'weave': {
      const i = Math.floor(fract(u) * 2), j = Math.floor(fract(v) * 2)
      const fu = fract(u * 2), fv = fract(v * 2)
      const strand = (i + j) % 2 === 0 ? Math.sin(Math.PI * fv) : Math.sin(Math.PI * fu)
      return 0.3 + 0.7 * Math.pow(Math.max(0, strand), 0.7 + (1 - fill) * 0.8)
    }
    case 'grid': {
      const d = Math.min(tri(u), tri(v)) * 0.5
      const lw = 0.02 + 0.2 * fill
      return 1 - smooth(d / lw)
    }
    case 'leather': {
      const { f1, f2 } = worley(u, v, 4, p.seed)
      const pebble = smooth((f2 - f1) / 0.35)
      const fine = valueNoise(u * 16, v * 16, 16, p.seed + 5)
      const r = clamp01(p.roughness)
      return clamp01(pebble * (1 - 0.35 * r) + fine * 0.35 * r)
    }
    case 'wood': {
      const warp = (fbm(u, v, p) - 0.5) * (0.5 + 1.2 * clamp01(p.roughness))
      const rings = 0.5 + 0.5 * Math.sin(2 * Math.PI * (3 * u + warp))
      const fibre = valueNoise(u * 4, v * 64, 4, p.seed + 9, 64)
      return clamp01(Math.pow(rings, 1.3) * 0.85 + fibre * 0.15)
    }
    case 'stipple': {
      const cells = 8, x = fract(u) * cells, y = fract(v) * cells
      const ix = Math.floor(x), iy = Math.floor(y)
      let h = 0
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        const wx = mod(ix + i, cells), wy = mod(iy + j, cells)
        const px = ix + i + 0.2 + 0.6 * hash2(wx, wy, p.seed), py = iy + j + 0.2 + 0.6 * hash2(wx, wy, p.seed + 3)
        const R = 0.15 + 0.3 * hash2(wx, wy, p.seed + 11) * (0.4 + fill)
        const r = Math.hypot(px - x, py - y)
        if (r < R) h = Math.max(h, Math.sqrt(1 - (r / R) * (r / R)) * (0.55 + 0.45 * hash2(wx, wy, p.seed + 17)))
      }
      return h
    }
    case 'image': return 0
  }
}
