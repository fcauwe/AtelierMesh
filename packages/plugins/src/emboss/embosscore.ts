// emboss on outlines: everything except the text itself. Input is a mesh, an anchor and closed outlines in millimetres on a flat map
// whose origin is the anchor and whose +x is the reading direction. Output is one mesh with the outlines raised or engraved.
import { longestEdgeNear, refineOnce } from './refine'
import { MeshError } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'
import { buildAdjacency, closestOnTri, faceNormal, pointOf } from './adjacency'
import { buildBvh } from './bvh'
import { imprintAndLift } from './cut'
import type { Ring } from './cut'
import { extractPatch } from './patch'
import { alignMap, arap, lscm, normaliseUV, planarUV, readingFrame, stretchStats } from './unfold'
import { vdot, vlen, vsub } from './vec'
import type { V3 } from './vec'

export interface EmbossInput {
  mesh: Mesh
  /** A point on (or near) the surface. The nearest triangle is the anchor triangle. */
  point: V3
  /** Optional surface normal at the point; the anchor triangle is then the nearest one facing that way. */
  normal?: V3
  rings: Ring[]
  /** Bounding box of the rings: [x0, y0, x1, y1]. */
  bbox: [number, number, number, number]
  height: number
  /** `flat`: the outline only recolours the surface (no height, no walls). */
  mode: 'raised' | 'engraved' | 'flat'
  /** Degrees, turns the reading direction about the normal. */
  direction?: number
  upRef?: V3
  /** Extra room around the text for the patch, mm. */
  margin?: number
  /** Name of the segment the letters get; null for none. */
  segment?: string | null
  /** Segment for the side walls; null or undefined: the walls share `segment`. */
  wallsSegment?: string | null
  /** Engraving only: the wall that must remain behind the deepest point, mm. 0 turns the check off. */
  minWall?: number
  stretchWarn?: number
  stretchRefuse?: number
  /** `band`: a rectangle along the text, for gently curved surfaces. `disk`: a circle, for strongly curved ones. */
  patch?: 'band' | 'disk'
  signal?: AbortSignal
}

export interface EmbossReport {
  anchor: { point: V3; normal: V3; triangle: number }
  up_fallback: boolean
  patch_triangles: number
  patch_shape: 'band' | 'disk'
  worst_stretch: number
  rms_stretch: number
  letter_surface_area: number
  /** Surface area of the letters times the lift: close to the volume change on a flat part. */
  volume_estimate: number
  /** Thinnest wall behind the letters found by the check (engraving), mm; null when not checked. */
  wall_behind: number | null
  attempts: number
  init: 'planar' | 'lscm'
}

export interface EmbossResult {
  mesh: Mesh
  report: EmbossReport
  warnings: Array<{ code: string; params?: Record<string, unknown> }>
}

/** Nearest triangle to a point, optionally requiring a similar normal. A linear scan; fine for the sizes we budget for. */
export function findAnchor(m: Mesh, point: V3, normal?: V3): { tri: number; point: V3; bary: V3; normal: V3 } {
  const nt = m.indices.length / 3
  if (nt === 0) throw new MeshError('emboss.no_surface')
  let best = -1, bestD = Infinity, bestPoint: V3 = point, bestBary: V3 = [1, 0, 0]
  const cosTol = Math.cos((60 * Math.PI) / 180)
  for (let pass = 0; pass < 2 && best < 0; pass++) {
    for (let t = 0; t < nt; t++) {
      if (pass === 0 && normal && vdot(faceNormal(m, t), normal) < cosTol) continue
      const r = closestOnTri(point, pointOf(m.positions, m.indices[3 * t] as number), pointOf(m.positions, m.indices[3 * t + 1] as number), pointOf(m.positions, m.indices[3 * t + 2] as number))
      const d = vlen(vsub(point, r.point))
      if (d < bestD) { bestD = d; best = t; bestPoint = r.point; bestBary = r.bary }
    }
  }
  return { tri: best, point: bestPoint, bary: bestBary, normal: faceNormal(m, best) }
}

function validateLocal(res: { mesh: Mesh; touched: number[] }, expectedBoundary: number): boolean {
  const T = res.mesh.indices
  const ed = new Map<number, { n: number; fw: number }>()
  for (const t of res.touched) for (let k = 0; k < 3; k++) {
    const a = T[3 * t + k] as number, b = T[3 * t + ((k + 1) % 3)] as number
    const key = Math.min(a, b) * 4294967296 + Math.max(a, b)
    let e = ed.get(key)
    if (!e) ed.set(key, (e = { n: 0, fw: 0 }))
    e.n++
    if (a < b) e.fw++
  }
  let boundary = 0, nonManifold = 0, wrongDir = 0
  for (const e of ed.values()) { if (e.n === 1) boundary++; else if (e.n > 2) nonManifold++; else if (e.fw !== 1) wrongDir++ }
  return nonManifold === 0 && wrongDir === 0 && boundary === expectedBoundary
}

/**
 * How much material lies behind the letters: from sample points on the letters, look inward along the surface normal and measure the
 * distance to the first triangle that is not part of the patch. The smallest distance found is returned (Infinity when nothing is hit).
 */
function wallBehind(m: Mesh, patchTris: number[], samples: Array<{ p: V3; n: V3 }>): number {
  const skip = new Uint8Array(m.indices.length / 3)
  for (const t of patchTris) skip[t] = 1
  let best = Infinity
  // many rays against a big mesh: a hierarchy pays for itself; a few rays against a small one do not need it
  const bvh = samples.length * skip.length > 2_000_000 ? buildBvh(m) : null
  const P = m.positions, T = m.indices
  for (const { p, n } of samples) {
    const d: V3 = [-n[0], -n[1], -n[2]]
    if (bvh) { const dist = bvh.rayDistance(p, d, skip); if (dist < best) best = dist; continue }
    for (let t = 0; t < skip.length; t++) {
      if (skip[t]) continue
      const a = 3 * (T[3 * t] as number), b = 3 * (T[3 * t + 1] as number), c = 3 * (T[3 * t + 2] as number)
      const e1x = (P[b] as number) - (P[a] as number), e1y = (P[b + 1] as number) - (P[a + 1] as number), e1z = (P[b + 2] as number) - (P[a + 2] as number)
      const e2x = (P[c] as number) - (P[a] as number), e2y = (P[c + 1] as number) - (P[a + 1] as number), e2z = (P[c + 2] as number) - (P[a + 2] as number)
      const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x
      const det = e1x * px + e1y * py + e1z * pz
      if (Math.abs(det) < 1e-12) continue
      const inv = 1 / det
      const tx = p[0] - (P[a] as number), ty = p[1] - (P[a + 1] as number), tz = p[2] - (P[a + 2] as number)
      const u = (tx * px + ty * py + tz * pz) * inv
      if (u < 0 || u > 1) continue
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x
      const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv
      if (v < 0 || u + v > 1) continue
      const dist = (e2x * qx + e2y * qy + e2z * qz) * inv
      if (dist > 1e-9 && dist < best) best = dist
    }
  }
  return best
}

/**
 * The cut puts its new triangles after the untouched ones. With bodies, the triangles must stay in their body's range: sort them back
 * (stable) by body, new triangles going to the body the text is on, and rewrite the ranges.
 */
function regroup(m: Mesh, out: Mesh, patchTris: number[], patchGroup: number, groupOfTri: Int32Array): Mesh {
  const inPatch = new Uint8Array(groupOfTri.length)
  for (const t of patchTris) inPatch[t] = 1
  const owner: number[] = []
  for (let t = 0; t < groupOfTri.length; t++) if (!inPatch[t]) owner.push(groupOfTri[t] as number)
  const nOut = out.indices.length / 3
  while (owner.length < nOut) owner.push(patchGroup)
  const order = Array.from({ length: nOut }, (_, i) => i).sort((a, b) => (owner[a] as number) - (owner[b] as number) || a - b)
  const idx = new Uint32Array(out.indices.length)
  const labels = out.segments ? new Uint16Array(nOut) : undefined
  order.forEach((from, to) => {
    for (let k = 0; k < 3; k++) idx[3 * to + k] = out.indices[3 * from + k] as number
    if (labels && out.segments) labels[to] = out.segments.labels[from] as number
  })
  const counts = new Array<number>((m.groups as NonNullable<Mesh['groups']>).length).fill(0)
  for (const g of owner) counts[g] = (counts[g] as number) + 1
  let start = 0
  const groups = (m.groups as NonNullable<Mesh['groups']>).map((g, gi) => { const c = { ...g, start, count: counts[gi] as number }; start += counts[gi] as number; return c })
  return { ...out, indices: idx, ...(labels && out.segments ? { segments: { labels, table: out.segments.table } } : {}), groups }
}

const shift = (rings: Ring[], dx: number, dy: number): Ring[] => rings.map(r => r.map(([x, y]) => [x + dx, y + dy] as [number, number]))

/** Most triangles a refined mesh may have; a bigger model is not coarse. */
const REFINE_MAX_TRIANGLES = 400_000
const REFINE_CODES = ['emboss.patch_not_disk', 'emboss.touches_patch_edge', 'emboss.curvature_collapse', 'emboss.fold_over']

/**
 * Text on a model made of a few big triangles has nothing to map onto, so it fails (`patch_not_disk`). When that happens and the triangles around the
 * anchor are long compared with the letters, every triangle is split in four (the shape does not change) and the text is tried again, up to four times.
 */
export function embossRings(inp: EmbossInput): EmbossResult {
  let cur = inp
  let first: unknown
  for (let round = 0; ; round++) {
    try { return embossRingsOnce(cur) } catch (e) {
      if (round === 0) first = e
      const code = e instanceof MeshError ? e.code : ''
      if (round >= 4 || !REFINE_CODES.includes(code) || cur.mesh.indices.length / 3 * 4 > REFINE_MAX_TRIANGLES) throw round === 0 ? e : first
      const [bx0, by0, bx1, by1] = cur.bbox
      const reach = Math.hypot(bx1 - bx0, by1 - by0) / 2 + (cur.margin ?? 6)
      if (longestEdgeNear(cur.mesh, cur.point, reach) < reach / 5) throw first
      cur = { ...cur, mesh: refineOnce(cur.mesh) }
    }
  }
}

function embossRingsOnce(inp: EmbossInput): EmbossResult {
  const m = inp.mesh
  if (inp.rings.length === 0) throw new MeshError('emboss.empty_shape')
  if (!(inp.height > 0)) throw new MeshError('emboss.bad_height', { height: inp.height })
  const margin = inp.margin ?? 6
  const warn = inp.stretchWarn ?? 1.15, refuse = inp.stretchRefuse ?? 1.5
  const warnings: EmbossResult['warnings'] = []
  const anchor = findAnchor(m, inp.point, inp.normal)
  // bodies (mesh groups) must be a clean partition: contiguous ranges that cover every triangle, and the text goes on a solid one
  const nTri0 = m.indices.length / 3
  let groupOfTri: Int32Array | null = null
  if (m.groups && m.groups.length > 0) {
    groupOfTri = new Int32Array(nTri0).fill(-1)
    m.groups.forEach((g, gi) => { for (let t = g.start; t < Math.min(nTri0, g.start + g.count); t++) groupOfTri![t] = gi })
    if (groupOfTri.includes(-1)) throw new MeshError('emboss.groups_unsupported', { reason: 'groups_do_not_cover_the_mesh' })
  }
  const adj = buildAdjacency(m.indices)
  if (adj.nonManifold > 0) throw new MeshError('emboss.mesh_not_manifold', { edges: adj.nonManifold })
  // a closed mesh with its triangles facing inward would get its letters pushed into the part: say so
  if (!adj.adj.includes(-1)) {
    let vol = 0
    const P = m.positions, T = m.indices
    for (let t = 0; t < T.length; t += 3) {
      const a = 3 * (T[t] as number), b = 3 * (T[t + 1] as number), c = 3 * (T[t + 2] as number)
      vol += (P[a] as number) * ((P[b + 1] as number) * (P[c + 2] as number) - (P[b + 2] as number) * (P[c + 1] as number)) - (P[a + 1] as number) * ((P[b] as number) * (P[c + 2] as number) - (P[b + 2] as number) * (P[c] as number)) + (P[a + 2] as number) * ((P[b] as number) * (P[c + 1] as number) - (P[b + 1] as number) * (P[c] as number))
    }
    if (vol < 0) throw new MeshError('emboss.inside_out')
  }
  const anchorGroup = groupOfTri ? (groupOfTri[anchor.tri] as number) : -1
  if (groupOfTri && m.groups && (m.groups[anchorGroup] as { role: string }).role === 'negative') throw new MeshError('emboss.on_negative_body')
  const fr = readingFrame(anchor.normal, inp.upRef ?? [0, 0, 1], inp.direction ?? 0)
  const [bx0, by0, bx1, by1] = inp.bbox
  const halfDiag = Math.hypot(bx1 - bx0, by1 - by0) / 2
  const shape = inp.patch ?? 'disk'
  let accept: (t: number) => boolean
  if (shape === 'band') {
    const rect = [bx0 - margin, by0 - margin, bx1 + margin, by1 + margin]
    accept = tt => {
      const c: V3 = [0, 0, 0]
      for (let k = 0; k < 3; k++) { const v = m.indices[3 * tt + k] as number; c[0] += (m.positions[3 * v] as number) / 3; c[1] += (m.positions[3 * v + 1] as number) / 3; c[2] += (m.positions[3 * v + 2] as number) / 3 }
      const d = vsub(c, anchor.point)
      const u = vdot(d, fr.ex), v = vdot(d, fr.ey)
      return u >= (rect[0] as number) && u <= (rect[2] as number) && v >= (rect[1] as number) && v <= (rect[3] as number)
    }
  } else {
    const R = halfDiag + margin
    accept = tt => {
      const r = closestOnTri(anchor.point, pointOf(m.positions, m.indices[3 * tt] as number), pointOf(m.positions, m.indices[3 * tt + 1] as number), pointOf(m.positions, m.indices[3 * tt + 2] as number))
      return vlen(vsub(r.point, anchor.point)) <= R
    }
  }
  const patch = extractPatch(m, adj, anchor.tri, accept, { maxNormalDeg: 100, creaseDeg: 40 })
  if (!patch.topology.disk) throw new MeshError('emboss.patch_not_disk', { euler: patch.topology.euler, loops: patch.topology.loops })
  if (inp.signal?.aborted) throw new MeshError('run.cancelled')

  // unfold: start from a plain projection; only when a fold-over survives, restart from LSCM
  let pa = 0, best = Infinity
  for (let v = 0; v < patch.nv; v++) { const d = vlen(vsub(pointOf(patch.P, v), anchor.point)); if (d < best) { best = d; pa = v } }
  let pb = 0, far = -1
  const pA = pointOf(patch.P, pa)
  for (let v = 0; v < patch.nv; v++) { const d = vlen(vsub(pointOf(patch.P, v), pA)); if (d > far) { far = d; pb = v } }
  let uv = arap(patch, planarUV(patch, anchor.point, fr.ex, fr.ey), pa, 6, 0, 1e-5, 800)
  let init: 'planar' | 'lscm' = 'planar'
  if (stretchStats(patch, uv).flips > 0) {
    uv = arap(patch, normaliseUV(patch, lscm(patch, pa, pb, far, 1e-6)), pa, 6, 0, 1e-5, 800)
    init = 'lscm'
  }
  uv = alignMap(patch, uv, anchor.bary, fr.ex)
  // stretch under the letters: triangles whose map position overlaps the text box
  const under: number[] = []
  for (let t = 0; t < patch.nt; t++) {
    const xs = [0, 1, 2].map(k => uv[2 * (patch.T[3 * t + k] as number)] as number), ys = [0, 1, 2].map(k => uv[2 * (patch.T[3 * t + k] as number) + 1] as number)
    if (Math.max(...xs) >= bx0 && Math.min(...xs) <= bx1 && Math.max(...ys) >= by0 && Math.min(...ys) <= by1) under.push(t)
  }
  const stretch = stretchStats(patch, uv, under)
  if (stretch.flips > 0) throw new MeshError('emboss.fold_over', { triangles: stretch.flips })
  if (stretch.maxStretch > refuse) throw new MeshError('emboss.too_much_stretch', { stretch: stretch.maxStretch, limit: refuse })
  if (stretch.maxStretch > warn) warnings.push({ code: 'emboss.stretch', params: { stretch: stretch.maxStretch, limit: warn } })

  // cut and lift, with a few retries on other tolerances and tiny shifts when the local check fails
  const tries: Array<{ eps: number; dx: number; dy: number }> = [
    { eps: 1e-3, dx: 0, dy: 0 }, { eps: 3e-3, dx: 0, dy: 0 }, { eps: 1e-4, dx: 0, dy: 0 },
    { eps: 1e-3, dx: 0.0137, dy: -0.0091 }, { eps: 3e-3, dx: -0.0213, dy: 0.0177 }, { eps: 1e-2, dx: 0, dy: 0 },
  ]
  let last: MeshError | null = null
  for (let i = 0; i < tries.length; i++) {
    const t = tries[i] as { eps: number; dx: number; dy: number }
    if (inp.signal?.aborted) throw new MeshError('run.cancelled')
    try {
      const res = imprintAndLift(m, patch, uv, t.dx || t.dy ? shift(inp.rings, t.dx, t.dy) : inp.rings, { height: inp.height, mode: inp.mode, eps: t.eps, segment: inp.segment === undefined ? 'text' : inp.segment, wallsSegment: inp.wallsSegment ?? null })
      if (res.stats.inverted > 0) throw new MeshError('emboss.curvature_collapse', { triangles: res.stats.inverted })
      if (!validateLocal(res, patch.topology.boundaryEdges)) { last = new MeshError('emboss.invalid_result', { attempt: i + 1 }); continue }
      let wall: number | null = null
      if (inp.mode === 'engraved' && (inp.minWall ?? 0.4) > 0) {
        wall = wallBehind(m, patch.gtris, res.samples)
        const need = inp.height + (inp.minWall ?? 0.4)
        if (wall < need) throw new MeshError('emboss.wall_too_thin', { available: wall, depth: inp.height, needed: need, fit_height: Math.max(0, Math.floor((wall - (inp.minWall ?? 0.4)) * 10) / 10) })
      }
      let outMesh = res.mesh
      if (groupOfTri && m.groups) outMesh = regroup(m, res.mesh, patch.gtris, anchorGroup, groupOfTri)
      return {
        mesh: outMesh, warnings,
        report: {
          anchor: { point: anchor.point, normal: anchor.normal, triangle: anchor.tri }, up_fallback: fr.fallback, patch_triangles: patch.nt, patch_shape: shape,
          worst_stretch: stretch.maxStretch, rms_stretch: stretch.rmsStretch, letter_surface_area: res.stats.insideSurfaceArea,
          volume_estimate: inp.mode === 'flat' ? 0 : res.stats.insideSurfaceArea * inp.height * (inp.mode === 'engraved' ? -1 : 1), wall_behind: wall, attempts: i + 1, init,
        },
      }
    } catch (e) {
      // problems with the request itself are final; numerical trouble is worth another try
      // text that runs past the patch: say whether growth stopped at a sharp edge (a corner of the part), so the page can word it
      if (e instanceof MeshError && e.code === 'emboss.touches_patch_edge') throw new MeshError(e.code, { ...e.params, stopped_at_crease: patch.stoppedAtCrease > 0 }, e.path)
      if (e instanceof MeshError && ['emboss.curvature_collapse', 'emboss.wall_too_thin'].includes(e.code)) throw e
      last = e instanceof MeshError ? e : new MeshError('emboss.cut_failed', { message: String(e) })
    }
  }
  throw last ?? new MeshError('emboss.invalid_result')
}

