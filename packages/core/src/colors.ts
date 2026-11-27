// Colour on parts. Every part of a mesh, a segment (a coloured region) or a group (a body), can carry a colour (#rrggbb). The mesh itself has no textures,
// UV coordinates or per-vertex colours: colour lives on parts. A plugin may keep the colours it gets, give new parts a colour, or colour its output
// by a rule (height, face direction ...). Colours appear in the 3D view and in a 3MF export (docs/3mf-colour.md).
import { MeshError } from './errors'
import { groupName } from './groups'
import { segmentTable } from './segments'
import type { Mesh, MeshGroup, SegmentInfo } from './types'

export const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

/** Is this a colour a part may carry: `#` and six hex digits, no alpha? */
export const isColor = (c: unknown): c is string => typeof c === 'string' && COLOR_PATTERN.test(c)

function checkColor(color: unknown, where: Record<string, unknown>): string {
  if (!isColor(color)) throw new MeshError('segment.bad_color', { ...where, color: typeof color === 'string' ? color.slice(0, 40) : null })
  return color.toLowerCase()
}

/** The first colour on a part that is not `#rrggbb`, as a short text, or null. Cheap: it reads the segment table and the group list only. */
export function meshColourProblem(mesh: Mesh): string | null {
  for (const s of mesh.segments?.table ?? []) if (s.color !== undefined && !isColor(s.color)) return `segment "${s.name}" has a colour that is not #rrggbb`
  for (const [i, g] of (mesh.groups ?? []).entries()) if (g.color !== undefined && !isColor(g.color)) return `group "${groupName(g, i)}" has a colour that is not #rrggbb`
  return null
}

/** The colour of a segment, or undefined (the default segment `body` can carry one too: the colour of every triangle no segment was given to). */
export const segmentColor = (mesh: Mesh, name: string): string | undefined => segmentTable(mesh).find(s => s.name === name)?.color

/** The colour of a group (a body) by name, or undefined. */
export const groupColor = (mesh: Mesh, name: string): string | undefined => (mesh.groups ?? []).find((g, i) => groupName(g, i) === name)?.color

/** A new mesh in which the group `name` carries `color` (`#rrggbb`). Triangles, other groups and segments are shared. Error `group.unknown`. */
export function setGroupColor(mesh: Mesh, name: string, color: string): Mesh {
  const c = checkColor(color, { group: name })
  const groups = mesh.groups ?? []
  const i = groups.findIndex((g, k) => groupName(g, k) === name)
  if (i < 0) throw new MeshError('group.unknown', { name, known: groups.map(groupName) })
  return { ...mesh, groups: groups.map((g, k): MeshGroup => (k === i ? { ...g, color: c } : g)) }
}

/**
 * A new mesh in which the segments named in `colors` carry the given colour (`name -> #rrggbb`). The default segment is called `body` and can be coloured too.
 * A name the mesh has no segment of is an error `segment.unknown`; to colour a region that does not exist yet, label it with `assignSegment(mesh, name, flags, color)`.
 */
export function colorSegments(mesh: Mesh, colors: Record<string, string>): Mesh {
  const table: SegmentInfo[] = segmentTable(mesh).map(s => ({ ...s }))
  for (const [name, color] of Object.entries(colors)) {
    const c = checkColor(color, { segment: name })
    const info = table.find(s => s.name === name)
    if (!info) throw new MeshError('segment.unknown', { name, known: table.map(s => s.name) })
    info.color = c
  }
  const labels = mesh.segments ? mesh.segments.labels : new Uint16Array(mesh.indices.length / 3)
  return { ...mesh, segments: { labels, table } }
}

/** `colorSegments` for one segment. */
export const setSegmentColor = (mesh: Mesh, name: string, color: string): Mesh => colorSegments(mesh, { [name]: color })


/** The same mesh with no colour on any segment or body: geometry only (one filament). Parts and names stay. */
export function stripColours(mesh: Mesh): Mesh {
  const groups = mesh.groups?.map(g => { const { color: _c, ...rest } = g; return rest as typeof g })
  const segments = mesh.segments ? { ...mesh.segments, table: mesh.segments.table.map(s => { const { color: _c, ...rest } = s; return rest as typeof s }) } : undefined
  return { ...mesh, ...(groups ? { groups } : {}), ...(segments ? { segments } : {}) }
}
