// Turning glyph contours into the closed outlines the cutter needs: flatten curves at a fixed tolerance, then a non-zero union so that
// overlapping letters (script fonts) and overlapping contours inside one glyph become one shape. Holes come out as outlines of their own.
import ClipperLib from 'clipper-lib'
import type { Ring } from './cut'

export interface PathCommand { command: string; args: number[] }

const SCALE = 10000 // clipper works on integers: 0.1 micrometre

/** Contours of a path (font units, y up), scaled, flattened with the given tolerance (in the scaled unit). */
export function flattenPath(commands: PathCommand[], scale: number, tolerance: number, dx = 0, dy = 0): Ring[] {
  const rings: Ring[] = []
  let cur: Ring | null = null
  let cx = 0, cy = 0
  const add = (x: number, y: number): void => { (cur as Ring).push([x * scale + dx, y * scale + dy]) }
  const tolU = tolerance / scale
  const quad = (x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): void => {
    const d = Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2), n = Math.max(1, Math.ceil(Math.sqrt(d / (4 * tolU))))
    for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t; add(u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2) }
  }
  const cub = (x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void => {
    const d = Math.max(Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2), Math.hypot(x1 - 2 * x2 + x3, y1 - 2 * y2 + y3)), n = Math.max(1, Math.ceil(Math.sqrt((0.75 * d) / tolU)))
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t
      add(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3)
    }
  }
  for (const c of commands) {
    const a = c.args as number[]
    if (c.command === 'moveTo') { if (cur && cur.length > 2) rings.push(cur); cur = []; add(a[0] as number, a[1] as number); cx = a[0] as number; cy = a[1] as number }
    else if (!cur) continue
    else if (c.command === 'lineTo') { add(a[0] as number, a[1] as number); cx = a[0] as number; cy = a[1] as number }
    else if (c.command === 'quadraticCurveTo') { quad(cx, cy, a[0] as number, a[1] as number, a[2] as number, a[3] as number); cx = a[2] as number; cy = a[3] as number }
    else if (c.command === 'bezierCurveTo') { cub(cx, cy, a[0] as number, a[1] as number, a[2] as number, a[3] as number, a[4] as number, a[5] as number); cx = a[4] as number; cy = a[5] as number }
    else if (c.command === 'closePath') { if (cur.length > 2) rings.push(cur); cur = null }
  }
  if (cur && (cur as Ring).length > 2) rings.push(cur)
  return rings
}

/** Non-zero union of closed contours. Returns outlines (outer boundaries and holes alike); fill them with the even-odd rule. */
export function unionNonZero(rings: Ring[]): Ring[] { return unionNonZeroTree(rings).map(x => x.ring) }

/** The same, each outline with a flag: true for a hole (inside an outer boundary or an island's hole), false for an outer boundary or an island. */
export function unionNonZeroTree(rings: Ring[]): Array<{ ring: Ring; hole: boolean }> {
  const c = new ClipperLib.Clipper()
  c.AddPaths(rings.map(r => r.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }))), ClipperLib.PolyType.ptSubject, true)
  const tree = new ClipperLib.PolyTree()
  c.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
  const out: Array<{ ring: Ring; hole: boolean }> = []
  const walk = (n: { Childs(): Array<{ Contour(): Array<{ X: number; Y: number }>; IsHole(): boolean; Childs(): unknown[] }> }): void => {
    for (const ch of n.Childs()) {
      const ring = ch.Contour().map((p): [number, number] => [p.X / SCALE, p.Y / SCALE])
      if (ring.length >= 3) out.push({ ring, hole: ch.IsHole() })
      walk(ch as unknown as Parameters<typeof walk>[0])
    }
  }
  walk(tree as unknown as Parameters<typeof walk>[0])
  return out
}

/** Union of closed contours into plain outlines (holes included, with the opposite winding). `rule` is how the contours are filled. */
export function unionRings(rings: Ring[], rule: 'nonzero' | 'evenodd'): Ring[] {
  const c = new ClipperLib.Clipper()
  c.AddPaths(rings.map(r => r.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }))), ClipperLib.PolyType.ptSubject, true)
  const out = new ClipperLib.Paths()
  const fill = rule === 'evenodd' ? ClipperLib.PolyFillType.pftEvenOdd : ClipperLib.PolyFillType.pftNonZero
  c.Execute(ClipperLib.ClipType.ctUnion, out, fill, fill)
  return out.map(p => p.map((q): [number, number] => [q.X / SCALE, q.Y / SCALE])).filter(r => r.length >= 3)
}

/** Area of a set of outlines filled with the even-odd rule: outer boundaries count, holes inside them are subtracted, islands add again. */
export function fillArea(rings: Ring[]): number {
  const area = (r: Ring): number => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i] as [number, number], q = r[(i + 1) % r.length] as [number, number]; a += p[0] * q[1] - q[0] * p[1] } return Math.abs(a) / 2 }
  const inside = (pt: [number, number], r: Ring): boolean => {
    let c = false
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[i] as [number, number], b = r[j] as [number, number]
      if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c
    }
    return c
  }
  let total = 0
  rings.forEach((r, i) => {
    let depth = 0
    rings.forEach((o, j) => { if (i !== j && inside(r[0] as [number, number], o)) depth++ })
    total += (depth % 2 === 0 ? 1 : -1) * area(r)
  })
  return total
}

export function bboxOfRings(rings: Ring[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const r of rings) for (const [x, y] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
  return [x0, y0, x1, y1]
}
