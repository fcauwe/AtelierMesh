// The check report for a mesh: what a person or a server needs to decide whether it can be used.
import { measureMesh } from './measure'
import type { Measurements } from './measure'
import { checkSegments, segmentTable } from './segments'
import type { Mesh } from './types'
import { unitHint } from './units'
import type { UnitHint } from './units'

export interface MeshReport extends Measurements {
  /** Connected pieces (triangles that share a vertex). */
  shells: number
  /** Triangles with zero area. */
  zeroAreaTriangles: number
  unitHint: UnitHint
  segments: Array<{ name: string; triangles: number }>
  /** Plain-language codes of problems found, for the host to localise. Empty means nothing to report. */
  issues: Array<'not_watertight' | 'non_manifold' | 'bad_orientation' | 'negative_volume' | 'zero_area_triangles' | 'many_shells' | 'unit_suspect' | 'bad_segments'>
}

export function meshReport(mesh: Mesh): MeshReport {
  const m = measureMesh(mesh)
  const nv = m.vertices
  const parent = new Int32Array(nv).map((_, i) => i)
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a] as number] as number; a = parent[a] as number } return a }
  const T = mesh.indices, P = mesh.positions
  let zero = 0
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t] as number, b = T[t + 1] as number, c = T[t + 2] as number
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent[rb] = ra
    const rc = find(c), rr = find(a)
    if (rc !== rr) parent[rc] = rr
    const ux = (P[3 * b] as number) - (P[3 * a] as number), uy = (P[3 * b + 1] as number) - (P[3 * a + 1] as number), uz = (P[3 * b + 2] as number) - (P[3 * a + 2] as number)
    const vx = (P[3 * c] as number) - (P[3 * a] as number), vy = (P[3 * c + 1] as number) - (P[3 * a + 1] as number), vz = (P[3 * c + 2] as number) - (P[3 * a + 2] as number)
    if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) === 0) zero++
  }
  const roots = new Set<number>()
  const used = new Uint8Array(nv)
  for (let i = 0; i < T.length; i++) used[T[i] as number] = 1
  for (let v = 0; v < nv; v++) if (used[v]) roots.add(find(v))
  const hint = unitHint(mesh)
  const counts = new Map<number, number>()
  if (mesh.segments) for (let t = 0; t < mesh.segments.labels.length; t++) { const l = mesh.segments.labels[t] as number; counts.set(l, (counts.get(l) ?? 0) + 1) }
  else counts.set(0, m.triangles)
  const segments = segmentTable(mesh).map(s => ({ name: s.name, triangles: counts.get(s.id) ?? 0 })).filter(s => s.triangles > 0)
  const issues: MeshReport['issues'] = []
  if (m.boundaryEdges > 0) issues.push('not_watertight')
  if (m.nonManifoldEdges > 0) issues.push('non_manifold')
  if (m.badOrientationEdges > 0) issues.push('bad_orientation')
  if (m.watertight && m.volume < 0) issues.push('negative_volume')
  if (zero > 0) issues.push('zero_area_triangles')
  if (roots.size > 1) issues.push('many_shells')
  if (hint.suspect) issues.push('unit_suspect')
  if (checkSegments(mesh).length > 0) issues.push('bad_segments')
  return { ...m, shells: roots.size, zeroAreaTriangles: zero, unitHint: hint, segments, issues }
}
