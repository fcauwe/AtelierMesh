// Signed distance to a closed triangle mesh: negative inside, positive outside, in millimetres.
//
// The nearest triangle comes from a bounding-volume hierarchy (median split on the triangle centres, closest-point query with a distance bound).
// The sign comes from the angle-weighted pseudo-normal of the nearest feature (Baerentzen and Aanaes 2005): the face normal when the nearest point
// lies inside a triangle, the sum of the two face normals on an edge, the angle-weighted sum on a vertex. It is exact for a closed, manifold,
// consistently wound mesh, and it costs one dot product, where a winding number would visit every triangle for every query.
// The mesh must be closed (every edge shared by exactly two triangles); `MeshDistance.create` returns null when it is not.
import type { Mesh } from '@ateliermesh/core'

const LEAF = 6

export class MeshDistance {
  /** The triangle the last query found nearest, and the squared distance to it. */
  lastTriangle = -1
  lastD2 = 0
  /** The point of the surface nearest to the last query. */
  lastX = 0; lastY = 0; lastZ = 0

  private constructor(
    private readonly tri: Float64Array, private readonly idx: Uint32Array,
    private readonly fn: Float64Array, private readonly vn: Float64Array, private readonly en: Float64Array,
    private readonly box: Float64Array, private readonly left: Int32Array, private readonly right: Int32Array,
    private readonly start: Int32Array, private readonly count: Int32Array, private readonly order: Uint32Array,
  ) {}

  /** Null when the mesh is not closed and manifold. `outward` is 1 when the triangles face outward, -1 when the winding is reversed. */
  static create(mesh: Mesh, outward = 1): MeshDistance | null {
    const P = mesh.positions, T = mesh.indices
    const nt = T.length / 3, nv = P.length / 3
    if (nt === 0) return null
    const tri = new Float64Array(9 * nt), fn = new Float64Array(3 * nt)
    for (let t = 0; t < nt; t++) {
      for (let k = 0; k < 3; k++) {
        const v = 3 * (T[3 * t + k] as number)
        tri[9 * t + 3 * k] = P[v] as number; tri[9 * t + 3 * k + 1] = P[v + 1] as number; tri[9 * t + 3 * k + 2] = P[v + 2] as number
      }
      const e1x = tri[9 * t + 3]! - tri[9 * t]!, e1y = tri[9 * t + 4]! - tri[9 * t + 1]!, e1z = tri[9 * t + 5]! - tri[9 * t + 2]!
      const e2x = tri[9 * t + 6]! - tri[9 * t]!, e2y = tri[9 * t + 7]! - tri[9 * t + 1]!, e2z = tri[9 * t + 8]! - tri[9 * t + 2]!
      let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x
      const l = Math.hypot(nx, ny, nz) || 1
      nx /= l; ny /= l; nz /= l
      fn[3 * t] = nx * outward; fn[3 * t + 1] = ny * outward; fn[3 * t + 2] = nz * outward
    }
    // the triangle across each edge: every edge must be shared by exactly two triangles
    const first = new Map<number, number>()
    const across = new Int32Array(3 * nt).fill(-1)
    for (let t = 0; t < nt; t++) {
      for (let e = 0; e < 3; e++) {
        const a = T[3 * t + e] as number, b = T[3 * t + (e + 1) % 3] as number
        const key = a < b ? a * nv + b : b * nv + a
        const other = first.get(key)
        if (other === undefined) first.set(key, 3 * t + e)
        else {
          if (across[other] !== -1 || across[3 * t + e] !== -1) return null
          across[other] = t; across[3 * t + e] = (other / 3) | 0
        }
      }
    }
    for (let i = 0; i < across.length; i++) if (across[i] === -1) return null
    // pseudo-normals: edges (sum of the two face normals) and vertices (face normals weighted by the angle at the vertex)
    const en = new Float64Array(9 * nt), vn = new Float64Array(3 * nv)
    for (let t = 0; t < nt; t++) {
      for (let e = 0; e < 3; e++) {
        const o = across[3 * t + e] as number
        for (let k = 0; k < 3; k++) en[9 * t + 3 * e + k] = (fn[3 * t + k] as number) + (fn[3 * o + k] as number)
      }
      for (let k = 0; k < 3; k++) {
        const ax = tri[9 * t + 3 * k]!, ay = tri[9 * t + 3 * k + 1]!, az = tri[9 * t + 3 * k + 2]!
        const b = (k + 1) % 3, c = (k + 2) % 3
        const ux = tri[9 * t + 3 * b]! - ax, uy = tri[9 * t + 3 * b + 1]! - ay, uz = tri[9 * t + 3 * b + 2]! - az
        const wx = tri[9 * t + 3 * c]! - ax, wy = tri[9 * t + 3 * c + 1]! - ay, wz = tri[9 * t + 3 * c + 2]! - az
        const ul = Math.hypot(ux, uy, uz), wl = Math.hypot(wx, wy, wz)
        if (ul === 0 || wl === 0) continue
        const ang = Math.acos(Math.min(1, Math.max(-1, (ux * wx + uy * wy + uz * wz) / (ul * wl))))
        const v = 3 * (T[3 * t + k] as number)
        vn[v] = (vn[v] as number) + (fn[3 * t] as number) * ang; vn[v + 1] = (vn[v + 1] as number) + (fn[3 * t + 1] as number) * ang; vn[v + 2] = (vn[v + 2] as number) + (fn[3 * t + 2] as number) * ang
      }
    }
    // the hierarchy
    const order = new Uint32Array(nt)
    const cx = new Float64Array(nt), cy = new Float64Array(nt), cz = new Float64Array(nt)
    for (let t = 0; t < nt; t++) {
      order[t] = t
      cx[t] = (tri[9 * t]! + tri[9 * t + 3]! + tri[9 * t + 6]!) / 3; cy[t] = (tri[9 * t + 1]! + tri[9 * t + 4]! + tri[9 * t + 7]!) / 3; cz[t] = (tri[9 * t + 2]! + tri[9 * t + 5]! + tri[9 * t + 8]!) / 3
    }
    const maxNodes = Math.max(1, Math.ceil(nt / (LEAF / 2)) * 2)
    let box = new Float64Array(6 * maxNodes), left = new Int32Array(maxNodes).fill(-1), right = new Int32Array(maxNodes).fill(-1), start = new Int32Array(maxNodes), count = new Int32Array(maxNodes)
    let n = 0
    const root = n++
    const stack: Array<[number, number, number]> = [[root, 0, nt]]
    while (stack.length > 0) {
      const [node, lo, hi] = stack.pop() as [number, number, number]
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
      for (let i = lo; i < hi; i++) {
        const t = order[i] as number
        for (let k = 0; k < 3; k++) {
          const x = tri[9 * t + 3 * k]!, y = tri[9 * t + 3 * k + 1]!, z = tri[9 * t + 3 * k + 2]!
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z
        }
      }
      box[6 * node] = x0; box[6 * node + 1] = y0; box[6 * node + 2] = z0; box[6 * node + 3] = x1; box[6 * node + 4] = y1; box[6 * node + 5] = z1
      start[node] = lo; count[node] = hi - lo
      if (hi - lo <= LEAF) continue
      const ex = x1 - x0, ey = y1 - y0, ez = z1 - z0
      const key = ex >= ey && ex >= ez ? cx : ey >= ez ? cy : cz
      const mid = (lo + hi) >> 1
      select(order, key, lo, hi - 1, mid)
      const l = n++, r = n++
      left[node] = l; right[node] = r; count[node] = 0
      stack.push([l, lo, mid], [r, mid, hi])
    }
    box = box.slice(0, 6 * n); left = left.slice(0, n); right = right.slice(0, n); start = start.slice(0, n); count = count.slice(0, n)
    return new MeshDistance(tri, T, fn, vn, en, box, left, right, start, count, order)
  }

  private readonly stack = new Int32Array(256)

  /**
   * The signed distance from a point. `hint` is a triangle that is probably near (the one the previous, neighbouring query found): it gives the search
   * a distance bound to start from, which makes a walk along a surface several times faster.
   */
  signed(px: number, py: number, pz: number, hint = -1): number {
    const { tri, box, left, right, start, count, order, stack } = this
    let best = Infinity, bestT = -1, bestRegion = 0, bqx = 0, bqy = 0, bqz = 0
    if (hint >= 0) {
      best = closest(tri, hint, px, py, pz); bestT = hint; bestRegion = REGION; bqx = QX; bqy = QY; bqz = QZ
    }
    let sp = 0
    stack[sp++] = 0
    while (sp > 0) {
      const node = stack[--sp] as number
      const l = left[node] as number
      if (l < 0) {
        const s = start[node] as number, e = s + (count[node] as number)
        for (let i = s; i < e; i++) {
          const t = order[i] as number
          const d = closest(tri, t, px, py, pz)
          if (d < best) { best = d; bestT = t; bestRegion = REGION; bqx = QX; bqy = QY; bqz = QZ }
        }
        continue
      }
      const r = right[node] as number
      const dl = boxDist2(box, l, px, py, pz), dr = boxDist2(box, r, px, py, pz)
      // the nearer child is visited first: push the farther one first, and only when it can still hold something nearer
      if (dl <= dr) { if (dr < best) stack[sp++] = r; if (dl < best) stack[sp++] = l } else { if (dl < best) stack[sp++] = l; if (dr < best) stack[sp++] = r }
    }
    this.lastTriangle = bestT; this.lastD2 = best; this.lastX = bqx; this.lastY = bqy; this.lastZ = bqz
    // the sign: which side of the nearest feature's pseudo-normal the point is on
    let nx: number, ny: number, nz: number
    if (bestRegion === 0) { nx = this.fn[3 * bestT] as number; ny = this.fn[3 * bestT + 1] as number; nz = this.fn[3 * bestT + 2] as number }
    else if (bestRegion <= 3) { const v = 3 * (this.idx[3 * bestT + bestRegion - 1] as number); nx = this.vn[v] as number; ny = this.vn[v + 1] as number; nz = this.vn[v + 2] as number }
    else { const o = 9 * bestT + 3 * (bestRegion - 4); nx = this.en[o] as number; ny = this.en[o + 1] as number; nz = this.en[o + 2] as number }
    const dot = (px - bqx) * nx + (py - bqy) * ny + (pz - bqz) * nz
    const d = Math.sqrt(best)
    return dot < 0 ? -d : d
  }
}

// ---- closest point on a triangle (Ericson, Real-Time Collision Detection 5.1.5), without allocation: the result is left in these variables
let QX = 0, QY = 0, QZ = 0, REGION = 0

/** Squared distance from p to triangle t; sets QX..QZ to the closest point and REGION to 0 (face), 1..3 (vertex a, b, c), 4..6 (edge ab, bc, ca). */
function closest(tri: Float64Array, t: number, px: number, py: number, pz: number): number {
  const o = 9 * t
  const ax = tri[o]!, ay = tri[o + 1]!, az = tri[o + 2]!, bx = tri[o + 3]!, by = tri[o + 4]!, bz = tri[o + 5]!, cx = tri[o + 6]!, cy = tri[o + 7]!, cz = tri[o + 8]!
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az
  const apx = px - ax, apy = py - ay, apz = pz - az
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz
  if (d1 <= 0 && d2 <= 0) { QX = ax; QY = ay; QZ = az; REGION = 1; return sq(px - ax, py - ay, pz - az) }
  const bpx = px - bx, bpy = py - by, bpz = pz - bz
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz
  if (d3 >= 0 && d4 <= d3) { QX = bx; QY = by; QZ = bz; REGION = 2; return sq(px - bx, py - by, pz - bz) }
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3)
    QX = ax + v * abx; QY = ay + v * aby; QZ = az + v * abz; REGION = 4
    return sq(px - QX, py - QY, pz - QZ)
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz
  if (d6 >= 0 && d5 <= d6) { QX = cx; QY = cy; QZ = cz; REGION = 3; return sq(px - cx, py - cy, pz - cz) }
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6)
    QX = ax + w * acx; QY = ay + w * acy; QZ = az + w * acz; REGION = 6
    return sq(px - QX, py - QY, pz - QZ)
  }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6))
    QX = bx + w * (cx - bx); QY = by + w * (cy - by); QZ = bz + w * (cz - bz); REGION = 5
    return sq(px - QX, py - QY, pz - QZ)
  }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den
  QX = ax + abx * v + acx * w; QY = ay + aby * v + acy * w; QZ = az + abz * v + acz * w; REGION = 0
  return sq(px - QX, py - QY, pz - QZ)
}
const sq = (x: number, y: number, z: number): number => x * x + y * y + z * z

function boxDist2(box: Float64Array, node: number, px: number, py: number, pz: number): number {
  const o = 6 * node
  const dx = px < box[o]! ? box[o]! - px : px > box[o + 3]! ? px - box[o + 3]! : 0
  const dy = py < box[o + 1]! ? box[o + 1]! - py : py > box[o + 4]! ? py - box[o + 4]! : 0
  const dz = pz < box[o + 2]! ? box[o + 2]! - pz : pz > box[o + 5]! ? pz - box[o + 5]! : 0
  return dx * dx + dy * dy + dz * dz
}

/** Reorders order[lo..hi] so that order[k] holds the element of rank k by key (quickselect). */
function select(order: Uint32Array, key: Float64Array, lo: number, hi: number, k: number): void {
  while (hi > lo) {
    const pivot = key[order[(lo + hi) >> 1] as number] as number
    let i = lo, j = hi
    while (i <= j) {
      while ((key[order[i] as number] as number) < pivot) i++
      while ((key[order[j] as number] as number) > pivot) j--
      if (i <= j) { const t = order[i] as number; order[i] = order[j] as number; order[j] = t; i++; j-- }
    }
    if (k <= j) hi = j
    else if (k >= i) lo = i
    else return
  }
}
