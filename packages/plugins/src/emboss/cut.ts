// Cutting the letters into the surface: the letter outlines and the mesh edges of the patch are put in one planar graph on the map,
// triangulated with a constrained Delaunay triangulation, classified inside or outside the letters, and lifted along the patch normals.
// The result is the original mesh with the patch replaced, in one set of arrays. No boolean operation.
import cdt2d from 'cdt2d'
import { MeshError } from '@ateliermesh/core'
import type { Mesh, SegmentInfo } from '@ateliermesh/core'
import type { Patch } from './patch'
import { vadd, vcross, vdot, vlen, vnorm, vscale, vsub } from './vec'
import type { V3 } from './vec'

/** One closed outline on the map, in mm. Fill is even-odd over all outlines, so holes are simply more outlines. */
export type Ring = Array<[number, number]>

export interface CutOptions {
  height: number
  /** `flat`: nothing is lifted and no walls are made; the outline only gives the surface inside it the segment. */
  mode: 'raised' | 'engraved' | 'flat'
  /** Points closer than this on the map are the same point (mm). */
  eps: number
  /** Name of the segment given to the letter tops and walls; null for none. */
  segment: string | null
  /** Name of the segment for the side walls (raised and engraved); null or undefined: the walls share `segment`. */
  wallsSegment?: string | null
}

export interface CutResult {
  mesh: Mesh
  /** Triangles added by the cut (indices into `mesh.indices`), for the local check. */
  touched: number[]
  /** Points on the letters (position and lift normal), at most a few hundred, for the wall check. */
  samples: Array<{ p: V3; n: V3 }>
  stats: { inverted: number; letterSegments: number; crossings: number; insideTriangles: number; walls: number; insideSurfaceArea: number; boundaryPts: number; interiorPts: number; newPts: number }
}

class PointStore {
  x: number[] = []
  y: number[] = []
  private g = new Map<string, number[]>()
  private cs = 0.01
  constructor(private eps: number) {}
  private cell(v: number): number { return Math.floor(v / this.cs) }
  find(x: number, y: number): number {
    const cx = this.cell(x), cy = this.cell(y)
    for (let i = cx - 1; i <= cx + 1; i++) for (let j = cy - 1; j <= cy + 1; j++) {
      const l = this.g.get(`${i},${j}`)
      if (l) for (const id of l) if (Math.hypot((this.x[id] as number) - x, (this.y[id] as number) - y) <= this.eps) return id
    }
    return -1
  }
  add(x: number, y: number): number {
    const f = this.find(x, y)
    if (f >= 0) return f
    const id = this.x.length
    this.x.push(x); this.y.push(y)
    const k = `${this.cell(x)},${this.cell(y)}`
    let l = this.g.get(k)
    if (!l) this.g.set(k, (l = []))
    l.push(id)
    return id
  }
  get n(): number { return this.x.length }
}

interface Split { id: number; t: number }
interface Seg { a: number; b: number; splits: Split[] }

function lineDist(ax: number, ay: number, bx: number, by: number, px: number, py: number): { d: number; t: number; L: number } {
  const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy)
  return { d: (dx * (py - ay) - dy * (px - ax)) / L, t: ((px - ax) * dx + (py - ay) * dy) / L, L }
}

const fail = (reason: string, extra: Record<string, unknown> = {}): MeshError => new MeshError('emboss.cut_failed', { reason, ...extra })

export function imprintAndLift(m: Mesh, patch: Patch, uv: Float64Array, rings: Ring[], opts: CutOptions): CutResult {
  const { height, mode, eps } = opts
  const ps = new PointStore(eps)
  for (let v = 0; v < patch.nv; v++) { if (ps.add(uv[2 * v] as number, uv[2 * v + 1] as number) !== v) throw fail('fold_over') }
  const segs: Seg[] = []
  for (const ring of rings) {
    const ids: number[] = []
    for (const [x, y] of ring) { const id = ps.add(x, y); if (ids.length === 0 || ids[ids.length - 1] !== id) ids.push(id) }
    if (ids.length > 1 && ids[0] === ids[ids.length - 1]) ids.pop()
    for (let i = 0; i < ids.length; i++) { const a = ids[i] as number, b = ids[(i + 1) % ids.length] as number; if (a !== b) segs.push({ a, b, splits: [] }) }
  }
  const edges = new Map<number, Seg>()
  for (let t = 0; t < patch.nt; t++) for (let k = 0; k < 3; k++) {
    const a = patch.T[3 * t + k] as number, b = patch.T[3 * t + ((k + 1) % 3)] as number, lo = Math.min(a, b), hi = Math.max(a, b), key = lo * patch.nv + hi
    if (!edges.has(key)) edges.set(key, { a: lo, b: hi, splits: [] })
  }
  const E = Array.from(edges.values())
  // intersections of mesh edges with letter segments (uniform grid over the letter segments)
  const cs = 2, grid = new Map<string, number[]>(), gk = (i: number, j: number): string => `${i},${j}`
  segs.forEach((s, si) => {
    const x0 = Math.min(ps.x[s.a] as number, ps.x[s.b] as number), x1 = Math.max(ps.x[s.a] as number, ps.x[s.b] as number)
    const y0 = Math.min(ps.y[s.a] as number, ps.y[s.b] as number), y1 = Math.max(ps.y[s.a] as number, ps.y[s.b] as number)
    for (let i = Math.floor(x0 / cs); i <= Math.floor(x1 / cs); i++) for (let j = Math.floor(y0 / cs); j <= Math.floor(y1 / cs); j++) {
      const k = gk(i, j)
      let l = grid.get(k)
      if (!l) grid.set(k, (l = []))
      l.push(si)
    }
  })
  let crossings = 0
  const addSplit = (arr: Split[], id: number, t: number): void => { if (!arr.some(s => s.id === id)) arr.push({ id, t }) }
  for (const e of E) {
    const ax = ps.x[e.a] as number, ay = ps.y[e.a] as number, bx = ps.x[e.b] as number, by = ps.y[e.b] as number
    const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by)
    const cand = new Set<number>()
    for (let i = Math.floor(x0 / cs); i <= Math.floor(x1 / cs); i++) for (let j = Math.floor(y0 / cs); j <= Math.floor(y1 / cs); j++) for (const si of grid.get(gk(i, j)) ?? []) cand.add(si)
    for (const si of cand) {
      const s = segs[si] as Seg
      const px = ps.x[s.a] as number, py = ps.y[s.a] as number, qx = ps.x[s.b] as number, qy = ps.y[s.b] as number
      if (Math.max(px, qx) < x0 - eps || Math.min(px, qx) > x1 + eps || Math.max(py, qy) < y0 - eps || Math.min(py, qy) > y1 + eps) continue
      const dp = lineDist(ax, ay, bx, by, px, py), dq = lineDist(ax, ay, bx, by, qx, qy), da = lineDist(px, py, qx, qy, ax, ay), db = lineDist(px, py, qx, qy, bx, by)
      let handled = false
      for (const [id, d] of [[s.a, dp], [s.b, dq]] as const) if (Math.abs(d.d) <= eps && d.t > eps && d.t < d.L - eps) { addSplit(e.splits, id, d.t); handled = true }
      for (const [id, d] of [[e.a, da], [e.b, db]] as const) if (Math.abs(d.d) <= eps && d.t > eps && d.t < d.L - eps) { addSplit(s.splits, id, d.t); handled = true }
      if (handled) continue
      if (dp.d * dq.d < 0 && Math.abs(dp.d) > eps && Math.abs(dq.d) > eps && da.d * db.d < 0 && Math.abs(da.d) > eps && Math.abs(db.d) > eps) {
        const tt = dp.d / (dp.d - dq.d), X = px + (qx - px) * tt, Y = py + (qy - py) * tt, id = ps.add(X, Y)
        crossings++
        if (id !== e.a && id !== e.b) addSplit(e.splits, id, Math.hypot((ps.x[id] as number) - ax, (ps.y[id] as number) - ay))
        if (id !== s.a && id !== s.b) addSplit(s.splits, id, Math.hypot((ps.x[id] as number) - px, (ps.y[id] as number) - py))
      }
    }
  }
  // constraint edges: every mesh edge and every letter segment, cut at their intersections
  const cset = new Set<number>(), cedges: Array<[number, number]> = []
  const emit = (a: number, b: number): void => { if (a === b) return; const lo = Math.min(a, b), hi = Math.max(a, b), k = lo * 4294967296 + hi; if (!cset.has(k)) { cset.add(k); cedges.push([lo, hi]) } }
  for (const it of [...E, ...segs]) {
    const ch = [it.a, ...it.splits.sort((p, q) => p.t - q.t).map(s => s.id), it.b]
    for (let i = 0; i + 1 < ch.length; i++) emit(ch[i] as number, ch[i + 1] as number)
  }
  const pts = ps.x.map((x, i): [number, number] => [x, ps.y[i] as number])
  let tris: Array<[number, number, number]>
  try { tris = cdt2d(pts, cedges, { exterior: true, interior: true }) } catch (err) { throw fail('triangulation_failed', { message: err instanceof Error ? err.message : String(err) }) }
  // the outside of the patch: triangles reachable from the hull without crossing a constraint (cdt2d's own removal is parity based and
  // drops every second layer when all mesh edges are constraints)
  const ekey = (u: number, v: number): number => Math.min(u, v) * 4294967296 + Math.max(u, v)
  const emap = new Map<number, number[]>()
  tris.forEach((tr, i) => { for (let k = 0; k < 3; k++) { const key = ekey(tr[k] as number, tr[(k + 1) % 3] as number); let l = emap.get(key); if (!l) emap.set(key, (l = [])); l.push(i) } })
  const outside = new Uint8Array(tris.length), stack: number[] = []
  for (const [key, l] of emap) if (l.length === 1 && !cset.has(key) && !outside[l[0] as number]) { outside[l[0] as number] = 1; stack.push(l[0] as number) }
  while (stack.length > 0) {
    const i = stack.pop() as number, tr = tris[i] as [number, number, number]
    for (let k = 0; k < 3; k++) {
      const key = ekey(tr[k], tr[(k + 1) % 3])
      if (cset.has(key)) continue
      for (const j of emap.get(key) as number[]) if (!outside[j]) { outside[j] = 1; stack.push(j) }
    }
  }
  tris = tris.filter((_, i) => !outside[i])
  for (const t of tris) {
    const a = t[0], b = t[1], c = t[2]
    if (((ps.x[b] as number) - (ps.x[a] as number)) * ((ps.y[c] as number) - (ps.y[a] as number)) - ((ps.y[b] as number) - (ps.y[a] as number)) * ((ps.x[c] as number) - (ps.x[a] as number)) < 0) { t[1] = c; t[2] = b }
  }
  // classify by the centroid: even-odd over all outlines
  const rb = rings.map(r => { let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (const [x, y] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) } return [x0, y0, x1, y1] as const })
  const inside = (x: number, y: number): boolean => {
    let c = 0
    rings.forEach((R, ri) => {
      const b = rb[ri] as readonly number[]
      if (x < (b[0] as number) || x > (b[2] as number) || y < (b[1] as number) || y > (b[3] as number)) return
      for (let i = 0, j = R.length - 1; i < R.length; j = i++) {
        const a = R[i] as [number, number], bb = R[j] as [number, number]
        if ((a[1] > y) !== (bb[1] > y) && x < ((bb[0] - a[0]) * (y - a[1])) / (bb[1] - a[1]) + a[0]) c ^= 1
      }
    })
    return c === 1
  }
  const isIn = tris.map(t => inside(((ps.x[t[0]] as number) + (ps.x[t[1]] as number) + (ps.x[t[2]] as number)) / 3, ((ps.y[t[0]] as number) + (ps.y[t[1]] as number) + (ps.y[t[2]] as number)) / 3))

  // 3D position and lift normal of every point: mesh vertices directly, imprint points by barycentric location in the patch triangle
  const tcs = 1.5, tk = (i: number, j: number): string => `${i},${j}`
  const tg = new Map<string, number[]>()
  for (let t = 0; t < patch.nt; t++) {
    const ids = [0, 1, 2].map(k => patch.T[3 * t + k] as number)
    const xs = ids.map(i => ps.x[i] as number), ys = ids.map(i => ps.y[i] as number)
    for (let i = Math.floor(Math.min(...xs) / tcs); i <= Math.floor(Math.max(...xs) / tcs); i++) for (let j = Math.floor(Math.min(...ys) / tcs); j <= Math.floor(Math.max(...ys) / tcs); j++) {
      let l = tg.get(tk(i, j))
      if (!l) tg.set(tk(i, j), (l = []))
      l.push(t)
    }
  }
  const locate = (x: number, y: number): { t: number; l: V3; min: number } | null => {
    let best: { t: number; l: V3; min: number } | null = null
    for (const t of tg.get(tk(Math.floor(x / tcs), Math.floor(y / tcs))) ?? []) {
      const i0 = patch.T[3 * t] as number, i1 = patch.T[3 * t + 1] as number, i2 = patch.T[3 * t + 2] as number
      const d = ((ps.x[i1] as number) - (ps.x[i0] as number)) * ((ps.y[i2] as number) - (ps.y[i0] as number)) - ((ps.y[i1] as number) - (ps.y[i0] as number)) * ((ps.x[i2] as number) - (ps.x[i0] as number))
      const l1 = ((x - (ps.x[i0] as number)) * ((ps.y[i2] as number) - (ps.y[i0] as number)) - (y - (ps.y[i0] as number)) * ((ps.x[i2] as number) - (ps.x[i0] as number))) / d
      const l2 = (((ps.x[i1] as number) - (ps.x[i0] as number)) * (y - (ps.y[i0] as number)) - ((ps.y[i1] as number) - (ps.y[i0] as number)) * (x - (ps.x[i0] as number))) / d
      const mn = Math.min(1 - l1 - l2, l1, l2)
      if (!best || mn > best.min) best = { t, l: [1 - l1 - l2, l1, l2], min: mn }
    }
    return best
  }
  const P3: Array<V3 | null> = new Array<V3 | null>(ps.n).fill(null), N3: V3[] = new Array<V3>(ps.n)
  const pn = new Float64Array(3 * patch.nv)  // angle-weighted normals from the PATCH faces only, so a sharp edge outside cannot tilt the lift
  for (let tt = 0; tt < patch.nt; tt++) {
    const i = [0, 1, 2].map(k => patch.T[3 * tt + k] as number)
    const p = i.map(k => [patch.P[3 * k] as number, patch.P[3 * k + 1] as number, patch.P[3 * k + 2] as number] as V3)
    const fn = vnorm(vcross(vsub(p[1] as V3, p[0] as V3), vsub(p[2] as V3, p[0] as V3)))
    for (let k = 0; k < 3; k++) {
      const e1 = vnorm(vsub(p[(k + 1) % 3] as V3, p[k] as V3)), e2 = vnorm(vsub(p[(k + 2) % 3] as V3, p[k] as V3))
      const ang = Math.acos(Math.max(-1, Math.min(1, vdot(e1, e2))))
      for (let r = 0; r < 3; r++) pn[3 * (i[k] as number) + r] = (pn[3 * (i[k] as number) + r] as number) + (fn[r] as number) * ang
    }
  }
  for (let v = 0; v < patch.nv; v++) {
    const g = patch.gverts[v] as number
    P3[v] = [m.positions[3 * g] as number, m.positions[3 * g + 1] as number, m.positions[3 * g + 2] as number]
    N3[v] = vnorm([pn[3 * v] as number, pn[3 * v + 1] as number, pn[3 * v + 2] as number])
  }
  let unlocated = 0
  for (let id = patch.nv; id < ps.n; id++) {
    const loc = locate(ps.x[id] as number, ps.y[id] as number)
    if (!loc || loc.min < -1e-6) { unlocated++; continue }
    const ids = [patch.T[3 * loc.t] as number, patch.T[3 * loc.t + 1] as number, patch.T[3 * loc.t + 2] as number]
    let p: V3 = [0, 0, 0], n: V3 = [0, 0, 0]
    for (let k = 0; k < 3; k++) { p = vadd(p, vscale(P3[ids[k] as number] as V3, loc.l[k] as number)); n = vadd(n, vscale(N3[ids[k] as number] as V3, loc.l[k] as number)) }
    P3[id] = p; N3[id] = vnorm(n)
  }
  if (unlocated > 0) throw new MeshError('emboss.touches_patch_edge', { reason: 'outside_patch', points: unlocated })

  // incidence: how many inside and outside triangles each point touches
  const inC = new Int32Array(ps.n), outC = new Int32Array(ps.n)
  tris.forEach((t, i) => { for (const v of t) (isIn[i] ? inC : outC)[v] = ((isIn[i] ? inC : outC)[v] as number) + 1 })
  for (let v = 0; v < patch.nv; v++) if (patch.boundaryVerts[v] && (inC[v] as number) > 0) throw new MeshError('emboss.touches_patch_edge')

  // assemble: the untouched part of the mesh is copied, the patch is replaced
  const flat = mode === 'flat'
  const sgn = mode === 'engraved' ? -1 : 1
  const baseId = new Int32Array(ps.n).fill(-1), movedId = new Int32Array(ps.n).fill(-1)
  const lifted = (id: number): V3 => (flat ? (P3[id] as V3) : vadd(P3[id] as V3, vscale(N3[id] as V3, sgn * height)))
  const nvOrig = m.positions.length / 3
  let nNew = 0
  for (let id = 0; id < ps.n; id++) {
    const isMesh = id < patch.nv
    if (inC[id] === 0) { if (!isMesh) nNew++ } else if (outC[id] === 0) { if (!isMesh) nNew++ } else { if (!isMesh) nNew++; if (!flat) nNew++ }
  }
  const P = new Float64Array(3 * (nvOrig + nNew))
  P.set(m.positions)
  let nextV = nvOrig
  const pushV = (p: V3): number => { P[3 * nextV] = p[0]; P[3 * nextV + 1] = p[1]; P[3 * nextV + 2] = p[2]; return nextV++ }
  let boundaryPts = 0, interiorPts = 0, newPts = 0
  for (let id = 0; id < ps.n; id++) {
    const isMesh = id < patch.nv, g = isMesh ? (patch.gverts[id] as number) : -1
    if (inC[id] === 0) { if (isMesh) baseId[id] = g; else { newPts++; baseId[id] = pushV(P3[id] as V3) } continue }
    if (outC[id] === 0) {
      interiorPts++
      if (isMesh) { const q = lifted(id); P[3 * g] = q[0]; P[3 * g + 1] = q[1]; P[3 * g + 2] = q[2]; movedId[id] = g; baseId[id] = g }
      else { newPts++; movedId[id] = pushV(lifted(id)); baseId[id] = movedId[id] as number }
      continue
    }
    boundaryPts++
    if (isMesh) baseId[id] = g; else { newPts++; baseId[id] = pushV(P3[id] as V3) }
    movedId[id] = flat ? (baseId[id] as number) : pushV(lifted(id))
  }
  const edgeTris = new Map<number, Array<{ i: number; a: number; b: number }>>()
  tris.forEach((tr, i) => { for (let k = 0; k < 3; k++) { const a = tr[k] as number, b = tr[(k + 1) % 3] as number, key = ekey(a, b); let l = edgeTris.get(key); if (!l) edgeTris.set(key, (l = [])); l.push({ i, a, b }) } })
  const walls: Array<{ i: number; a: number; b: number }> = []
  for (const l of edgeTris.values()) { if (l.length !== 2) continue; const [p, q] = l as [{ i: number; a: number; b: number }, { i: number; a: number; b: number }]; if (flat || isIn[p.i] === isIn[q.i]) continue; walls.push(isIn[p.i] ? p : q) }
  const nOrig = m.indices.length / 3
  const keep = new Uint8Array(nOrig).fill(1)
  for (const g of patch.gtris) keep[g] = 0
  const nKeep = nOrig - patch.gtris.length, nOut = nKeep + tris.length + 2 * walls.length
  const T = new Uint32Array(3 * nOut)

  // segments: kept triangles keep their label, new surface triangles take the label of the patch triangle under them, letters get the new one
  const table: SegmentInfo[] = m.segments ? m.segments.table.map(s => ({ ...s })) : [{ id: 0, name: 'body' }]
  let textId = -1
  if (opts.segment !== null) {
    const found = table.find(s => s.name === opts.segment)
    if (found) textId = found.id
    else { textId = table.reduce((mx, s) => Math.max(mx, s.id), 0) + 1; table.push({ id: textId, name: opts.segment }) }
  }
  // the side walls: their own segment when asked for, otherwise they share the surface segment
  let wallsId = textId
  if (!flat && opts.wallsSegment) {
    const found = table.find(s => s.name === opts.wallsSegment)
    if (found) wallsId = found.id
    else { wallsId = table.reduce((mx, s) => Math.max(mx, s.id), 0) + 1; table.push({ id: wallsId, name: opts.wallsSegment }) }
  }
  const useLabels = m.segments !== undefined || textId >= 0 || wallsId >= 0
  const labels = useLabels ? new Uint16Array(nOut) : undefined
  let w = 0
  for (let tt = 0; tt < nOrig; tt++) if (keep[tt]) { T[w++] = m.indices[3 * tt] as number; T[w++] = m.indices[3 * tt + 1] as number; T[w++] = m.indices[3 * tt + 2] as number }
  if (labels && m.segments) { let o = 0; for (let tt = 0; tt < nOrig; tt++) if (keep[tt]) labels[o++] = m.segments.labels[tt] as number }
  tris.forEach((tr, i) => {
    const use = isIn[i] ? movedId : baseId
    T[w++] = use[tr[0]] as number; T[w++] = use[tr[1]] as number; T[w++] = use[tr[2]] as number
    if (labels) {
      if (isIn[i] && textId >= 0) labels[nKeep + i] = textId
      else if (m.segments) {
        const cx = ((ps.x[tr[0]] as number) + (ps.x[tr[1]] as number) + (ps.x[tr[2]] as number)) / 3, cy = ((ps.y[tr[0]] as number) + (ps.y[tr[1]] as number) + (ps.y[tr[2]] as number)) / 3
        const loc = locate(cx, cy)
        labels[nKeep + i] = loc ? (m.segments.labels[patch.gtris[loc.t] as number] as number) : 0
      }
    }
  })
  let wi = nKeep + tris.length
  for (const inn of walls) {
    const a = inn.a, b = inn.b
    T[w++] = baseId[a] as number; T[w++] = baseId[b] as number; T[w++] = movedId[b] as number
    T[w++] = baseId[a] as number; T[w++] = movedId[b] as number; T[w++] = movedId[a] as number
    if (labels && wallsId >= 0) { labels[wi] = wallsId; labels[wi + 1] = wallsId }
    wi += 2
  }
  let insideArea = 0
  tris.forEach((tr, i) => { if (isIn[i]) { const a = P3[tr[0]] as V3, b = P3[tr[1]] as V3, c = P3[tr[2]] as V3; insideArea += 0.5 * vlen(vcross(vsub(b, a), vsub(c, a))) } })
  // a lift that turns a triangle inside out (a convex surface cut deeper than its radius, a tight concave corner) cannot be repaired
  let inverted = 0
  tris.forEach((tr, i) => {
    if (!isIn[i]) return
    const a = P3[tr[0]] as V3, b = P3[tr[1]] as V3, c = P3[tr[2]] as V3
    const n0 = vcross(vsub(b, a), vsub(c, a))
    const la = lifted(tr[0]), lb = lifted(tr[1]), lc = lifted(tr[2])
    if (vdot(n0, vcross(vsub(lb, la), vsub(lc, la))) <= 0) inverted++
  })
  const samples: Array<{ p: V3; n: V3 }> = []
  const step = Math.max(1, Math.floor(ps.n / 300))
  for (let id = 0; id < ps.n; id += step) if ((inC[id] as number) > 0) samples.push({ p: P3[id] as V3, n: N3[id] as V3 })
  const touched: number[] = []
  for (let i = nKeep; i < nOut; i++) touched.push(i)
  const mesh: Mesh = { positions: nextV === nvOrig + nNew ? P : P.slice(0, 3 * nextV), indices: T }
  if (labels) {
    mesh.segments = { labels, table }
  }
  return { mesh, touched, samples, stats: { inverted, letterSegments: segs.length, crossings, insideTriangles: isIn.filter(Boolean).length, walls: walls.length, insideSurfaceArea: insideArea, boundaryPts, interiorPts, newPts } }
}
