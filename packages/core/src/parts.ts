// A "part" of the mesh is either a segment (a labelled set of triangles of a surface) or a group (a distinct body). One parameter type,
// `part`, chooses either, by name. A name that exists as both is ambiguous; the value then carries a prefix, `segment:lid` or `group:lid`.
import { MeshError } from './errors'
import { groupNames, selectGroupTriangles } from './groups'
import { segmentTable, selectTriangles } from './segments'
import type { Mesh } from './types'

export type PartKind = 'segment' | 'group'
export interface PartRef { kind: PartKind; name: string }
const BOTH: PartKind[] = ['segment', 'group']

/** Every part the mesh has, of the kinds asked for. The default segment `body` is the whole surface, not a part, and is left out. */
export function partList(mesh: Mesh, kinds: PartKind[] = BOTH): PartRef[] {
  return [
    ...(kinds.includes('segment') ? segmentTable(mesh).filter(s => s.id !== 0).map(s => ({ kind: 'segment' as const, name: s.name })) : []),
    ...(kinds.includes('group') ? groupNames(mesh).map(name => ({ kind: 'group' as const, name })) : []),
  ]
}

/** The text a `part` parameter stores for a choice: the plain name, or with a prefix when the other kind has the same name. */
export function partValue(mesh: Mesh, ref: PartRef): string {
  const other = partList(mesh).some(r => r.name === ref.name && r.kind !== ref.kind)
  return other ? `${ref.kind}:${ref.name}` : ref.name
}

/**
 * Which triangles a step should touch. An empty value means all of them (`null`); otherwise a flag per triangle.
 * Errors: `segment.unknown` or `group.unknown` when only one kind is allowed, `part.unknown` or `part.ambiguous` when both are.
 */
export function selectPart(mesh: Mesh, value: string, kinds: PartKind[] = BOTH): Uint8Array | null {
  if (value === '') return null
  const m = /^(segment|group):(.*)$/.exec(value)
  const kind = m ? (m[1] as PartKind) : kinds.length === 1 ? (kinds[0] as PartKind) : undefined
  const name = m ? (m[2] as string) : value
  if (kind && !kinds.includes(kind)) throw new MeshError(kind === 'segment' ? 'segment.unknown' : 'group.unknown', { name })
  if (kind === 'segment') return selectTriangles(mesh, name)
  if (kind === 'group') return selectGroupTriangles(mesh, name)
  const found = partList(mesh, kinds).filter(r => r.name === name)
  // the default surface ("body", every triangle no segment was given) is not in the list of named parts but can be chosen
  if (found.length === 0 && kinds.includes('segment') && segmentTable(mesh).some(x => x.name === name)) return selectTriangles(mesh, name)
  if (found.length === 0) throw new MeshError('part.unknown', { name, known: partList(mesh, kinds).map(r => r.name) })
  if (found.length > 1) throw new MeshError('part.ambiguous', { name, kinds: found.map(r => r.kind) })
  return found[0]!.kind === 'segment' ? selectTriangles(mesh, name) : selectGroupTriangles(mesh, name)
}
