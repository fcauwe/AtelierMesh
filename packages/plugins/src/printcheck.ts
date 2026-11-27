// The printability check: what could go wrong when this model is printed, in one report. It does not change the mesh.
//
// Everything is measured in millimetres on the model as it stands (Z up, the bed at its lowest point). The checks:
//   closed      the surface is one closed, consistently wound solid (holes, edges shared by three triangles, inside-out triangles)
//   islands     several separate shells (a floating piece that is not attached to the model)
//   thin_walls  the wall is thinner than the nozzle can lay down: a ray goes from a sample point on the surface straight into the model along the
//               inward normal, and the distance to the first surface it meets is the local wall thickness
//   thin_features  posts, pins and spikes that are thin in EVERY direction (a wall is thin in one direction only)
//   narrow_gaps two surfaces that face each other across a gap narrower than the printer can keep open (they fuse): the same ray, outward
//   floating_body, island, overhang, bridge  parts that start in mid-air and overhang regions that need support (printcheck-air.ts), with a turn suggestion
//   needs_support  the surface that faces down beyond the overhang angle (the shared overhang measure), and bridges: flat roofs wider than allowed
//   tiny_base   almost nothing rests flat on the bed (it will not stick, or it tips)
//   too_tall    the model is much taller than it is wide (it wobbles while it prints)
//   too_big_for_bed  the model does not fit the build volume, as it lies or turned about Z
// plus two figures that are not problems (triangle count, needle-like triangles).
//
// The surface is sampled (area weighted, with a fixed seed: no Math.random), so the result is the same every time for the same model; the sample count is
// capped, so a million-triangle model takes a few seconds. A triangle is flagged when a sample on it fails a check; on a model with far more triangles than
// samples the flagged triangles are the sampled ones (the share, which is by area, stays right).
import { MeshError, buildBvh, measureMesh } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'
import { overhangForUp, flagRuns } from './overhang'
import type { OverhangResult } from './overhang'
import { airAnalysis } from './printcheck-air'
import { axisCandidates, bestCandidate } from './orient'

export type Severity = 'ok' | 'info' | 'warning' | 'error'
export type Verdict = 'good' | 'fix_recommended' | 'not_printable'
export type Process = 'fdm' | 'resin'

export interface PrintCheckOptions {
  process: Process
  /** Nozzle width, mm (FDM). */
  nozzle: number
  layerHeight: number
  /** 0 = automatic from the process and the nozzle. */
  minWall: number
  minFeature: number
  minGap: number
  overhangAngle: number
  bridgeLength: number
  /** The smallest sloped overhang region that needs support, mm² (default 20). */
  minOverhangArea?: number
  /** Build volume x, y, z in mm; 0 on an axis ignores it. */
  bed: [number, number, number]
  /** A preview samples less. */
  quality?: 'preview' | 'export'
  signal?: AbortSignal | undefined
  onProgress?: ((stage: string, fraction: number) => void) | undefined
}

export interface Finding {
  /** `printcheck.<name>`, the code of the warning the step gives for it. */
  code: string
  name: string
  severity: Severity
  /** What was found: a number of places, pieces, bridges, triangles... */
  count: number
  /** The one number that tells most (thinnest wall, widest bridge...), in `unit`; null when there is none. */
  value: number | null
  unit: string
  /** The share of the surface (by area) that fails this check, 0..1; null when it is not about area. */
  share: number | null
  /** Where the worst case is, mm. */
  at?: [number, number, number]
  /** Flagged triangles as runs [start, length], for the 3D view. */
  triangles?: Array<[number, number]>
  truncated?: boolean
  /** More numbers for the text of the finding. */
  params: Record<string, number | string>
}

export interface PrintCheckResult {
  verdict: Verdict
  score: number
  issues: number
  findings: Finding[]
  thresholds: { min_wall: number; min_feature: number; min_gap: number; overhang_angle: number; bridge_length: number; min_overhang_area: number; nozzle: number; process: Process }
  samples: number
  size: [number, number, number]
  triangles: number
  ms: number
}

export const AUTO = { fdm: { wallPerNozzle: 2, featurePerNozzle: 2, gapPerNozzle: 1 }, resin: { wall: 0.6, feature: 0.3, gap: 0.2 } }

/** The thresholds in millimetres: what the user typed, or (0) what the process and the nozzle give. */
export function thresholds(o: Pick<PrintCheckOptions, 'process' | 'nozzle' | 'layerHeight' | 'minWall' | 'minFeature' | 'minGap'>): { minWall: number; minFeature: number; minGap: number } {
  if (o.process === 'resin') return { minWall: o.minWall > 0 ? o.minWall : AUTO.resin.wall, minFeature: o.minFeature > 0 ? o.minFeature : AUTO.resin.feature, minGap: o.minGap > 0 ? o.minGap : AUTO.resin.gap }
  return {
    minWall: o.minWall > 0 ? o.minWall : AUTO.fdm.wallPerNozzle * o.nozzle,
    // a detail thinner than four layers does not resolve in height either
    minFeature: o.minFeature > 0 ? o.minFeature : Math.max(AUTO.fdm.featurePerNozzle * o.nozzle, 4 * o.layerHeight),
    minGap: o.minGap > 0 ? o.minGap : AUTO.fdm.gapPerNozzle * o.nozzle,
  }
}

const cancelled = (o: { signal?: AbortSignal | undefined }): void => { if (o.signal?.aborted) throw new MeshError('run.cancelled') }
const round = (v: number, d = 2): number => { const f = 10 ** d; return Math.round(v * f) / f }

/** A small seeded generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

class Sets {
  private readonly p: Int32Array
  constructor(n: number) { this.p = new Int32Array(n); for (let i = 0; i < n; i++) this.p[i] = i }
  find(x: number): number { let r = x; while (this.p[r] !== r) r = this.p[r] as number; while (this.p[x] !== r) { const n = this.p[x] as number; this.p[x] = r; x = n } return r }
  union(a: number, b: number): void { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p[ra] = rb }
}

interface Shells { count: number; tiny: number; main: number; sizes: number[]; smallestMm: number }

/** The separate shells of the mesh and how many of them are small compared with the biggest one. */
function shells(mesh: Mesh): Shells {
  const P = mesh.positions, T = mesh.indices, nv = P.length / 3
  const u = new Sets(nv), used = new Uint8Array(nv)
  for (let t = 0; t < T.length; t += 3) { u.union(T[t] as number, T[t + 1] as number); u.union(T[t] as number, T[t + 2] as number); used[T[t] as number] = 1; used[T[t + 1] as number] = 1; used[T[t + 2] as number] = 1 }
  const tris = new Map<number, number>(), box = new Map<number, number[]>()
  for (let t = 0; t < T.length; t += 3) {
    const r = u.find(T[t] as number)
    tris.set(r, (tris.get(r) ?? 0) + 1)
    let b = box.get(r)
    if (!b) { b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; box.set(r, b) }
    for (let k = 0; k < 3; k++) {
      const v = 3 * (T[t + k] as number)
      for (let a = 0; a < 3; a++) { const x = P[v + a] as number; if (x < (b[a] as number)) b[a] = x; if (x > (b[3 + a] as number)) b[3 + a] = x }
    }
  }
  const sizes = [...tris.values()].sort((a, b) => b - a)
  const main = sizes[0] ?? 0
  const diag = (b: number[]): number => Math.hypot((b[3] as number) - (b[0] as number), (b[4] as number) - (b[1] as number), (b[5] as number) - (b[2] as number))
  let smallest = Infinity, tiny = 0
  const mainBox = [...tris.entries()].sort((a, b) => b[1] - a[1])[0]
  const mainDiag = mainBox ? diag(box.get(mainBox[0]) as number[]) : 0
  for (const [r, n] of tris) {
    if (mainBox && r === mainBox[0]) continue
    const d = diag(box.get(r) as number[])
    smallest = Math.min(smallest, d)
    if (n < 0.01 * main || d < 0.05 * mainDiag) tiny++
  }
  return { count: tris.size, tiny, main, sizes, smallestMm: Number.isFinite(smallest) ? smallest : 0 }
}

/** Number of triangles whose smallest angle is under `deg`. */
function needles(mesh: Mesh, deg: number): number {
  const P = mesh.positions, T = mesh.indices
  const cosMax = Math.cos((deg * Math.PI) / 180)
  let n = 0
  for (let t = 0; t < T.length; t += 3) {
    let worst = -1
    for (let k = 0; k < 3; k++) {
      const a = 3 * (T[t + k] as number), b = 3 * (T[t + (k + 1) % 3] as number), c = 3 * (T[t + (k + 2) % 3] as number)
      const ux = (P[b] as number) - (P[a] as number), uy = (P[b + 1] as number) - (P[a + 1] as number), uz = (P[b + 2] as number) - (P[a + 2] as number)
      const vx = (P[c] as number) - (P[a] as number), vy = (P[c + 1] as number) - (P[a + 1] as number), vz = (P[c + 2] as number) - (P[a + 2] as number)
      const l = Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz)
      if (l === 0) { worst = 1; break }
      const c0 = (ux * vx + uy * vy + uz * vz) / l
      if (c0 > worst) worst = c0
    }
    if (worst > cosMax) n++
  }
  return n
}

/** Roofs (nearly flat, facing down, not on the bed) joined into pieces over shared edges; returns the widest extent in the XY plane of each piece, mm. */
function bridges(mesh: Mesh, flags: Uint8Array, down: Float64Array, bedZ: number): { widest: number; at: [number, number, number] | null; groups: Array<{ span: number; tris: number[] }> } {
  const P = mesh.positions, T = mesh.indices, nt = T.length / 3
  const roof: number[] = []
  const slot = new Int32Array(nt).fill(-1)
  for (let t = 0; t < nt; t++) {
    if (!flags[t] || (down[t] as number) < 0.94) continue                    // within about 20 degrees of flat
    const z = Math.min(P[3 * (T[3 * t] as number) + 2] as number, P[3 * (T[3 * t + 1] as number) + 2] as number, P[3 * (T[3 * t + 2] as number) + 2] as number)
    if (z <= bedZ + 1e-6) continue
    slot[t] = roof.length; roof.push(t)
  }
  if (roof.length === 0) return { widest: 0, at: null, groups: [] }
  const u = new Sets(roof.length)
  const edge = new Map<number, number>()
  const nv = P.length / 3
  for (let i = 0; i < roof.length; i++) {
    const t = roof[i] as number
    for (let e = 0; e < 3; e++) {
      const a = T[3 * t + e] as number, b = T[3 * t + (e + 1) % 3] as number
      const key = a < b ? a * nv + b : b * nv + a
      const o = edge.get(key)
      if (o === undefined) edge.set(key, i); else u.union(i, o)
    }
  }
  const box = new Map<number, number[]>()
  for (let i = 0; i < roof.length; i++) {
    const r = u.find(i), t = roof[i] as number
    let b = box.get(r)
    if (!b) { b = [Infinity, Infinity, -Infinity, -Infinity, 0, 0, 0]; box.set(r, b) }
    for (let k = 0; k < 3; k++) {
      const v = 3 * (T[3 * t + k] as number), x = P[v] as number, y = P[v + 1] as number
      if (x < (b[0] as number)) b[0] = x; if (y < (b[1] as number)) b[1] = y; if (x > (b[2] as number)) b[2] = x; if (y > (b[3] as number)) b[3] = y
    }
    b[4] = (b[4] as number) + 1
    b[5] = P[3 * (T[3 * t] as number) + 2] as number
    b[6] = t
  }
  let widest = 0, at: [number, number, number] | null = null
  const groups: Array<{ span: number; tris: number[] }> = []
  const members = new Map<number, number[]>()
  for (let i = 0; i < roof.length; i++) { const r = u.find(i); const l = members.get(r); if (l) l.push(roof[i] as number); else members.set(r, [roof[i] as number]) }
  for (const [r, b] of box) {
    // a roof is a bridge across the narrower way: a long thin roof is spanned along its short side
    const w = (b[2] as number) - (b[0] as number), d = (b[3] as number) - (b[1] as number)
    const span = Math.min(w, d)
    groups.push({ span, tris: members.get(r) as number[] })
    if (span > widest) { widest = span; at = [((b[0] as number) + (b[2] as number)) / 2, ((b[1] as number) + (b[3] as number)) / 2, b[5] as number] }
  }
  return { widest, at, groups }
}

/** Runs of a list of triangle indices (sorted). */
function runsOf(tris: number[], max = 4000): { runs: Array<[number, number]>; truncated: boolean } {
  let top = 0
  for (const t of tris) if (t > top) top = t
  const f = new Uint8Array(top + 1)
  for (const t of tris) f[t] = 1
  return flagRuns(f, max)
}

export function printCheck(mesh: Mesh, o: PrintCheckOptions): PrintCheckResult {
  const t0 = Date.now()
  const P = mesh.positions, T = mesh.indices, nt = T.length / 3
  if (nt === 0 || P.length === 0) throw new MeshError('printcheck.bad_input', { reason: 'empty' })
  const th = thresholds(o)
  const m = measureMesh(mesh)
  const findings: Finding[] = []
  const add = (f: Omit<Finding, 'code'> & { name: string }): void => { findings.push({ ...f, code: `printcheck.${f.name}` }) }
  o.onProgress?.('printcheck', 0.02)

  // ---------------------------------------------------------------- 1. the surface: closed, holes, shells
  const counts = { boundary: m.boundaryEdges, nonManifold: m.nonManifoldEdges, badOrientation: m.badOrientationEdges, inverted: m.watertight && m.volume < 0 }
  const closed = m.watertight && !counts.inverted
  const problems = counts.boundary + counts.nonManifold + counts.badOrientation + (counts.inverted ? 1 : 0)
  add({ name: 'not_closed', severity: closed ? 'ok' : 'error', count: problems, value: closed ? null : counts.boundary, unit: 'edges', share: null,
    params: { open_edges: counts.boundary, shared_edges: counts.nonManifold, bad_edges: counts.badOrientation, inside_out: counts.inverted ? 1 : 0 } })
  const sh = shells(mesh)
  add({ name: 'islands', severity: sh.count <= 1 ? 'ok' : sh.tiny > 0 ? 'warning' : 'info', count: Math.max(0, sh.count - 1), value: sh.count <= 1 ? null : round(sh.smallestMm, 1), unit: 'mm', share: null,
    params: { shells: sh.count, tiny: sh.tiny, smallest: round(sh.smallestMm, 1) } })
  cancelled(o)
  o.onProgress?.('printcheck', 0.1)

  // ---------------------------------------------------------------- 2. sampling the surface: wall, features, gaps
  const bvh = buildBvh(mesh)
  o.onProgress?.('printcheck', 0.25)
  const area = new Float64Array(nt), nx = new Float64Array(nt), ny = new Float64Array(nt), nz = new Float64Array(nt)
  let total = 0
  for (let t = 0; t < nt; t++) {
    const a = 3 * (T[3 * t] as number), b = 3 * (T[3 * t + 1] as number), c = 3 * (T[3 * t + 2] as number)
    const ux = (P[b] as number) - (P[a] as number), uy = (P[b + 1] as number) - (P[a + 1] as number), uz = (P[b + 2] as number) - (P[a + 2] as number)
    const vx = (P[c] as number) - (P[a] as number), vy = (P[c + 1] as number) - (P[a + 1] as number), vz = (P[c + 2] as number) - (P[a + 2] as number)
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx
    const l = Math.hypot(x, y, z)
    if (l > 0) { nx[t] = x / l; ny[t] = y / l; nz[t] = z / l }
    area[t] = l / 2; total += l / 2
  }
  const cum = new Float64Array(nt)
  let acc = 0
  for (let t = 0; t < nt; t++) { acc += area[t] as number; cum[t] = acc }
  const diag = Math.hypot(m.size[0], m.size[1], m.size[2]) || 1
  const eps = Math.max(1e-4, 1e-5 * diag)
  const maxSamples = o.quality === 'preview' ? 4000 : 16000
  const nSamples = Math.min(maxSamples, Math.max(600, nt * 8))
  const rand = rng(((nt * 2654435761) ^ (P.length * 40503)) >>> 0)
  const thinTri: number[] = [], featTri: number[] = [], gapTri: number[] = []
  let thin = 0, feat = 0, gaps = 0, valid = 0
  let minWall = Infinity, minWallAt: [number, number, number] | null = null
  let minFeat = Infinity, minFeatAt: [number, number, number] | null = null
  let minGapSeen = Infinity, minGapAt: [number, number, number] | null = null
  const walls: number[] = []
  const ray = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): { distance: number; triangle: number } | null => bvh.raycast([ox, oy, oz], [dx, dy, dz])
  for (let s = 0; s < nSamples && total > 0; s++) {
    if ((s & 255) === 0) { cancelled(o); o.onProgress?.('printcheck', 0.25 + 0.5 * (s / nSamples)) }
    // a triangle by area, a point inside it
    const target = rand() * total
    let lo = 0, hi = nt - 1
    while (lo < hi) { const mid = (lo + hi) >> 1; if ((cum[mid] as number) < target) lo = mid + 1; else hi = mid }
    const t = lo
    if ((area[t] as number) <= 0) continue
    let r1 = rand(), r2 = rand()
    if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2 }
    const a = 3 * (T[3 * t] as number), b = 3 * (T[3 * t + 1] as number), c = 3 * (T[3 * t + 2] as number)
    const px = (P[a] as number) + r1 * ((P[b] as number) - (P[a] as number)) + r2 * ((P[c] as number) - (P[a] as number))
    const py = (P[a + 1] as number) + r1 * ((P[b + 1] as number) - (P[a + 1] as number)) + r2 * ((P[c + 1] as number) - (P[a + 1] as number))
    const pz = (P[a + 2] as number) + r1 * ((P[b + 2] as number) - (P[a + 2] as number)) + r2 * ((P[c + 2] as number) - (P[a + 2] as number))
    const ax = nx[t] as number, ay = ny[t] as number, az = nz[t] as number
    valid++
    // the wall: into the model along the inward normal
    const hit = ray(px - ax * eps, py - ay * eps, pz - az * eps, -ax, -ay, -az)
    if (hit && Number.isFinite(hit.distance)) {
      const w = hit.distance + eps
      if (w < minWall) { minWall = w; minWallAt = [px, py, pz] }
      if (w < th.minWall - 1e-9) {
        // a post is thin the other ways too: from the middle of the wall, look along the surface both ways
        const qx = px - ax * (w / 2), qy = py - ay * (w / 2), qz = pz - az * (w / 2)
        const t1: [number, number, number] = Math.abs(az) < 0.9 ? [-ay, ax, 0] : [0, -az, ay]
        const l1 = Math.hypot(t1[0], t1[1], t1[2]) || 1
        const u1x = t1[0] / l1, u1y = t1[1] / l1, u1z = t1[2] / l1
        const u2x = ay * u1z - az * u1y, u2y = az * u1x - ax * u1z, u2z = ax * u1y - ay * u1x
        const far = (dx: number, dy: number, dz: number): number => { const h = ray(qx, qy, qz, dx, dy, dz); return h && Number.isFinite(h.distance) ? h.distance : Infinity }
        const w1 = far(u1x, u1y, u1z) + far(-u1x, -u1y, -u1z), w2 = far(u2x, u2y, u2z) + far(-u2x, -u2y, -u2z)
        const lateral = Math.min(w1, w2)
        if (lateral < th.minFeature) { feat++; featTri.push(t); if (lateral < minFeat) { minFeat = lateral; minFeatAt = [px, py, pz] } }
        else { thin++; thinTri.push(t); walls.push(w) }
      }
    }
    // the gap: out of the model along the normal, onto a surface that faces back
    const out = ray(px + ax * eps, py + ay * eps, pz + az * eps, ax, ay, az)
    if (out && Number.isFinite(out.distance)) {
      const h = out.triangle
      const facing = -((nx[h] as number) * ax + (ny[h] as number) * ay + (nz[h] as number) * az)
      if (facing > 0.8) {
        const g = out.distance + eps
        if (g < minGapSeen) { minGapSeen = g; minGapAt = [px, py, pz] }
        if (g < th.minGap - 1e-9) { gaps++; gapTri.push(t) }
      }
    }
  }
  o.onProgress?.('printcheck', 0.78)
  const share = (n: number): number => (valid > 0 ? n / valid : 0)
  const uniq = (l: number[]): number[] => [...new Set(l)].sort((a, b) => a - b)
  const wallShare = share(thin), featShare = share(feat), gapShare = share(gaps)
  const wallSev: Severity = thin === 0 ? 'ok' : wallShare >= 0.01 && minWall < 0.9 * (o.process === 'resin' ? th.minWall * 0.5 : o.nozzle) ? 'error' : wallShare >= 0.003 || thin >= 3 ? 'warning' : 'info'
  const wr = runsOf(uniq(thinTri))
  add({ name: 'thin_walls', severity: wallSev, count: thin, value: Number.isFinite(minWall) ? round(minWall, 2) : null, unit: 'mm', share: round(wallShare, 4),
    ...(minWallAt && thin > 0 ? { at: minWallAt.map(v => round(v, 2)) as [number, number, number] } : {}), ...(thin > 0 ? { triangles: wr.runs, truncated: wr.truncated } : {}),
    params: { min: th.minWall, thinnest: Number.isFinite(minWall) ? round(minWall, 2) : 0, percent: round(wallShare * 100, 1) } })
  const featSev: Severity = feat === 0 ? 'ok' : feat >= 3 || featShare >= 0.003 ? 'warning' : 'info'
  const fr = runsOf(uniq(featTri))
  add({ name: 'thin_features', severity: featSev, count: feat, value: Number.isFinite(minFeat) ? round(minFeat, 2) : null, unit: 'mm', share: round(featShare, 4),
    ...(minFeatAt && feat > 0 ? { at: minFeatAt.map(v => round(v, 2)) as [number, number, number] } : {}), ...(feat > 0 ? { triangles: fr.runs, truncated: fr.truncated } : {}),
    params: { min: th.minFeature, thinnest: Number.isFinite(minFeat) ? round(minFeat, 2) : 0, percent: round(featShare * 100, 1) } })
  const gapSev: Severity = gaps === 0 ? 'ok' : gapShare >= 0.003 || gaps >= 3 ? 'warning' : 'info'
  const gr = runsOf(uniq(gapTri))
  add({ name: 'narrow_gaps', severity: gapSev, count: gaps, value: Number.isFinite(minGapSeen) && gaps > 0 ? round(minGapSeen, 2) : null, unit: 'mm', share: round(gapShare, 4),
    ...(minGapAt && gaps > 0 ? { at: minGapAt.map(v => round(v, 2)) as [number, number, number] } : {}), ...(gaps > 0 ? { triangles: gr.runs, truncated: gr.truncated } : {}),
    params: { min: th.minGap, narrowest: Number.isFinite(minGapSeen) && gaps > 0 ? round(minGapSeen, 2) : 0, percent: round(gapShare * 100, 1) } })
  cancelled(o)

  // ---------------------------------------------------------------- 3. overhangs, bridges, the base
  const oh: OverhangResult = overhangForUp(mesh, [0, 0, 1], o.overhangAngle, { flags: true })
  const ohShare = oh.surface > 0 ? oh.area / oh.surface : 0
  const ohRuns = oh.flags ? flagRuns(oh.flags) : { runs: [] as Array<[number, number]>, truncated: false }
  const supSev: Severity = oh.count === 0 ? 'ok' : ohShare >= 0.05 ? 'warning' : ohShare >= 0.005 ? 'info' : 'ok'
  add({ name: 'needs_support', severity: supSev, count: oh.count, value: round(oh.area, 1), unit: 'mm²', share: round(ohShare, 4),
    ...(oh.count > 0 ? { triangles: ohRuns.runs, truncated: ohRuns.truncated } : {}), params: { area: round(oh.area, 1), percent: round(ohShare * 100, 1), angle: o.overhangAngle } })
  const down = new Float64Array(nt)
  for (let t = 0; t < nt; t++) down[t] = -(nz[t] as number)
  const br = bridges(mesh, oh.flags ?? new Uint8Array(nt), down, m.bbox.min[2])
  const longOnes = br.groups.filter(g => g.span > o.bridgeLength)
  const longTris = longOnes.flatMap(g => g.tris).sort((a, b) => a - b)
  const lr = runsOf(longTris)
  add({ name: 'long_bridges', severity: longOnes.length > 0 ? 'warning' : 'ok', count: longOnes.length, value: br.widest > 0 ? round(br.widest, 1) : null, unit: 'mm', share: null,
    ...(br.at && longOnes.length > 0 ? { at: br.at.map(v => round(v, 1)) as [number, number, number] } : {}), ...(longOnes.length > 0 ? { triangles: lr.runs, truncated: lr.truncated } : {}),
    params: { widest: round(br.widest, 1), max: o.bridgeLength } })
  // the base: what lies flat on the bed
  const baseR = Math.sqrt(Math.max(0, oh.bed_area) / Math.PI)
  const tinyBase = oh.bed_area < Math.max(2, 0.002 * oh.surface)
  add({ name: 'tiny_base', severity: tinyBase ? 'warning' : 'ok', count: tinyBase ? 1 : 0, value: round(oh.bed_area, 1), unit: 'mm²', share: null,
    params: { area: round(oh.bed_area, 1), height: round(oh.height, 1) } })
  const foot = Math.max(m.size[0], m.size[1], 1e-9)
  const aspect = m.size[2] / foot
  const tallSev: Severity = aspect > 15 ? 'error' : aspect > 6 ? 'warning' : 'ok'
  // a tall part on a small base also tips: the centre of mass is high above the base
  const tips = oh.com_height !== null && baseR > 0 && oh.com_height > 4 * baseR && oh.height > 20
  add({ name: 'too_tall', severity: tips && tallSev === 'ok' ? 'warning' : tallSev, count: tallSev === 'ok' && !tips ? 0 : 1, value: round(aspect, 1), unit: '×', share: null,
    params: { ratio: round(aspect, 1), height: round(m.size[2], 1), width: round(foot, 1) } })
  o.onProgress?.('printcheck', 0.84)

  // ---------------------------------------------------------------- 3b. printing in mid-air: floating bodies, islands, overhang regions, bridges
  const minOh = o.minOverhangArea ?? 20
  const air = airAnalysis({ mesh, bvh, nz, area, flags: oh.flags ?? new Uint8Array(nt), bedZ: m.bbox.min[2], plateTol: 0.05, contactTol: Math.max(0.05, th.minGap), bridgeLength: o.bridgeLength,
    minOverhangArea: minOh, layerHeight: o.process === 'resin' ? Math.min(o.layerHeight, 0.1) : o.layerHeight, diag, cancel: () => cancelled(o) })
  const bigIslands = air.islands.filter(i => !i.tip), tipIslands = air.islands.filter(i => i.tip)
  const needing = air.regions.filter(r => r.kind === 'overhang'), bridgeRegions = air.regions.filter(r => r.kind === 'bridge')
  const all = (l: Array<{ tris: number[] }>): ReturnType<typeof runsOf> => runsOf(uniq(l.flatMap(x => x.tris)))
  const at3 = (a: [number, number, number]): [number, number, number] => a.map(v => round(v, 1)) as [number, number, number]
  // the best of the six axis orientations, by the overhang area (the same measure as the Orient step), as a suggestion with numbers
  const trouble = needing.length > 0 || bridgeRegions.length > 0 || bigIslands.length > 0
  let turn: Record<string, number> = { turn: 0 }
  if (trouble) {
    const cands = axisCandidates(mesh, o.overhangAngle)
    const bi = bestCandidate(cands, 'min_support'), cur = cands[0]!, best = cands[bi]!
    if (bi !== 0 && best.overhang_area <= 0.7 * cur.overhang_area && cur.overhang_area - best.overhang_area >= Math.max(1, minOh / 2))
      turn = { turn: 1, from_area: round(cur.overhang_area, 0), to_area: round(best.overhang_area, 0), turn_x: best.angles[0], turn_y: best.angles[1], turn_z: best.angles[2] }
  }
  const fl = all(air.floating)
  add({ name: 'floating_body', severity: air.floating.length > 0 ? 'error' : 'ok', count: air.floating.length, value: air.floating.length > 0 ? round(Math.min(...air.floating.map(f => f.gap)), 1) : null, unit: 'mm', share: null,
    ...(air.floating[0] ? { at: at3(air.floating[0].at) } : {}), ...(air.floating.length > 0 ? { triangles: fl.runs, truncated: fl.truncated } : {}),
    params: { bodies: air.floating.length, gap: air.floating.length > 0 ? round(Math.min(...air.floating.map(f => f.gap)), 1) : 0, size: air.floating[0] ? round(air.floating[0].size, 1) : 0 } })
  const isl = all(bigIslands.length > 0 ? bigIslands : tipIslands), top = (bigIslands[0] ?? tipIslands[0])
  add({ name: 'island', severity: bigIslands.length > 0 ? 'error' : tipIslands.length > 0 ? 'warning' : 'ok', count: bigIslands.length > 0 ? bigIslands.length : tipIslands.length, value: top ? round(top.area, 1) : null, unit: 'mm²', share: null,
    ...(top ? { at: at3(top.at), triangles: isl.runs, truncated: isl.truncated } : {}),
    params: { count: bigIslands.length > 0 ? bigIslands.length : tipIslands.length, tips: tipIslands.length, height: top ? round(top.height, 1) : 0, area: top ? round(top.area, 1) : 0, size: top ? round(top.size, 1) : 0, ...(bigIslands.length > 0 ? turn : { turn: 0 }) } })
  const ohArea = needing.reduce((s, r) => s + r.area, 0), big = needing[0]
  const oh2 = all(needing)
  add({ name: 'overhang', severity: needing.length > 0 ? 'warning' : 'ok', count: needing.length, value: needing.length > 0 ? round(ohArea, 1) : null, unit: 'mm²', share: round(oh.surface > 0 ? ohArea / oh.surface : 0, 4),
    ...(big ? { at: at3(big.at), triangles: oh2.runs, truncated: oh2.truncated } : {}),
    params: { regions: needing.length, area: round(ohArea, 1), percent: round(oh.surface > 0 ? (ohArea / oh.surface) * 100 : 0, 1), largest: big ? round(big.area, 1) : 0, height: big ? round(big.height, 1) : 0, angle: o.overhangAngle, min_area: minOh, ...(needing.length > 0 ? turn : { turn: 0 }) } })
  const widest = bridgeRegions.reduce((s, r) => Math.max(s, r.span ?? 0), 0), wb = bridgeRegions.slice().sort((a, b) => (b.span ?? 0) - (a.span ?? 0))[0]
  const br2 = all(bridgeRegions)
  add({ name: 'bridge', severity: bridgeRegions.length > 0 ? 'warning' : 'ok', count: bridgeRegions.length, value: bridgeRegions.length > 0 ? round(widest, 1) : null, unit: 'mm', share: null,
    ...(wb ? { at: at3(wb.at), triangles: br2.runs, truncated: br2.truncated } : {}),
    params: { count: bridgeRegions.length, widest: round(widest, 1), max: o.bridgeLength, height: wb ? round(wb.height, 1) : 0, area: wb ? round(wb.area, 1) : 0, ...(bridgeRegions.length > 0 ? turn : { turn: 0 }) } })
  o.onProgress?.('printcheck', 0.88)

  // ---------------------------------------------------------------- 4. the build volume
  const [bx, by, bz] = o.bed
  if (bx > 0 || by > 0 || bz > 0) {
    const fits = (w: number, d: number, h: number): boolean => (bx <= 0 || w <= bx + 1e-6) && (by <= 0 || d <= by + 1e-6) && (bz <= 0 || h <= bz + 1e-6)
    const asLies = fits(m.size[0], m.size[1], m.size[2])
    let turnedAt: number | null = null
    if (!asLies) {
      const step = Math.max(1, Math.floor(P.length / 3 / 100000))
      for (let deg = 5; deg <= 90 && turnedAt === null; deg += 5) {
        const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180)
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
        for (let v = 0; v < P.length / 3; v += step) {
          const x = (P[3 * v] as number) * c + (P[3 * v + 1] as number) * s, y = -(P[3 * v] as number) * s + (P[3 * v + 1] as number) * c
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
        }
        if (fits(x1 - x0, y1 - y0, m.size[2])) turnedAt = deg
      }
    }
    add({ name: 'too_big_for_bed', severity: asLies ? 'ok' : turnedAt !== null ? 'warning' : 'error', count: asLies ? 0 : 1, value: round(Math.max(m.size[0] - (bx || Infinity), m.size[1] - (by || Infinity), m.size[2] - (bz || Infinity)), 1), unit: 'mm', share: null,
      params: { x: round(m.size[0], 1), y: round(m.size[1], 1), z: round(m.size[2], 1), bed_x: bx, bed_y: by, bed_z: bz, turn: turnedAt ?? 0 } })
  }

  // ---------------------------------------------------------------- 5. figures that are not problems
  const needle = needles(mesh, 5)
  add({ name: 'needles', severity: needle > 0 ? 'info' : 'ok', count: needle, value: null, unit: 'triangles', share: round(needle / nt, 4), params: { count: needle } })
  add({ name: 'detail', severity: 'info', count: nt, value: null, unit: 'triangles', share: null, params: { count: nt } })
  o.onProgress?.('printcheck', 1)

  // ---------------------------------------------------------------- the score and the verdict
  // A fixed price for each finding, so the score can be explained: an error costs more than a warning; a few checks scale with how much of the surface fails.
  const price = (f: Finding): number => {
    const e = f.severity === 'error', w = f.severity === 'warning'
    if (!e && !w) return 0
    switch (f.name) {
      case 'not_closed': return 40
      case 'too_big_for_bed': return e ? 40 : 10
      case 'islands': return 10
      case 'thin_walls': return e ? 25 : 8 + Math.min(10, (f.share ?? 0) * 100)
      case 'thin_features': return e ? 15 : 8
      case 'narrow_gaps': return 8
      case 'needs_support': return Math.min(10, 3 + (f.share ?? 0) * 25)
      case 'long_bridges': return 5
      case 'floating_body': return 30
      case 'island': return e ? 20 : 3
      case 'overhang': return 4
      case 'bridge': return 3
      case 'tiny_base': return 8
      case 'too_tall': return e ? 15 : 8
      default: return 0
    }
  }
  const score = Math.max(0, Math.round(100 - findings.reduce((s, f) => s + price(f), 0)))
  const hasError = findings.some(f => f.severity === 'error')
  const hasWarning = findings.some(f => f.severity === 'warning')
  const verdict: Verdict = hasError ? 'not_printable' : hasWarning || score < 90 ? 'fix_recommended' : 'good'
  return {
    verdict, score, issues: findings.filter(f => f.severity === 'warning' || f.severity === 'error').length, findings,
    thresholds: { min_wall: round(th.minWall, 3), min_feature: round(th.minFeature, 3), min_gap: round(th.minGap, 3), overhang_angle: o.overhangAngle, bridge_length: o.bridgeLength, min_overhang_area: o.minOverhangArea ?? 20, nozzle: o.nozzle, process: o.process },
    samples: valid, size: [round(m.size[0], 2), round(m.size[1], 2), round(m.size[2], 2)], triangles: nt, ms: Date.now() - t0,
  }
}
