// Segments: named sets of triangles of one surface (SPEC.md section 5.1). Pure helpers; they never change their input.
import { MeshError } from './errors'
import type { Mesh, MeshSegments, SegmentInfo } from './types'

export const DEFAULT_SEGMENT = 'body'

export function triangleCount(mesh: Mesh): number {
  return mesh.indices.length / 3
}

/** The segments of a mesh; a mesh without any has one segment, `body`, holding every triangle. */
export function segmentTable(mesh: Mesh): SegmentInfo[] {
  return mesh.segments ? mesh.segments.table : [{ id: 0, name: DEFAULT_SEGMENT }]
}

export function hasSegment(mesh: Mesh, name: string): boolean {
  return segmentTable(mesh).some(s => s.name === name)
}

/** The label of a segment, or an error `segment.unknown`. */
export function segmentId(mesh: Mesh, name: string): number {
  const s = segmentTable(mesh).find(x => x.name === name)
  if (!s) throw new MeshError('segment.unknown', { name, known: segmentTable(mesh).map(x => x.name) })
  return s.id
}

/**
 * Which triangles an operation should touch. An empty name means all of them. Returns `null` for "all"
 * (so a caller can skip the test), otherwise a Uint8Array flag per triangle.
 */
export function selectTriangles(mesh: Mesh, name: string): Uint8Array | null {
  if (name === '') return null
  const id = segmentId(mesh, name)
  const n = triangleCount(mesh)
  const out = new Uint8Array(n)
  if (!mesh.segments) { out.fill(1); return out }
  const l = mesh.segments.labels
  for (let t = 0; t < n; t++) if (l[t] === id) out[t] = 1
  return out
}

/** Vertices used by both a selected and a non-selected triangle: the border of the segment. */
export function borderVertices(mesh: Mesh, selected: Uint8Array): Uint8Array {
  const nv = mesh.positions.length / 3
  const inSel = new Uint8Array(nv), inRest = new Uint8Array(nv)
  const T = mesh.indices
  for (let t = 0; t < selected.length; t++) {
    const flag = selected[t] ? inSel : inRest
    flag[T[3 * t] as number] = 1; flag[T[3 * t + 1] as number] = 1; flag[T[3 * t + 2] as number] = 1
  }
  const out = new Uint8Array(nv)
  for (let v = 0; v < nv; v++) if (inSel[v] && inRest[v]) out[v] = 1
  return out
}

const NAME_RE = /^[a-z][a-z0-9_]*$/

/**
 * Label the triangles flagged in `flags` as segment `name` (a new label, or the label of an existing segment of that name,
 * which it replaces). Returns a new mesh sharing positions and indices.
 */
export function assignSegment(mesh: Mesh, name: string, flags: Uint8Array, color?: string): Mesh {
  if (!NAME_RE.test(name) || name.length > 40) throw new MeshError('segment.invalid_name', { name })
  if (color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new MeshError('segment.bad_color', { segment: name, color: String(color).slice(0, 40) })
  const n = triangleCount(mesh)
  if (flags.length !== n) throw new MeshError('segment.invalid', { reason: 'flags_length', expected: n, got: flags.length })
  const table = segmentTable(mesh).map(s => ({ ...s }))
  let info = table.find(s => s.name === name)
  if (!info) { info = { id: nextId(table), name, ...(color ? { color } : {}) }; table.push(info) } else if (color) info.color = color
  const labels = mesh.segments ? mesh.segments.labels.slice() : new Uint16Array(n)
  for (let t = 0; t < n; t++) if (flags[t]) labels[t] = info.id
  return { ...mesh, segments: pruneSegments({ labels, table }) }
}

function nextId(table: SegmentInfo[]): number {
  let id = 0
  for (const s of table) if (s.id >= id) id = s.id + 1
  if (id > 65535) throw new MeshError('segment.invalid', { reason: 'too_many_segments' })
  return id
}

/** Drop table entries no triangle uses, except the default segment `body` (id 0). */
export function pruneSegments(seg: MeshSegments): MeshSegments {
  const used = new Set<number>([0])
  for (let t = 0; t < seg.labels.length; t++) used.add(seg.labels[t] as number)
  const table = seg.table.filter(s => used.has(s.id))
  if (!table.some(s => s.id === 0)) table.unshift({ id: 0, name: DEFAULT_SEGMENT })
  return { labels: seg.labels, table }
}

/**
 * For an operation that builds a new triangle list from the old one: give each new triangle the label of its parent.
 * `parent[t]` is the index of the old triangle that new triangle `t` came from.
 */
export function carrySegments(old: Mesh, parent: ArrayLike<number>): MeshSegments | undefined {
  if (!old.segments) return undefined
  const labels = new Uint16Array(parent.length)
  for (let t = 0; t < parent.length; t++) labels[t] = old.segments.labels[parent[t] as number] as number
  return pruneSegments({ labels, table: old.segments.table })
}

/** Check that a mesh's segments are well formed. Returns the problems found; empty means valid. */
export function checkSegments(mesh: Mesh): string[] {
  const s = mesh.segments
  if (!s) return []
  const problems: string[] = []
  if (s.labels.length !== triangleCount(mesh)) problems.push(`labels has ${s.labels.length} entries for ${triangleCount(mesh)} triangles`)
  const ids = new Set<number>(), names = new Set<string>()
  for (const e of s.table) {
    if (ids.has(e.id)) problems.push(`duplicate id ${e.id}`); ids.add(e.id)
    if (names.has(e.name)) problems.push(`duplicate name ${e.name}`); names.add(e.name)
    if (!NAME_RE.test(e.name)) problems.push(`bad name ${e.name}`)
  }
  if (!ids.has(0)) problems.push('no default segment (id 0)')
  for (let t = 0; t < s.labels.length; t++) if (!ids.has(s.labels[t] as number)) { problems.push(`triangle ${t} has unknown label ${s.labels[t]}`); break }
  return problems
}
