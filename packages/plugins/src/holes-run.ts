// The code of `org.ateliermesh.holes`. Loaded on first use (see holes-plugin.ts).
import { MeshError, buildBvh, measureMesh, readingFrame, selectPart } from '@ateliermesh/core'
import type { Mesh, PluginModule, RunContext, StructuredError } from '@ateliermesh/core'
import { HoleFailure, crossSection, cutOnce, nudged } from './holes'
import type { CutInput, Cutter, CutOutput } from './holes'

type V3 = [number, number, number]
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s]
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l] }
const round = (x: number, n = 100): number => Math.round(x * n) / n

/** How far above the clicked point the cutter starts, at least. */
const MARGIN = 0.5

/** The number of sides of a round cutter: the chord stays within `tol` of the circle. */
function sides(r: number, tol: number): number {
  const a = Math.acos(Math.max(-1, Math.min(1, 1 - tol / Math.max(r, tol * 2))))
  return Math.max(48, Math.min(192, Math.ceil(Math.PI / Math.max(a, 1e-3))))
}

function cutHoleOp(ctx: RunContext) {
  const mesh = ctx.mesh
  if (!mesh) throw new MeshError('input.missing_mesh', { op: 'cut_hole' })
  const p = ctx.params
  const placement = p['placement'] as { anchor: { point: number[]; normal: number[] }; up_ref?: 'x' | 'y' | 'z'; direction?: number; offset?: [number, number] } | null
  if (!placement) throw new MeshError('holes.no_placement')
  if (mesh.groups && mesh.groups.length > 1) throw new MeshError('holes.groups_unsupported', { groups: mesh.groups.length })
  const before = measureMesh(mesh)
  if (!before.watertight) throw new MeshError('holes.bad_input', { reason: 'not_closed' })
  const warnings: StructuredError[] = []

  // ---- where the hole goes, and which way
  const outward = norm(placement.anchor.normal as V3)
  const axisParam = p['axis'] as string
  let axis: V3 = mul(outward, -1)
  if (axisParam === 'x' || axisParam === 'y' || axisParam === 'z') {
    const e: V3 = axisParam === 'x' ? [1, 0, 0] : axisParam === 'y' ? [0, 1, 0] : [0, 0, 1]
    axis = dot(e, axis) >= 0 ? e : mul(e, -1)
  }
  const upRef: V3 = placement.up_ref === 'x' ? [1, 0, 0] : placement.up_ref === 'y' ? [0, 1, 0] : [0, 0, 1]
  const fr = readingFrame(mul(axis, -1), upRef, placement.direction ?? 0)
  const rot = ((p['rotation'] as number) * Math.PI) / 180
  const e1 = add(mul(fr.ex, Math.cos(rot)), mul(fr.ey, Math.sin(rot)))
  const e2 = add(mul(fr.ex, -Math.sin(rot)), mul(fr.ey, Math.cos(rot)))
  const off = placement.offset ?? [0, 0]
  const origin = add(add(placement.anchor.point as V3, mul(fr.ex, off[0])), mul(fr.ey, off[1]))

  // ---- the shape
  const shape = p['shape'] as 'round' | 'slot' | 'square'
  const width = p['diameter'] as number
  const tol = ctx.quality === 'preview' ? 0.02 : 0.01
  const n = sides(width / 2, tol)
  const section = crossSection(shape, width, p['length'] as number, p['corner_radius'] as number, n)
  let rMax = 0
  for (const [x, y] of section) rMax = Math.max(rMax, Math.hypot(x, y))

  // how far along the axis the model reaches: the cutter starts above everything in its column and ends where the hole ends
  let zLo = -MARGIN, zHi = -Infinity
  const P = mesh.positions
  for (let i = 0; i < P.length; i += 3) {
    const d: V3 = [P[i]! - origin[0], P[i + 1]! - origin[1], P[i + 2]! - origin[2]]
    const z = dot(d, axis)
    if (z > zHi) zHi = z
    if (z < zLo && Math.hypot(d[0], d[1], d[2]) ** 2 - z * z <= rMax * rMax * 1.5) zLo = z - 0.05
  }
  const depth = p['depth'] as number
  const through = !(depth > 0)
  const zEnd = through ? zHi + MARGIN : depth

  const cutters: Cutter[] = [{ origin, axis, e1, e2, section, zTop: zLo, scaleTop: 1, zBottom: zEnd, scaleBottom: 1 }]
  // a wider opening at the top for a screw head; it is cut after the hole itself, and goes a little deeper than where it meets the hole
  const mode = p['countersink'] as string
  if (mode !== 'none') {
    const csd = Math.max(width + 0.2, p['countersink_diameter'] as number)
    const r0 = width / 2
    if (mode === 'countersink') {
      const slope = (csd - width) / 2          // 90 degrees: one millimetre in for every millimetre down
      const zb = Math.min(zEnd, slope) + 0.3
      cutters.push({ origin, axis, e1, e2, section, zTop: zLo, scaleTop: (csd / 2 - zLo) / r0, zBottom: zb, scaleBottom: Math.max(0.05, (csd / 2 - zb) / r0) })
    } else {
      const zb = Math.min(zEnd, p['countersink_depth'] as number)
      cutters.push({ origin, axis, e1, e2, section, zTop: zLo, scaleTop: csd / width, zBottom: zb, scaleBottom: csd / width })
    }
  }

  // ---- which triangles the hole may open
  const part = (p['part'] as string | undefined) ?? ''
  const sel = part === '' ? null : selectPart(mesh, part, ['segment', 'group'])
  let cur: CutInput = { positions: mesh.positions, indices: mesh.indices, ...(mesh.segments ? { labels: mesh.segments.labels } : {}), ...(sel ? { flags: sel } : {}) }
  let attempts = 0, cutMs = 0, stitchMs = 0, cutTri = 0, bottomWall = false
  ctx.progress('hole_cut', 0)
  cutters.forEach((c, k) => {
    let done: CutOutput | null = null
    for (let a = 0; a < 5 && !done; a++) {
      attempts++
      try {
        const r = cutOnce(cur, nudged(c, a), { signal: ctx.signal, onProgress: f => ctx.progress('hole_cut', (k + f) / cutters.length) })
        if (measureMesh({ positions: r.positions, indices: r.indices }).watertight) done = r
      } catch (e) {
        if (e instanceof HoleFailure) {
          if (e.reason === 'misses_model') { if (k === 0) throw new MeshError('holes.misses_model'); return }
          if (e.reason === 'breach') throw new MeshError('holes.breaches', { part })
          if (e.reason === 'too_big') throw new MeshError('holes.too_big')
          if (e.reason === 'too_heavy') throw new MeshError('holes.too_heavy', { triangles: cur.indices.length / 3 })
          continue                              // a case the exact cut could not build: nudge the cutter a little and try again
        }
        throw e
      }
    }
    if (!done) throw new MeshError('holes.not_robust')
    if (k === 0) bottomWall = done.stats.bottomWall
    cutMs += done.stats.ms.cut; stitchMs += done.stats.ms.stitch; cutTri += done.stats.cutTriangles.length
    cur = { positions: done.positions, indices: done.indices, ...(done.labels ? { labels: done.labels } : {}), ...(done.flags ? { flags: done.flags } : {}) }
  })
  ctx.progress('hole_wall', 1)
  const out: Mesh = { positions: cur.positions, indices: cur.indices }
  if (mesh.segments && cur.labels) out.segments = { labels: cur.labels, table: mesh.segments.table }
  if (mesh.groups && mesh.groups.length === 1) out.groups = [{ ...mesh.groups[0]!, start: 0, count: cur.indices.length / 3 }]

  // ---- the wall left under the bottom of a blind hole
  let wall: number | null = null
  const minWall = p['min_wall'] as number
  if (!through && bottomWall) {
    const bvh = buildBvh(mesh)
    const samples: V3[] = [origin]
    for (let k = 0; k < 8; k++) { const a = (2 * Math.PI * k) / 8, r = 0.6 * (width / 2); samples.push(add(origin, add(mul(e1, r * Math.cos(a)), mul(e2, r * Math.sin(a))))) }
    wall = Infinity
    for (const s of samples) {
      const o = add(s, mul(axis, zEnd))
      const hit = bvh.raycast(o, axis)
      if (hit) wall = Math.min(wall, hit.distance)
    }
    if (!Number.isFinite(wall)) wall = null
    else if (wall < minWall) warnings.push({ code: 'holes.thin_wall', params: { width: round(wall), min: minWall, depth } })
  }
  const after = measureMesh(out)
  return {
    mesh: out, warnings,
    report: {
      shape, diameter: width, depth: through ? 0 : depth, through: through || !bottomWall, countersink: mode,
      cut_triangles: cutTri, triangles_before: mesh.indices.length / 3, triangles: out.indices.length / 3,
      volume_before: round(before.volume), volume_after: round(after.volume), volume_removed: round(before.volume - after.volume),
      wall_under_bottom: wall === null ? null : round(wall), closed: after.watertight, attempts, timing_ms: { cut: round(cutMs, 10), stitch: round(stitchMs, 10) },
    },
  }
}

const module_: PluginModule = {
  async run(op: string, ctx: RunContext) {
    switch (op) {
      case 'cut_hole': return cutHoleOp(ctx)
      default: throw new MeshError('step.unknown_op', { op })
    }
  },
}

export default module_
