// Groups are the distinct parts (bodies) of a mesh: contiguous ranges of triangles, each with a role and, usually, a name.
// A step can be limited to one of them with a `group` parameter, the way a `segment` parameter limits it to a labelled part of a surface.
import { MeshError } from './errors'
import type { Mesh, MeshGroup } from './types'

/** The name a group is known by: its own, or `part_1`, `part_2`, ... by position when it has none. */
export const groupName = (g: MeshGroup, index: number): string => g.name ?? `part_${index + 1}`

export const groupNames = (mesh: Mesh): string[] => (mesh.groups ?? []).map(groupName)

/** The triangle range of a group by name, or an error `group.unknown`. */
export function groupRange(mesh: Mesh, name: string): { start: number; count: number; role: MeshGroup['role'] } {
  const groups = mesh.groups ?? []
  const i = groups.findIndex((g, k) => groupName(g, k) === name)
  if (i < 0) throw new MeshError('group.unknown', { name, known: groupNames(mesh) })
  const g = groups[i] as MeshGroup
  return { start: g.start, count: g.count, role: g.role }
}

/** Which triangles a step should touch. An empty name means all of them (`null`); otherwise a flag per triangle. */
export function selectGroupTriangles(mesh: Mesh, name: string): Uint8Array | null {
  if (name === '') return null
  const r = groupRange(mesh, name)
  const out = new Uint8Array(mesh.indices.length / 3)
  out.fill(1, r.start, r.start + r.count)
  return out
}
