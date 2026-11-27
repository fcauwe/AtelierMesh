// Parts with overhangs whose figures can be worked out by hand.
import { measureMesh } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'

const fix = (m: Mesh): Mesh => {
  if (measureMesh(m).volume >= 0) return m
  const idx = m.indices.slice()
  for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1] as number; idx[i + 1] = idx[i + 2] as number; idx[i + 2] = t }
  return { ...m, indices: idx }
}

/**
 * A T-beam: bar x 0..40, z 20..30; stem x 15..25, z 0..20; extruded along y from 0 to `depth`.
 * Stem down: the bar's underside sticks out 15 on each side, so the overhang is 30 * depth. Bar down: no overhang.
 */
export function tBeam(depth: number): Mesh {
  const prof: Array<[number, number]> = [[15, 0], [25, 0], [25, 20], [40, 20], [40, 30], [0, 30], [0, 20], [15, 20]]
  const tris = [[0, 1, 2], [0, 2, 7], [6, 7, 5], [7, 2, 5], [2, 4, 5], [2, 3, 4]]
  const n = prof.length
  const pos: number[] = []
  for (const [x, z] of prof) pos.push(x, 0, z)
  for (const [x, z] of prof) pos.push(x, depth, z)
  const idx: number[] = []
  for (const [a, b, c] of tris as Array<[number, number, number]>) { idx.push(a, b, c); idx.push(n + a, n + c, n + b) }
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; idx.push(i, n + j, j, i, n + i, n + j) }
  return fix({ positions: Float64Array.from(pos), indices: Uint32Array.from(idx) })
}

/** A mushroom: stem radius 5 up to z 20, cap radius 20 from z 20 to 25. A revolved profile with `seg` sides. */
export function mushroom(seg = 96): Mesh {
  const prof: Array<[number, number]> = [[0, 0], [5, 0], [5, 20], [20, 20], [20, 25], [0, 25]]
  const pos: number[] = [], ring: Array<number | number[]> = []
  for (const [r, z] of prof) {
    if (r === 0) { ring.push(pos.length / 3); pos.push(0, 0, z) } else {
      const ids: number[] = []
      for (let i = 0; i < seg; i++) { const a = (2 * Math.PI * i) / seg; ids.push(pos.length / 3); pos.push(r * Math.cos(a), r * Math.sin(a), z) }
      ring.push(ids)
    }
  }
  const idx: number[] = []
  for (let e = 0; e < prof.length; e++) {
    const f = ring[e] as number | number[], g = ring[(e + 1) % prof.length] as number | number[]
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg
      if (Array.isArray(f) && Array.isArray(g)) idx.push(f[i] as number, g[j] as number, g[i] as number, f[i] as number, f[j] as number, g[j] as number)
      else if (Array.isArray(g)) idx.push(f as number, g[j] as number, g[i] as number)
      else if (Array.isArray(f)) idx.push(f[i] as number, f[j] as number, g as number)
    }
  }
  return fix({ positions: Float64Array.from(pos), indices: Uint32Array.from(idx) })
}

/** Area of a regular `seg`-gon with circumradius r. */
export const polygonArea = (r: number, seg = 96): number => (seg / 2) * Math.sin((2 * Math.PI) / seg) * r * r

/** Ear clipping of a simple polygon given counter-clockwise; returns triangles as index triples. */
function earClip(poly: Array<[number, number]>): Array<[number, number, number]> {
  const ids = poly.map((_, i) => i), out: Array<[number, number, number]> = []
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  let guard = 0
  while (ids.length > 3 && guard++ < 1000) {
    let cut = false
    for (let i = 0; i < ids.length && !cut; i++) {
      const a = ids[(i + ids.length - 1) % ids.length] as number, b = ids[i] as number, c = ids[(i + 1) % ids.length] as number
      const pa = poly[a] as [number, number], pb = poly[b] as [number, number], pc = poly[c] as [number, number]
      if (cross(pa, pb, pc) <= 1e-12) continue
      const inside = ids.some(k => k !== a && k !== b && k !== c && cross(pa, pb, poly[k] as [number, number]) >= 0 && cross(pb, pc, poly[k] as [number, number]) >= 0 && cross(pc, pa, poly[k] as [number, number]) >= 0)
      if (inside) continue
      out.push([a, b, c]); ids.splice(i, 1); cut = true
    }
    if (!cut) break
  }
  out.push([ids[0] as number, ids[1] as number, ids[2] as number])
  return out
}

/** A profile in (x, z), extruded along y from 0 to `depth`: any simple polygon, in either winding. */
export function prism(profile: Array<[number, number]>, depth: number): Mesh {
  let area = 0
  for (let i = 0; i < profile.length; i++) { const [x0, z0] = profile[i] as [number, number], [x1, z1] = profile[(i + 1) % profile.length] as [number, number]; area += x0 * z1 - x1 * z0 }
  const prof = area < 0 ? profile.slice().reverse() : profile
  const n = prof.length, pos: number[] = []
  for (const [x, z] of prof) pos.push(x, 0, z)
  for (const [x, z] of prof) pos.push(x, depth, z)
  const idx: number[] = []
  for (const [a, b, c] of earClip(prof)) { idx.push(a, c, b); idx.push(n + a, n + b, n + c) }
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; idx.push(i, j, n + j, i, n + j, n + i) }
  return fix({ positions: Float64Array.from(pos), indices: Uint32Array.from(idx) })
}

/** A solid of revolution about Z: a profile of (radius, z) from the bottom centre round to the top centre. */
export function lathe(prof: Array<[number, number]>, seg = 48): Mesh {
  const pos: number[] = [], rings: Array<number | number[]> = []
  for (const [r, z] of prof) {
    if (r === 0) { rings.push(pos.length / 3); pos.push(0, 0, z) } else { const ids: number[] = []; for (let i = 0; i < seg; i++) { const a = (2 * Math.PI * i) / seg; ids.push(pos.length / 3); pos.push(r * Math.cos(a), r * Math.sin(a), z) } rings.push(ids) }
  }
  const idx: number[] = []
  for (let e = 0; e + 1 < prof.length; e++) {
    const f = rings[e] as number | number[], g = rings[e + 1] as number | number[]
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg
      if (Array.isArray(f) && Array.isArray(g)) idx.push(f[i] as number, g[j] as number, g[i] as number, f[i] as number, f[j] as number, g[j] as number)
      else if (Array.isArray(g)) idx.push(f as number, g[j] as number, g[i] as number)
      else if (Array.isArray(f)) idx.push(f[i] as number, f[j] as number, g as number)
    }
  }
  return fix({ positions: Float64Array.from(pos), indices: Uint32Array.from(idx) })
}
