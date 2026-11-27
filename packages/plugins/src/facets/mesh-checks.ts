import type { StructuredError } from '@ateliermesh/core'

const problem = (code: string, params: Record<string, unknown> = {}): StructuredError => ({ code, params })

export function checkClosed(I: Uint32Array, nv: number, code = 'shade_pattern.not_closed'): void {
  const m = I.length
  const fwd = new Float64Array(m), rev = new Float64Array(m)
  for (let t = 0; t < m; t += 3) for (let e = 0; e < 3; e++) {
    const a = I[t + e]!, b = I[t + ((e + 1) % 3)]!
    fwd[t + e] = a * nv + b; rev[t + e] = b * nv + a
  }
  fwd.sort(); rev.sort()
  let open = 0, bad = 0
  for (let i = 1; i < m; i++) if (fwd[i] === fwd[i - 1]) bad++
  let i = 0, j = 0
  while (i < m && j < m) { if (fwd[i] === rev[j]) { i++; j++ } else if (fwd[i]! < rev[j]!) { open++; i++ } else j++ }
  open += m - i
  if (open > 0 || bad > 0) throw problem(code, { open_edges: open, bad_edges: bad })
}


/** Vertices of edges and triangles that cross each other where at least one of them has an active vertex. */
export function crossingVertices(P: Float64Array, I: Uint32Array, active: Uint8Array): number[] {
  const nt = I.length / 3
  const moved = (t: number) => active[I[3 * t]!]! > 0 || active[I[3 * t + 1]!]! > 0 || active[I[3 * t + 2]!]! > 0
  let el = 0, cnt = 0
  for (let t = 0; t < nt; t++) if (moved(t)) { el += dist(P, I[3 * t]!, I[3 * t + 1]!); cnt++ }
  if (cnt === 0) return []
  const h = Math.max((el / cnt) * 2, 1e-4)
  const key = (x: number, y: number, z: number) => (x + 4096) + 8192 * ((y + 4096) + 8192 * (z + 4096))
  const range = (t: number) => {
    const r: number[] = []
    for (let a = 0; a < 3; a++) {
      const v0 = P[3 * I[3 * t]! + a]!, v1 = P[3 * I[3 * t + 1]! + a]!, v2 = P[3 * I[3 * t + 2]! + a]!
      r.push(Math.floor(Math.min(v0, v1, v2) / h), Math.floor(Math.max(v0, v1, v2) / h))
    }
    return r
  }
  const zone = new Map<number, number[]>()
  for (let t = 0; t < nt; t++) {
    if (!moved(t)) continue
    const r = range(t)
    for (let z = r[4]!; z <= r[5]!; z++) for (let y = r[2]!; y <= r[3]!; y++) for (let x = r[0]!; x <= r[1]!; x++) { const k = key(x, y, z); if (!zone.has(k)) zone.set(k, []) }
  }
  for (let t = 0; t < nt; t++) {
    const r = range(t)
    if (r[1]! - r[0]! > 64 || r[3]! - r[2]! > 64 || r[5]! - r[4]! > 64) continue    // a huge triangle cannot be near a moved part of a refined mesh
    for (let z = r[4]!; z <= r[5]!; z++) for (let y = r[2]!; y <= r[3]!; y++) for (let x = r[0]!; x <= r[1]!; x++) zone.get(key(x, y, z))?.push(t)
  }
  // bounding boxes: a pair is only tested when the boxes overlap, and only in the cell that holds the low corner of the
  // overlap (so a pair sharing several cells is tested once)
  const box = new Float64Array(nt * 6)
  for (let t = 0; t < nt; t++) for (let a = 0; a < 3; a++) {
    const v0 = P[3 * I[3 * t]! + a]!, v1 = P[3 * I[3 * t + 1]! + a]!, v2 = P[3 * I[3 * t + 2]! + a]!
    box[6 * t + a] = Math.min(v0, v1, v2); box[6 * t + 3 + a] = Math.max(v0, v1, v2)
  }
  const bad = new Set<number>()
  for (const [cell, list] of zone) {
    for (let i = 0; i < list.length; i++) {
      const t = list[i]!, mt = moved(t)
      for (let j = i + 1; j < list.length; j++) {
        const u = list[j]!
        if (!mt && !moved(u)) continue
        let overlap = true
        const c = [0, 0, 0]
        for (let a = 0; a < 3; a++) {
          const lo = Math.max(box[6 * t + a]!, box[6 * u + a]!), hi = Math.min(box[6 * t + 3 + a]!, box[6 * u + 3 + a]!)
          if (lo > hi) { overlap = false; break }
          c[a] = Math.floor(lo / h)
        }
        if (!overlap || key(c[0]!, c[1]!, c[2]!) !== cell) continue
        for (const [x, y] of [[t, u], [u, t]] as const) {
          const w0 = I[3 * y]!, w1 = I[3 * y + 1]!, w2 = I[3 * y + 2]!
          for (let e = 0; e < 3; e++) {
            const a = I[3 * x + e]!, b = I[3 * x + ((e + 1) % 3)]!
            if (w0 === a || w1 === a || w2 === a || w0 === b || w1 === b || w2 === b) continue
            if (segmentHitsTriangle(P, a, b, w0, w1, w2)) { bad.add(a); bad.add(b); bad.add(w0); bad.add(w1); bad.add(w2) }
          }
        }
      }
    }
  }
  return [...bad].sort((x, y) => x - y)
}

function segmentHitsTriangle(P: Float64Array, a: number, b: number, i0: number, i1: number, i2: number): boolean {
  const ax = P[3 * a]!, ay = P[3 * a + 1]!, az = P[3 * a + 2]!
  const dx = P[3 * b]! - ax, dy = P[3 * b + 1]! - ay, dz = P[3 * b + 2]! - az
  const px = P[3 * i0]!, py = P[3 * i0 + 1]!, pz = P[3 * i0 + 2]!
  const e1x = P[3 * i1]! - px, e1y = P[3 * i1 + 1]! - py, e1z = P[3 * i1 + 2]! - pz
  const e2x = P[3 * i2]! - px, e2y = P[3 * i2 + 1]! - py, e2z = P[3 * i2 + 2]! - pz
  const qx = dy * e2z - dz * e2y, qy = dz * e2x - dx * e2z, qz = dx * e2y - dy * e2x
  const det = e1x * qx + e1y * qy + e1z * qz
  if (Math.abs(det) < 1e-14) return false
  const inv = 1 / det
  const tx = ax - px, ty = ay - py, tz = az - pz
  const u = (tx * qx + ty * qy + tz * qz) * inv
  if (u <= 1e-9 || u >= 1 - 1e-9) return false
  const rx = ty * e1z - tz * e1y, ry = tz * e1x - tx * e1z, rz = tx * e1y - ty * e1x
  const v = (dx * rx + dy * ry + dz * rz) * inv
  if (v <= 1e-9 || u + v >= 1 - 1e-9) return false
  const s = (e2x * rx + e2y * ry + e2z * rz) * inv
  return s > 1e-9 && s < 1 - 1e-9
}

const dist = (P: Float64Array, a: number, b: number) => Math.hypot(P[3 * a]! - P[3 * b]!, P[3 * a + 1]! - P[3 * b + 1]!, P[3 * a + 2]! - P[3 * b + 2]!)
