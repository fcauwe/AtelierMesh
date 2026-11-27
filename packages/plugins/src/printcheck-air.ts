// Printing in mid-air, seen from the geometry alone (used by the printability check; it does not change the mesh).
//
// The model is printed layer by layer from the lowest point up (Z up, the plate at the lowest point). Three things start in mid-air:
//   floating bodies  a separate shell whose lowest point is above the plate and that rests on nothing: no chain of touching or overlapping
//                    shells leads down to the plate. Touching means "within the contact distance": a gap narrower than the narrowest gap fuses.
//   islands          a local minimum of the surface above the plate with nothing under it. The part may be joined to the rest higher up (a ring
//                    hanging off a wall, a hook, an arm that comes down again), but when the printer reaches that layer it has to start a new
//                    blob in the air. Found without slicing: vertices joined by (nearly) level edges form a plateau; a plateau whose every
//                    neighbour is higher is a minimum. Its footprint is the part of the lower surface within one layer of the minimum, projected.
//   overhangs        faces that lean over more than the overhang angle, joined over shared edges into regions. A region that is nearly flat is
//                    judged by the widest disc that fits in it (the unsupported width): up to the bridge length it prints; a flat roof that is
//                    anchored on both sides is a bridge, one anchored on one side is a cantilever (reported as an overhang). A sloped region
//                    is judged by its area.
// Everything is O(triangles) (plus a bounded number of rays), with no random numbers: the same model gives the same answer.
import type { Mesh } from '@ateliermesh/core'

type V3 = [number, number, number]
interface RayCaster { raycast(o: V3, d: V3, skip?: Uint8Array): { distance: number; triangle: number } | null }

export interface AirInput {
  mesh: Mesh
  bvh: RayCaster
  /** Z component of the unit normal of each triangle, and the area of each triangle. */
  nz: Float64Array
  area: Float64Array
  /** 1 for the triangles that lean over more than the overhang angle (bed faces already left out). */
  flags: Uint8Array
  bedZ: number
  /** What counts as "on the plate", mm. */
  plateTol: number
  /** A gap up to this distance fuses: it counts as touching, mm. */
  contactTol: number
  bridgeLength: number
  minOverhangArea: number
  layerHeight: number
  diag: number
  cancel: () => void
}

export interface FloatingBody { gap: number; size: number; at: V3; tris: number[] }
export interface Island { height: number; area: number; size: number; at: V3; tris: number[]; tip: boolean }
export interface OverhangRegion { area: number; height: number; span: number | null; bbox: [number, number, number, number]; at: V3; tris: number[]; kind: 'overhang' | 'bridge' | 'ok' }
export interface AirResult { bodies: number; floating: FloatingBody[]; islands: Island[]; regions: OverhangRegion[] }

class Sets {
  private readonly p: Int32Array
  constructor(n: number) { this.p = new Int32Array(n); for (let i = 0; i < n; i++) this.p[i] = i }
  find(x: number): number { let r = x; while (this.p[r] !== r) r = this.p[r] as number; while (this.p[x] !== r) { const n = this.p[x] as number; this.p[x] = r; x = n } return r }
  union(a: number, b: number): void { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p[ra] = rb }
}

/** Footprint area of the stuff within `top` of the lowest point: the projected area of a triangle (given as three points) cut off above z = top. */
function clippedProjected(p: number[], top: number): number {
  // Sutherland-Hodgman against z <= top on a triangle: at most 4 points
  const out: number[] = []
  for (let i = 0; i < 3; i++) {
    const a = 3 * i, b = 3 * ((i + 1) % 3)
    const az = p[a + 2] as number, bz = p[b + 2] as number
    const ain = az <= top, bin = bz <= top
    if (ain) out.push(p[a] as number, p[a + 1] as number)
    if (ain !== bin) { const t = (top - az) / (bz - az); out.push((p[a] as number) + t * ((p[b] as number) - (p[a] as number)), (p[a + 1] as number) + t * ((p[b + 1] as number) - (p[a + 1] as number))) }
  }
  let s = 0
  const n = out.length / 2
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; s += (out[2 * i] as number) * (out[2 * j + 1] as number) - (out[2 * j] as number) * (out[2 * i + 1] as number) }
  return Math.abs(s) / 2
}

/** The width of the widest disc that fits inside a flat region (its unsupported width), from a distance map on a grid over the region. */
export function inscribedWidth(mesh: Mesh, tris: number[]): number {
  const P = mesh.positions, T = mesh.indices
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const t of tris) for (let k = 0; k < 3; k++) { const v = 3 * (T[3 * t + k] as number); const x = P[v] as number, y = P[v + 1] as number; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  const ext = Math.max(x1 - x0, y1 - y0)
  if (!(ext > 0)) return 0
  const cs = Math.max(ext / 160, 0.05)
  const nx = Math.ceil((x1 - x0) / cs) + 2, ny = Math.ceil((y1 - y0) / cs) + 2         // one empty cell all round
  const mask = new Uint8Array(nx * ny)
  for (const t of tris) {
    const a = 3 * (T[3 * t] as number), b = 3 * (T[3 * t + 1] as number), c = 3 * (T[3 * t + 2] as number)
    const ax = (P[a] as number) - x0, ay = (P[a + 1] as number) - y0, bx = (P[b] as number) - x0, by = (P[b + 1] as number) - y0, cx = (P[c] as number) - x0, cy = (P[c + 1] as number) - y0
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if (Math.abs(den) < 1e-18) continue
    const i0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) / cs - 0.5) ), i1 = Math.min(nx - 3, Math.floor(Math.max(ax, bx, cx) / cs - 0.5))
    const j0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) / cs - 0.5)), j1 = Math.min(ny - 3, Math.floor(Math.max(ay, by, cy) / cs - 0.5))
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const px = (i + 0.5) * cs, py = (j + 0.5) * cs
      const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den, l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den
      if (l1 >= -1e-9 && l2 >= -1e-9 && l1 + l2 <= 1 + 1e-9) mask[(j + 1) * nx + (i + 1)] = 1
    }
  }
  // two-pass chamfer distance (in cells) to the nearest empty cell
  const d = new Float32Array(nx * ny)
  const R2 = Math.SQRT2
  for (let k = 0; k < d.length; k++) d[k] = mask[k] ? 1e9 : 0
  for (let j = 1; j < ny; j++) for (let i = 1; i < nx - 1; i++) {
    const k = j * nx + i
    if (!mask[k]) continue
    d[k] = Math.min(d[k] as number, (d[k - 1] as number) + 1, (d[k - nx] as number) + 1, (d[k - nx - 1] as number) + R2, (d[k - nx + 1] as number) + R2)
  }
  let best = 0
  for (let j = ny - 2; j >= 0; j--) for (let i = nx - 2; i >= 1; i--) {
    const k = j * nx + i
    if (!mask[k]) continue
    const v = Math.min(d[k] as number, (d[k + 1] as number) + 1, (d[k + nx] as number) + 1, (d[k + nx + 1] as number) + R2, (d[k + nx - 1] as number) + R2)
    d[k] = v
    if (v > best) best = v
  }
  return Math.max(0, (2 * best - 1) * cs)
}

export function airAnalysis(inp: AirInput): AirResult {
  const { mesh, bvh, nz, area, bedZ, plateTol, contactTol } = inp
  const P = mesh.positions, T = mesh.indices, nt = T.length / 3, nv = P.length / 3
  const Z = (v: number): number => P[3 * v + 2] as number

  // ---------------------------------------------------------------- the shells
  const uf = new Sets(nv), used = new Uint8Array(nv)
  for (let t = 0; t < nt; t++) {
    const a = T[3 * t] as number, b = T[3 * t + 1] as number, c = T[3 * t + 2] as number
    uf.union(a, b); uf.union(a, c); used[a] = 1; used[b] = 1; used[c] = 1
  }
  const comp = new Int32Array(nt)
  const minZ = new Map<number, number>(), compTris = new Map<number, number[]>()
  for (let t = 0; t < nt; t++) {
    const r = uf.find(T[3 * t] as number)
    comp[t] = r
    let l = compTris.get(r); if (!l) { l = []; compTris.set(r, l) }
    l.push(t)
    for (let k = 0; k < 3; k++) { const z = Z(T[3 * t + k] as number); if (z < (minZ.get(r) ?? Infinity)) minZ.set(r, z) }
  }
  const multi = compTris.size > 1

  /** The shell that carries the point (x, y, z) from below: the first thing straight down, or -1 (the point is on the plate, or in the air). */
  const carrier = (x: number, y: number, z: number, own: number): number => {
    const h = bvh.raycast([x, y, z - 1e-6], [0, 0, -1])
    if (!h) return -1
    const n = nz[h.triangle] as number
    if (Math.abs(n) < 1e-9) return -1
    if (n > 0) return h.distance <= contactTol ? (comp[h.triangle] as number) : -1
    return (comp[h.triangle] as number) !== own ? (comp[h.triangle] as number) : -1      // a back face first: the point is inside another shell
  }
  inp.cancel()

  // ---------------------------------------------------------------- 1. floating bodies
  const floating: FloatingBody[] = []
  if (multi) {
    const roots = [...compTris.keys()].sort((a, b) => a - b)
    const grounded = new Set<number>()
    const loose: number[] = []
    for (const r of roots) { if ((minZ.get(r) as number) <= bedZ + plateTol) grounded.add(r); else loose.push(r) }
    const holders = new Map<number, Set<number>>()
    // the lowest vertices of each loose shell, found in one pass over the vertices
    const lowest = new Map<number, number[]>()
    for (const r of loose.slice(0, 3000)) lowest.set(r, [])
    for (let v = 0; v < nv; v++) {
      if (!used[v]) continue
      const l = lowest.get(uf.find(v)); if (l) l.push(v)
    }
    for (const [r, vs] of lowest) {
      vs.sort((a, b) => Z(a) - Z(b) || a - b)
      const set = new Set<number>()
      for (const v of vs.slice(0, 12)) { const c = carrier(P[3 * v] as number, P[3 * v + 1] as number, Z(v), r); if (c >= 0) set.add(c) }
      holders.set(r, set)
    }
    inp.cancel()
    for (let changed = true; changed;) {
      changed = false
      for (const [r, set] of holders) if (!grounded.has(r) && [...set].some(c => grounded.has(c))) { grounded.add(r); changed = true }
    }
    for (const r of loose) {
      if (!holders.has(r) || grounded.has(r)) continue
      const tris = compTris.get(r) as number[]
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
      for (const t of tris) for (let k = 0; k < 3; k++) { const v = T[3 * t + k] as number; const x = P[3 * v] as number, y = P[3 * v + 1] as number; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (Z(v) > z1) z1 = Z(v) }
      const z0 = minZ.get(r) as number
      floating.push({ gap: z0 - bedZ, size: Math.hypot(x1 - x0, y1 - y0, z1 - z0), at: [(x0 + x1) / 2, (y0 + y1) / 2, z0], tris })
    }
    floating.sort((a, b) => b.size - a.size)
  }
  const looseTris = new Set<number>()
  for (const f of floating) for (const t of f.tris) looseTris.add(t)

  // ---------------------------------------------------------------- 2. islands: local minima of the surface above the plate
  const flatTol = Math.max(0.005, 2e-5 * inp.diag)
  const levels = new Sets(nv), hasLower = new Uint8Array(nv)
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const a = T[3 * t + k] as number, b = T[3 * t + (k + 1) % 3] as number
      const dz = Z(b) - Z(a)
      if (Math.abs(dz) <= flatTol) levels.union(a, b); else if (dz > 0) hasLower[b] = 1; else hasLower[a] = 1
    }
  }
  const groupLower = new Uint8Array(nv)
  for (let v = 0; v < nv; v++) if (used[v] && hasLower[v]) groupLower[levels.find(v)] = 1
  const groups = new Map<number, number[]>()
  for (let v = 0; v < nv; v++) {
    if (!used[v]) continue
    const g = levels.find(v)
    if (groupLower[g] || Z(v) <= bedZ + plateTol) continue
    const l = groups.get(g); if (l) l.push(v); else groups.set(g, [v])
  }
  const islands: Island[] = []
  if (groups.size > 0) {
    // the triangles around each vertex
    const start = new Int32Array(nv + 1)
    for (let i = 0; i < T.length; i++) start[(T[i] as number) + 1]!++
    for (let v = 0; v < nv; v++) start[v + 1] = (start[v + 1] as number) + (start[v] as number)
    const fill = start.slice(0, nv), around = new Int32Array(T.length)
    for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) { const v = T[3 * t + k] as number; around[fill[v]!++] = t }
    const slab = Math.max(inp.layerHeight, 0.05)
    let budget = 3_000_000, done = 0
    const seen = new Int32Array(nv).fill(-1)
    const buf = new Array<number>(9)
    for (const [g, members] of groups) {
      if (budget <= 0 || done >= 20000) break
      done++
      const z0 = Z(members[0] as number)
      if (looseTris.has((around[start[members[0] as number] as number]) as number)) continue       // a floating body is reported as one
      // something under the lowest points carries them (a body they rest on, or a gap that fuses)
      let carried = false
      {
        for (const v of members.slice(0, 4)) {
          const h = bvh.raycast([P[3 * v] as number, P[3 * v + 1] as number, z0 - 1e-6], [0, 0, -1])
          if (h && Math.abs(nz[h.triangle] as number) > 1e-9) {
            const n = nz[h.triangle] as number
            // a hit on a face that points down means the start point is inside a solid (the floor of a pocket, with material below it): carried
            if (n > 0 ? h.distance <= contactTol : true) { carried = true; break }
          }
        }
      }
      if (carried) continue
      // the lowest points must have a face that looks down (a bottom). A minimum whose faces look up or sideways is the floor of a pocket, or the edge of
      // a cut in a wall (an engraved letter): the material is below it, so nothing starts in the air there
      {
        let bottom = false
        for (const v of members) { for (let e = start[v] as number; e < (start[v + 1] as number); e++) if ((nz[around[e] as number] as number) < -0.05) { bottom = true; break }; if (bottom) break }
        if (!bottom) continue
      }
      // everything within one layer of the lowest point that is joined to it
      const top = z0 + slab
      const queue: number[] = [...members]
      for (const v of members) seen[v] = g
      const tris: number[] = []
      const footTris: number[] = []
      let foot = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      const tseen = new Set<number>()
      for (let qi = 0; qi < queue.length && qi < 20000; qi++) {
        const v = queue[qi] as number
        for (let e = start[v] as number; e < (start[v + 1] as number); e++) {
          budget--
          const t = around[e] as number
          if (tseen.has(t)) continue
          tseen.add(t)
          tris.push(t)
          for (let k = 0; k < 3; k++) {
            const w = T[3 * t + k] as number
            buf[3 * k] = P[3 * w] as number; buf[3 * k + 1] = P[3 * w + 1] as number; buf[3 * k + 2] = P[3 * w + 2] as number
            if (Z(w) <= top && Z(w) >= z0 - flatTol && seen[w] !== g) { seen[w] = g; queue.push(w) }
          }
          if ((nz[t] as number) < -1e-6) {
            footTris.push(t)
            foot += clippedProjected(buf, top)
            for (let k = 0; k < 3; k++) { if ((buf[3 * k + 2] as number) <= top) { const x = buf[3 * k] as number, y = buf[3 * k + 1] as number; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y } }
          }
        }
      }
      // a lip: the underside is only a thin strip wide (the underside of a raised letter, a rim, a ridge): the layer below is within a nozzle width of it, so it prints
      const lip = footTris.length > 0 && inscribedWidth(mesh, footTris) < 1.2
      if (foot >= 1 && lip) continue                                    // a thin lip is not a start in mid-air: the overhang check speaks for it
      if (foot < 0.25) continue                                         // a needle point or a rough patch: the overhang check speaks for it
      islands.push({ height: z0 - bedZ, area: foot, size: Number.isFinite(x0) ? Math.hypot(x1 - x0, y1 - y0) : 0, at: [Number.isFinite(x0) ? (x0 + x1) / 2 : 0, Number.isFinite(y0) ? (y0 + y1) / 2 : 0, z0], tris: tris.sort((a, b) => a - b), tip: foot < 1 })
    }
    islands.sort((a, b) => b.area - a.area || a.height - b.height)
  }
  inp.cancel()

  // ---------------------------------------------------------------- 3. overhang regions
  const flags = Uint8Array.from(inp.flags)
  let carriedFlat = 0
  for (let t = 0; t < nt; t++) {
    if (!flags[t]) continue
    const a = T[3 * t] as number, b = T[3 * t + 1] as number, c = T[3 * t + 2] as number
    if (Math.max(Z(a), Z(b), Z(c)) <= bedZ + plateTol) { flags[t] = 0; continue }          // on the plate (a chamfer or a rough bottom)
    if (multi && (nz[t] as number) <= -0.94 && carriedFlat < 60000) {                       // a flat underside that rests on another shell
      carriedFlat++
      const x = ((P[3 * a] as number) + (P[3 * b] as number) + (P[3 * c] as number)) / 3, y = ((P[3 * a + 1] as number) + (P[3 * b + 1] as number) + (P[3 * c + 1] as number)) / 3
      if (carrier(x, y, Math.min(Z(a), Z(b), Z(c)), comp[t] as number) >= 0) flags[t] = 0
    }
  }
  const idx: number[] = []
  const slot = new Int32Array(nt).fill(-1)
  for (let t = 0; t < nt; t++) if (flags[t]) { slot[t] = idx.length; idx.push(t) }
  const regions: OverhangRegion[] = []
  if (idx.length > 0) {
    const ru = new Sets(idx.length)
    const edges = new Map<number, { s: number; n: number; len: number }>()
    const edgeLen = (a: number, b: number): number => Math.hypot((P[3 * a] as number) - (P[3 * b] as number), (P[3 * a + 1] as number) - (P[3 * b + 1] as number), Z(a) - Z(b))
    for (let i = 0; i < idx.length; i++) {
      const t = idx[i] as number
      for (let k = 0; k < 3; k++) {
        const a = T[3 * t + k] as number, b = T[3 * t + (k + 1) % 3] as number
        const key = a < b ? a * nv + b : b * nv + a
        const e = edges.get(key)
        if (e) { ru.union(i, e.s); e.n++ } else edges.set(key, { s: i, n: 1, len: edgeLen(a, b) })
      }
    }
    inp.cancel()
    const anchored = new Map<number, number>(), boundary = new Map<number, number>()
    for (const e of edges.values()) if (e.n === 1) { const r = ru.find(e.s); boundary.set(r, (boundary.get(r) ?? 0) + e.len) }
    for (let t = 0; t < nt; t++) {
      if (flags[t]) continue
      for (let k = 0; k < 3; k++) {
        const a = T[3 * t + k] as number, b = T[3 * t + (k + 1) % 3] as number, c = T[3 * t + (k + 2) % 3] as number
        const e = edges.get(a < b ? a * nv + b : b * nv + a)
        if (e && e.n === 1 && Z(c) < Math.min(Z(a), Z(b)) - 1e-6) { const r = ru.find(e.s); anchored.set(r, (anchored.get(r) ?? 0) + e.len) }     // a wall goes down from this edge: it is held
      }
    }
    interface Acc { area: number; flat: number; z: number; box: [number, number, number, number]; tris: number[] }
    const acc = new Map<number, Acc>()
    for (let i = 0; i < idx.length; i++) {
      const t = idx[i] as number, r = ru.find(i)
      let a = acc.get(r)
      if (!a) { a = { area: 0, flat: 0, z: Infinity, box: [Infinity, Infinity, -Infinity, -Infinity], tris: [] }; acc.set(r, a) }
      a.area += area[t] as number
      if ((nz[t] as number) <= -0.94) a.flat += area[t] as number
      a.tris.push(t)
      for (let k = 0; k < 3; k++) {
        const v = T[3 * t + k] as number, x = P[3 * v] as number, y = P[3 * v + 1] as number
        if (Z(v) < a.z) a.z = Z(v)
        if (x < a.box[0]) a.box[0] = x; if (y < a.box[1]) a.box[1] = y; if (x > a.box[2]) a.box[2] = x; if (y > a.box[3]) a.box[3] = y
      }
    }
    const ordered = [...acc.entries()].sort((p, q) => q[1].area - p[1].area || p[0] - q[0])
    let grids = 0
    for (const [r, a] of ordered) {
      const flat = a.flat >= 0.8 * a.area
      let span: number | null = null
      let kind: OverhangRegion['kind'] = 'ok'
      if (flat) {
        if (a.area >= 0.78 * inp.bridgeLength * inp.bridgeLength && grids < 200) { grids++; span = inscribedWidth(mesh, a.tris) }
        if (span !== null && span > inp.bridgeLength) {
          const held = (anchored.get(r) ?? 0) / Math.max(1e-9, boundary.get(r) ?? 0)
          kind = held >= 0.45 ? 'bridge' : 'overhang'
        }
      } else if (a.area >= inp.minOverhangArea) kind = 'overhang'
      regions.push({ area: a.area, height: a.z - bedZ, span, bbox: a.box, at: [(a.box[0] + a.box[2]) / 2, (a.box[1] + a.box[3]) / 2, a.z], tris: a.tris, kind })
    }
  }
  return { bodies: compTris.size, floating, islands, regions }
}
