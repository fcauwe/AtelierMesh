// Unfolding the patch into the plane. ARAP (as-rigid-as-possible, Liu et al. 2008) started from a plain projection onto the tangent
// plane; LSCM (Levy et al. 2002) is the fallback when a fold-over survives. Written from the published papers.
import { vadd, vdot, vscale, vsub } from './vec'
import type { V3 } from './vec'
import type { Patch } from './patch'

/** Preconditioned conjugate gradient on a matrix given as a function. Returns the iteration count. */
function cg(mul: (x: Float64Array, out: Float64Array) => void, b: Float64Array, x: Float64Array, diag: Float64Array, tol: number, maxIter: number): number {
  const n = b.length
  const r = new Float64Array(n), z = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n)
  mul(x, Ap)
  for (let i = 0; i < n; i++) r[i] = (b[i] as number) - (Ap[i] as number)
  let bn = 0
  for (let i = 0; i < n; i++) bn += (b[i] as number) ** 2
  bn = Math.sqrt(bn) || 1
  for (let i = 0; i < n; i++) z[i] = (diag[i] as number) > 1e-30 ? (r[i] as number) / (diag[i] as number) : (r[i] as number)
  p.set(z)
  let rz = 0
  for (let i = 0; i < n; i++) rz += (r[i] as number) * (z[i] as number)
  let it = 0
  for (; it < maxIter; it++) {
    let rn = 0
    for (let i = 0; i < n; i++) rn += (r[i] as number) ** 2
    if (Math.sqrt(rn) / bn < tol) break
    mul(p, Ap)
    let pAp = 0
    for (let i = 0; i < n; i++) pAp += (p[i] as number) * (Ap[i] as number)
    if (pAp <= 0) break
    const al = rz / pAp
    for (let i = 0; i < n; i++) { x[i] = (x[i] as number) + al * (p[i] as number); r[i] = (r[i] as number) - al * (Ap[i] as number) }
    for (let i = 0; i < n; i++) z[i] = (diag[i] as number) > 1e-30 ? (r[i] as number) / (diag[i] as number) : (r[i] as number)
    let rz2 = 0
    for (let i = 0; i < n; i++) rz2 += (r[i] as number) * (z[i] as number)
    const be = rz2 / rz
    rz = rz2
    for (let i = 0; i < n; i++) p[i] = (z[i] as number) + be * (p[i] as number)
  }
  return it
}

/** LSCM with two pinned vertices `pinA` at the origin and `pinB` at distance D on the x axis. */
export function lscm(patch: Patch, pinA: number, pinB: number, D: number, tol = 1e-6, maxIt = 4000): Float64Array {
  const { nv, nt, T, X, area } = patch
  const idx = new Int32Array(nv).fill(-1)
  let nf = 0
  for (let v = 0; v < nv; v++) if (v !== pinA && v !== pinB) idx[v] = nf++
  const nrow = 2 * nt
  const col = new Int32Array(nrow * 6).fill(-1), val = new Float64Array(nrow * 6), rhs = new Float64Array(nrow)
  const pin = new Map<number, [number, number]>([[pinA, [0, 0]], [pinB, [D, 0]]])
  for (let t = 0; t < nt; t++) {
    const z: Array<[number, number]> = [[0, 0], [X[6 * t + 2] as number, 0], [X[6 * t + 4] as number, X[6 * t + 5] as number]]
    const W: Array<[number, number]> = [[z[2]![0] - z[1]![0], z[2]![1] - z[1]![1]], [z[0]![0] - z[2]![0], z[0]![1] - z[2]![1]], [z[1]![0] - z[0]![0], z[1]![1] - z[0]![1]]]
    const s = 1 / Math.sqrt(area[t] as number)
    for (let j = 0; j < 3; j++) {
      const v = T[3 * t + j] as number, wr = W[j]![0] * s, wi = W[j]![1] * s
      const rr = 2 * t, ri = 2 * t + 1
      const pv = pin.get(v)
      if (pv) { rhs[rr] = (rhs[rr] as number) - (wr * pv[0] - wi * pv[1]); rhs[ri] = (rhs[ri] as number) - (wi * pv[0] + wr * pv[1]) }
      else {
        col[rr * 6 + 2 * j] = idx[v] as number; val[rr * 6 + 2 * j] = wr; col[rr * 6 + 2 * j + 1] = nf + (idx[v] as number); val[rr * 6 + 2 * j + 1] = -wi
        col[ri * 6 + 2 * j] = idx[v] as number; val[ri * 6 + 2 * j] = wi; col[ri * 6 + 2 * j + 1] = nf + (idx[v] as number); val[ri * 6 + 2 * j + 1] = wr
      }
    }
  }
  const n = 2 * nf, y = new Float64Array(nrow)
  const Ax = (x: Float64Array): void => { for (let r = 0; r < nrow; r++) { let s = 0; for (let k = 0; k < 6; k++) { const c = col[r * 6 + k] as number; if (c >= 0) s += (val[r * 6 + k] as number) * (x[c] as number) } y[r] = s } }
  const mul = (x: Float64Array, out: Float64Array): void => { Ax(x); out.fill(0); for (let r = 0; r < nrow; r++) for (let k = 0; k < 6; k++) { const c = col[r * 6 + k] as number; if (c >= 0) out[c] = (out[c] as number) + (val[r * 6 + k] as number) * (y[r] as number) } }
  const b = new Float64Array(n), diag = new Float64Array(n)
  for (let r = 0; r < nrow; r++) for (let k = 0; k < 6; k++) { const c = col[r * 6 + k] as number; if (c >= 0) { b[c] = (b[c] as number) + (val[r * 6 + k] as number) * (rhs[r] as number); diag[c] = (diag[c] as number) + (val[r * 6 + k] as number) ** 2 } }
  const x = new Float64Array(n)
  cg(mul, b, x, diag, tol, maxIt)
  const uv = new Float64Array(2 * nv)
  for (let v = 0; v < nv; v++) {
    const pv = pin.get(v)
    if (pv) { uv[2 * v] = pv[0]; uv[2 * v + 1] = pv[1] } else { uv[2 * v] = x[idx[v] as number] as number; uv[2 * v + 1] = x[nf + (idx[v] as number)] as number }
  }
  return uv
}

/** Scale so the map's area equals the surface area; mirror when most triangles are flipped. */
export function normaliseUV(patch: Patch, uv: Float64Array): Float64Array {
  const { nt, T, area } = patch
  let a3 = 0, auv = 0, pos = 0
  for (let t = 0; t < nt; t++) {
    a3 += area[t] as number
    const i0 = T[3 * t] as number, i1 = T[3 * t + 1] as number, i2 = T[3 * t + 2] as number
    const d = ((uv[2 * i1] as number) - (uv[2 * i0] as number)) * ((uv[2 * i2 + 1] as number) - (uv[2 * i0 + 1] as number)) - ((uv[2 * i1 + 1] as number) - (uv[2 * i0 + 1] as number)) * ((uv[2 * i2] as number) - (uv[2 * i0] as number))
    auv += Math.abs(d) / 2
    if (d > 0) pos++
  }
  const s = Math.sqrt(a3 / auv), mirror = pos < nt / 2
  const out = new Float64Array(uv.length)
  for (let v = 0; v < uv.length / 2; v++) { out[2 * v] = (uv[2 * v] as number) * s * (mirror ? -1 : 1); out[2 * v + 1] = (uv[2 * v + 1] as number) * s }
  return out
}

/** ARAP with one pinned vertex and a free boundary. */
export function arap(patch: Patch, uv0: Float64Array, pinV: number, maxIter = 30, tolE = 1e-7, cgTol = 1e-9, cgMax = 600): Float64Array {
  const { nv, nt, T, X } = patch
  const w = new Float64Array(3 * nt)
  for (let t = 0; t < nt; t++) {
    const x: Array<[number, number]> = [[0, 0], [X[6 * t + 2] as number, 0], [X[6 * t + 4] as number, X[6 * t + 5] as number]]
    for (let k = 0; k < 3; k++) {
      const a = x[(k + 1) % 3]!, b = x[(k + 2) % 3]!, c = x[k]!
      const ea = [a[0] - c[0], a[1] - c[1]], eb = [b[0] - c[0], b[1] - c[1]]
      const cot = ((ea[0] as number) * (eb[0] as number) + (ea[1] as number) * (eb[1] as number)) / Math.max(1e-12, Math.abs((ea[0] as number) * (eb[1] as number) - (ea[1] as number) * (eb[0] as number)))
      w[3 * t + k] = Math.max(cot, 1e-4)
    }
  }
  const nb = Array.from({ length: nv }, () => new Map<number, number>())
  const diagL = new Float64Array(nv)
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
    const a = T[3 * t + ((k + 1) % 3)] as number, b = T[3 * t + ((k + 2) % 3)] as number, ww = w[3 * t + k] as number
    nb[a]!.set(b, (nb[a]!.get(b) ?? 0) - ww); nb[b]!.set(a, (nb[b]!.get(a) ?? 0) - ww)
    diagL[a] = (diagL[a] as number) + ww; diagL[b] = (diagL[b] as number) + ww
  }
  const rowPtr = new Int32Array(nv + 1), cols: number[] = [], vals: number[] = []
  for (let v = 0; v < nv; v++) { for (const [c, x] of nb[v]!) { cols.push(c); vals.push(x) } rowPtr[v + 1] = cols.length }
  const colI = Int32Array.from(cols), valF = Float64Array.from(vals)
  const Lmul = (x: Float64Array, out: Float64Array, skip: number): void => {
    for (let v = 0; v < nv; v++) {
      if (v === skip) { out[v] = 0; continue }
      let s = (diagL[v] as number) * (x[v] as number)
      for (let i = rowPtr[v] as number; i < (rowPtr[v + 1] as number); i++) { const c = colI[i] as number; if (c !== skip) s += (valF[i] as number) * (x[c] as number) }
      out[v] = s
    }
  }
  const uv = Float64Array.from(uv0)
  const hist: number[] = []
  const bu = new Float64Array(nv), bv = new Float64Array(nv)
  for (let it = 0; it < maxIter; it++) {
    bu.fill(0); bv.fill(0)
    let E = 0
    for (let t = 0; t < nt; t++) {
      const x: Array<[number, number]> = [[0, 0], [X[6 * t + 2] as number, 0], [X[6 * t + 4] as number, X[6 * t + 5] as number]]
      const ids = [T[3 * t] as number, T[3 * t + 1] as number, T[3 * t + 2] as number]
      let S11 = 0, S12 = 0, S21 = 0, S22 = 0
      for (let k = 0; k < 3; k++) {
        const a = (k + 1) % 3, b = (k + 2) % 3, ww = w[3 * t + k] as number
        const dx = [x[a]![0] - x[b]![0], x[a]![1] - x[b]![1]], du = [(uv[2 * ids[a]!] as number) - (uv[2 * ids[b]!] as number), (uv[2 * ids[a]! + 1] as number) - (uv[2 * ids[b]! + 1] as number)]
        S11 += ww * (dx[0] as number) * (du[0] as number); S12 += ww * (dx[0] as number) * (du[1] as number); S21 += ww * (dx[1] as number) * (du[0] as number); S22 += ww * (dx[1] as number) * (du[1] as number)
      }
      const th = Math.atan2(S12 - S21, S11 + S22), c = Math.cos(th), s = Math.sin(th)
      for (let k = 0; k < 3; k++) {
        const a = (k + 1) % 3, b = (k + 2) % 3, ww = w[3 * t + k] as number
        const dx = [x[a]![0] - x[b]![0], x[a]![1] - x[b]![1]]
        const rx = [c * (dx[0] as number) - s * (dx[1] as number), s * (dx[0] as number) + c * (dx[1] as number)]
        const ia = ids[a] as number, ib = ids[b] as number
        bu[ia] = (bu[ia] as number) + ww * (rx[0] as number); bv[ia] = (bv[ia] as number) + ww * (rx[1] as number)
        bu[ib] = (bu[ib] as number) - ww * (rx[0] as number); bv[ib] = (bv[ib] as number) - ww * (rx[1] as number)
        const du0 = (uv[2 * ia] as number) - (uv[2 * ib] as number) - (rx[0] as number), du1 = (uv[2 * ia + 1] as number) - (uv[2 * ib + 1] as number) - (rx[1] as number)
        E += ww * (du0 * du0 + du1 * du1)
      }
    }
    hist.push(E)
    const U = new Float64Array(nv), V = new Float64Array(nv)
    for (let v = 0; v < nv; v++) { U[v] = uv[2 * v] as number; V[v] = uv[2 * v + 1] as number }
    for (const [vec, B] of [[U, bu], [V, bv]] as const) {
      const r = new Float64Array(nv)
      for (let v = 0; v < nv; v++) {
        let s = (diagL[v] as number) * (vec[v] as number)
        for (let i = rowPtr[v] as number; i < (rowPtr[v + 1] as number); i++) s += (valF[i] as number) * (vec[colI[i] as number] as number)
        r[v] = v === pinV ? 0 : (B[v] as number) - s
      }
      const delta = new Float64Array(nv)
      cg((x, o) => Lmul(x, o, pinV), r, delta, diagL, cgTol, cgMax)
      for (let v = 0; v < nv; v++) vec[v] = (vec[v] as number) + (delta[v] as number)
    }
    for (let v = 0; v < nv; v++) { uv[2 * v] = U[v] as number; uv[2 * v + 1] = V[v] as number }
    if (it > 0 && Math.abs((hist[it - 1] as number) - E) / Math.max(E, 1e-12) < tolE) break
  }
  return uv
}

export interface Stretch { maxStretch: number; rmsStretch: number; flips: number; triangles: number }

/** Length distortion (3D length per map length) over a set of triangles; flips count triangles turned inside out. */
export function stretchStats(patch: Patch, uv: Float64Array, subset?: number[]): Stretch {
  const { nt, T, X, area } = patch
  let flips = 0, maxS = 1, sumW = 0, sumS2 = 0, count = 0
  const list = subset ?? Array.from({ length: nt }, (_, i) => i)
  for (const t of list) {
    const i0 = T[3 * t] as number, i1 = T[3 * t + 1] as number, i2 = T[3 * t + 2] as number
    const u00 = (uv[2 * i1] as number) - (uv[2 * i0] as number), u01 = (uv[2 * i2] as number) - (uv[2 * i0] as number)
    const u10 = (uv[2 * i1 + 1] as number) - (uv[2 * i0 + 1] as number), u11 = (uv[2 * i2 + 1] as number) - (uv[2 * i0 + 1] as number)
    const x00 = X[6 * t + 2] as number, x01 = X[6 * t + 4] as number, x11 = X[6 * t + 5] as number
    const det = u00 * u11 - u01 * u10
    if (det <= 1e-14) { flips++; continue }
    const i00 = u11 / det, i01 = -u01 / det, i10 = -u10 / det, i11 = u00 / det
    const a = x00 * i00 + x01 * i10, b = x00 * i01 + x01 * i11, c = 0 * i00 + x11 * i10, d = 0 * i01 + x11 * i11
    const S = a * a + b * b + c * c + d * d, Dd = a * d - b * c, disc = Math.sqrt(Math.max(0, S * S - 4 * Dd * Dd))
    const s1 = Math.sqrt((S + disc) / 2), s2 = Math.sqrt(Math.max(1e-30, (S - disc) / 2))
    const st = Math.max(s1, 1 / s2)
    if (st > maxS) maxS = st
    sumW += area[t] as number; sumS2 += (area[t] as number) * (s1 * s1 + 1 / (s2 * s2)) / 2; count++
  }
  return { maxStretch: maxS, rmsStretch: Math.sqrt(sumS2 / Math.max(sumW, 1e-30)), flips, triangles: count }
}

/** Move the anchor to the map origin and turn the map so the reading direction `dir3` becomes +x. */
export function alignMap(patch: Patch, uv: Float64Array, anchorBary: V3, dir3: V3): Float64Array {
  const { T, P } = patch
  const t = patch.anchorLocalTri
  const ids = [T[3 * t] as number, T[3 * t + 1] as number, T[3 * t + 2] as number]
  const a: [number, number] = [0, 0]
  for (let k = 0; k < 3; k++) { a[0] += anchorBary[k]! * (uv[2 * ids[k]!] as number); a[1] += anchorBary[k]! * (uv[2 * ids[k]! + 1] as number) }
  const p = ids.map(i => [P[3 * i] as number, P[3 * i + 1] as number, P[3 * i + 2] as number] as V3)
  const e1 = vsub(p[1]!, p[0]!), e2 = vsub(p[2]!, p[0]!)
  const du1 = [(uv[2 * ids[1]!] as number) - (uv[2 * ids[0]!] as number), (uv[2 * ids[1]! + 1] as number) - (uv[2 * ids[0]! + 1] as number)]
  const du2 = [(uv[2 * ids[2]!] as number) - (uv[2 * ids[0]!] as number), (uv[2 * ids[2]! + 1] as number) - (uv[2 * ids[0]! + 1] as number)]
  const det = (du1[0] as number) * (du2[1] as number) - (du1[1] as number) * (du2[0] as number)
  const Jc0 = vadd(vscale(e1, (du2[1] as number) / det), vscale(e2, -(du1[1] as number) / det))
  const Jc1 = vadd(vscale(e1, -(du2[0] as number) / det), vscale(e2, (du1[0] as number) / det))
  const g00 = vdot(Jc0, Jc0), g01 = vdot(Jc0, Jc1), g11 = vdot(Jc1, Jc1), r0 = vdot(Jc0, dir3), r1 = vdot(Jc1, dir3), gd = g00 * g11 - g01 * g01
  const dx = (r0 * g11 - r1 * g01) / gd, dy = (g00 * r1 - g01 * r0) / gd
  const ang = Math.atan2(dy, dx), c = Math.cos(-ang), s = Math.sin(-ang)
  const out = new Float64Array(uv.length)
  for (let v = 0; v < uv.length / 2; v++) { const x = (uv[2 * v] as number) - a[0], y = (uv[2 * v + 1] as number) - a[1]; out[2 * v] = c * x - s * y; out[2 * v + 1] = s * x + c * y }
  return out
}

/** Orthogonal projection onto the tangent plane at the anchor: the starting point for ARAP. */
export function planarUV(patch: Patch, anchorPoint: V3, ex: V3, ey: V3): Float64Array {
  const uv = new Float64Array(2 * patch.nv)
  for (let v = 0; v < patch.nv; v++) {
    const p = vsub([patch.P[3 * v] as number, patch.P[3 * v + 1] as number, patch.P[3 * v + 2] as number], anchorPoint)
    uv[2 * v] = vdot(p, ex); uv[2 * v + 1] = vdot(p, ey)
  }
  return uv
}

export { readingFrame } from '@ateliermesh/core'
export type { ReadingFrame } from '@ateliermesh/core'
