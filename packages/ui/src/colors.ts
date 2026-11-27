import { segmentTable } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'

// The colours the viewer gives the parts of a mesh, so a legend in a host shows the same ones.
export const BODY_COLOR = '#c9ccd1'
export const FALLBACK_COLORS = ['#e45756', '#4c78a8', '#54a24b', '#f2cf5b', '#b279a2', '#ff9da6', '#9d755d', '#72b7b2']
/** Colour of the part at `index` in the segment table (0 is the body), unless the part has its own colour. */
export const partColor = (index: number, own?: string): string => (index === 0 ? (own ?? BODY_COLOR) : (own ?? (FALLBACK_COLORS[index % FALLBACK_COLORS.length] as string)))

/**
 * The colour of every triangle, as a short palette and one index per triangle. A segment colour wins over the colour of the body the triangle is in;
 * the default segment (`body`) takes the body's colour, else its own, else `bodyColor`.
 */
export function triangleColors(mesh: Mesh, bodyColor: string = BODY_COLOR): { palette: string[]; index: Uint32Array } {
  const nt = mesh.indices.length / 3
  const palette: string[] = [], ids = new Map<string, number>()
  const id = (c: string): number => { let i = ids.get(c); if (i === undefined) { i = palette.length; ids.set(c, i); palette.push(c) } return i }
  const segColor = new Map<number, number>()
  segmentTable(mesh).forEach((seg, i) => segColor.set(seg.id, id(seg.id === 0 ? (seg.color ?? bodyColor) : (seg.color ?? (FALLBACK_COLORS[i % FALLBACK_COLORS.length] as string)))))
  const bodyOf = new Int32Array(nt).fill(-1)
  for (const g of mesh.groups ?? []) if (g.color) { const c = id(g.color); for (let t = g.start; t < g.start + g.count && t < nt; t++) bodyOf[t] = c }
  const base = id(bodyColor)
  const index = new Uint32Array(nt)
  for (let t = 0; t < nt; t++) {
    const label = mesh.segments ? (mesh.segments.labels[t] as number) : 0
    index[t] = (label === 0 && (bodyOf[t] as number) >= 0 ? (bodyOf[t] as number) : undefined) ?? segColor.get(label) ?? base
  }
  return { palette, index }
}
