// Smooth shading for the viewer: one normal per triangle corner, the angle-weighted mean of the faces around that vertex whose direction is
// within `creaseDeg` of the corner's own face. Curved surfaces then look smooth; edges sharper than the angle (a box's corners, the rim of a hole) stay crisp.
// Works on an indexed, welded mesh (the engine's meshes are); on a triangle soup nothing is shared, so it stays flat. Pure function, no three.js.

/** Normals (x, y, z per corner, three corners per triangle) in the mesh's own coordinates. */
export function creaseNormals(positions: ArrayLike<number>, indices: ArrayLike<number>, creaseDeg = 35, triangles?: ArrayLike<number>): Float32Array {
  const nt = indices.length / 3
  const nv = positions.length / 3
  const face = new Float32Array(nt * 3)           // unit face normals
  const ang = new Float32Array(nt * 3)            // corner angles
  const P = (v: number): [number, number, number] => [positions[3 * v] as number, positions[3 * v + 1] as number, positions[3 * v + 2] as number]
  for (let t = 0; t < nt; t++) {
    const a = P(indices[3 * t] as number), b = P(indices[3 * t + 1] as number), c = P(indices[3 * t + 2] as number)
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz) || 1
    nx /= l; ny /= l; nz /= l
    face[3 * t] = nx; face[3 * t + 1] = ny; face[3 * t + 2] = nz
    const corner = (p: number[], q: number[], r: number[]): number => {
      const ex = q[0]! - p[0]!, ey = q[1]! - p[1]!, ez = q[2]! - p[2]!, fx = r[0]! - p[0]!, fy = r[1]! - p[1]!, fz = r[2]! - p[2]!
      const d = (ex * fx + ey * fy + ez * fz) / ((Math.hypot(ex, ey, ez) * Math.hypot(fx, fy, fz)) || 1)
      return Math.acos(Math.max(-1, Math.min(1, d)))
    }
    ang[3 * t] = corner(a, b, c); ang[3 * t + 1] = corner(b, c, a); ang[3 * t + 2] = corner(c, a, b)
  }
  // faces around each vertex (compressed rows)
  const start = new Uint32Array(nv + 1)
  for (let i = 0; i < indices.length; i++) start[(indices[i] as number) + 1]!++
  for (let v = 0; v < nv; v++) start[v + 1]! += start[v]!
  const fill = start.slice(0, nv)
  const around = new Uint32Array(indices.length)
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) { const v = indices[3 * t + k] as number; around[fill[v]!++] = 3 * t + k }
  const cosC = Math.cos((creaseDeg * Math.PI) / 180)
  const list = triangles ? Array.from(triangles as ArrayLike<number>) : null
  const n = list ? list.length : nt
  const out = new Float32Array(n * 9)
  for (let i = 0; i < n; i++) {
    const t = list ? (list[i] as number) : i
    const fx = face[3 * t]!, fy = face[3 * t + 1]!, fz = face[3 * t + 2]!
    for (let k = 0; k < 3; k++) {
      const v = indices[3 * t + k] as number
      let sx = 0, sy = 0, sz = 0
      for (let r = start[v]!; r < start[v + 1]!; r++) {
        const corner = around[r]!, f = (corner / 3) | 0
        const gx = face[3 * f]!, gy = face[3 * f + 1]!, gz = face[3 * f + 2]!
        if (fx * gx + fy * gy + fz * gz < cosC) continue
        const w = ang[corner]!
        sx += gx * w; sy += gy * w; sz += gz * w
      }
      const l = Math.hypot(sx, sy, sz)
      const o = 9 * i + 3 * k
      if (l > 0) { out[o] = sx / l; out[o + 1] = sy / l; out[o + 2] = sz / l } else { out[o] = fx; out[o + 1] = fy; out[o + 2] = fz }
    }
  }
  return out
}
