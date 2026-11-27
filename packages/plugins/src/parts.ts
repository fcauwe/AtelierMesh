// Delete a part of the mesh, or keep only one: the part is a segment (a labelled set of triangles of a surface) or a group (a distinct body).
// What is removed is a filter on the triangles, so the order of what stays is kept and every group range stays contiguous.
// A removed SEGMENT leaves an opening in the surface; `closeHole: 'fill'` closes it with the repair plugin's hole filling (nothing else of that
// plugin is switched on). A removed GROUP leaves the other bodies as they were, closed solids, so nothing is closed.
import { MeshError, groupName, measureMesh, partList, selectPart } from '@ateliermesh/core'
import type { Mesh, MeshGroup, SegmentInfo } from '@ateliermesh/core'
import { repairMesh } from './repair'

export interface PartsOptions {
  /** The part, by name; `segment:name` or `group:name` when both kinds have that name. */
  part: string
  /** `delete`: remove that part. `keep`: remove everything else. */
  mode: 'delete' | 'keep'
  closeHole: 'none' | 'fill'
  /** Drop the vertices no triangle uses any more. */
  removeUnused: boolean
  signal?: AbortSignal
  onProgress?: (stage: string, fraction: number) => void
}

export interface PartsResult {
  mesh: Mesh
  /** What the part was: a segment or a group. */
  kind: 'segment' | 'group'
  name: string
  trianglesBefore: number
  trianglesAfter: number
  /** Triangles removed by the selection, before any cap was added. */
  removed: number
  closedBefore: boolean
  closedAfter: boolean
  /** Triangles added by closing the opening. */
  capTriangles: number
  /** Openings the hole filling left open (a cap that would cross itself or was too big). */
  capsSkipped: number
  /** Segment names that lost every triangle and left the table. */
  segmentsGone: string[]
  /** Group names that lost every triangle and left the list. */
  groupsGone: string[]
}

const cancelled = (o: PartsOptions): void => { if (o.signal?.aborted) throw new MeshError('run.cancelled') }

/** Which kind and name a `part` value means on this mesh (the same rules as `selectPart`, with both kinds allowed). */
function resolve(mesh: Mesh, value: string): { kind: 'segment' | 'group'; name: string } {
  const m = /^(segment|group):(.*)$/.exec(value)
  if (m) return { kind: m[1] as 'segment' | 'group', name: m[2] as string }
  const found = partList(mesh).filter(r => r.name === value)
  if (found.length === 1) return found[0] as { kind: 'segment' | 'group'; name: string }
  // the default segment `body` is not in the list but can still be named
  return { kind: 'segment', name: value }
}

export function removeParts(mesh: Mesh, o: PartsOptions): PartsResult {
  if (o.part === '') throw new MeshError('parts.nothing_chosen')
  const nt = mesh.indices.length / 3
  if (nt === 0) throw new MeshError('parts.bad_input', { reason: 'empty' })
  // groups must cover the mesh in order, like every operation that works per body
  const groups = mesh.groups
  if (groups && groups.length > 0) {
    let at = 0
    for (const g of groups) { if (g.start !== at || g.count < 0) throw new MeshError('parts.groups_unsupported'); at += g.count }
    if (at !== nt) throw new MeshError('parts.groups_unsupported')
  }
  const { kind, name } = resolve(mesh, o.part)
  // the default segment `body` is the whole surface: it is not offered as a part but can be named (to keep it, or to see the refusal for deleting it)
  const isBody = o.part === 'body' && !partList(mesh).some(r => r.name === 'body')
  const sel = selectPart(mesh, isBody ? 'segment:body' : o.part, ['group', 'segment'])   // part.unknown, part.ambiguous, segment.unknown, group.unknown
  if (!sel) throw new MeshError('parts.nothing_chosen')
  cancelled(o); o.onProgress?.('parts', 0.1)

  const keep = new Uint8Array(nt)
  let kept = 0, removed = 0
  for (let t = 0; t < nt; t++) {
    const k = o.mode === 'delete' ? (sel[t] ? 0 : 1) : (sel[t] ? 1 : 0)
    keep[t] = k
    if (k) kept++; else removed++
  }
  if (kept === 0) throw new MeshError('parts.would_remove_everything', { part: name, mode: o.mode })
  const before = measureMesh(mesh)
  const closedBefore = before.watertight

  // nothing to remove: the same mesh
  if (removed === 0) {
    return { mesh, kind, name, trianglesBefore: nt, trianglesAfter: nt, removed: 0, closedBefore, closedAfter: closedBefore, capTriangles: 0, capsSkipped: 0, segmentsGone: [], groupsGone: [] }
  }

  // the triangles that stay, in their order
  const nv = mesh.positions.length / 3
  const remap = new Int32Array(nv).fill(-1)
  const idx = new Uint32Array(3 * kept)
  const pos: number[] = []
  let o3 = 0, nvNew = 0
  if (!o.removeUnused) { for (let v = 0; v < nv; v++) remap[v] = v; nvNew = nv }
  for (let t = 0; t < nt; t++) {
    if (!keep[t]) continue
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[3 * t + k] as number
      let r = remap[v] as number
      if (r < 0) { r = nvNew++; remap[v] = r; pos.push(mesh.positions[3 * v] as number, mesh.positions[3 * v + 1] as number, mesh.positions[3 * v + 2] as number) }
      idx[o3++] = r
    }
  }
  const positions = o.removeUnused ? Float64Array.from(pos) : mesh.positions
  cancelled(o); o.onProgress?.('parts', 0.4)

  // segments: the labels follow their triangles; an entry that lost every triangle leaves the table (the others keep their ids)
  let out: Mesh = { positions, indices: idx }
  const segmentsGone: string[] = []
  if (mesh.segments) {
    const labels = new Uint16Array(kept)
    const usedBefore = new Set<number>(), usedAfter = new Set<number>()
    let j = 0
    for (let t = 0; t < nt; t++) { const l = mesh.segments.labels[t] as number; usedBefore.add(l); if (keep[t]) { labels[j++] = l; usedAfter.add(l) } }
    const table: SegmentInfo[] = []
    for (const s of mesh.segments.table) {
      if (usedBefore.has(s.id) && !usedAfter.has(s.id)) segmentsGone.push(s.name)
      else table.push({ ...s })
    }
    out.segments = { labels, table }
  }
  // groups: the same bodies in the same order, with the ranges of what stays; a body that lost everything leaves the list
  const groupsGone: string[] = []
  if (groups && groups.length > 0) {
    const ng: MeshGroup[] = []
    let start = 0
    groups.forEach((g, gi) => {
      let c = 0
      for (let t = g.start; t < g.start + g.count; t++) c += keep[t] as number
      if (c === 0) { groupsGone.push(groupName(g, gi)); return }
      ng.push({ ...g, start, count: c }); start += c
    })
    out.groups = ng
  }
  cancelled(o)

  // closing the opening that a removed (or, when keeping, a surrounding) segment leaves; whole bodies leave none
  let capTriangles = 0, capsSkipped = 0
  const needsCap = o.closeHole === 'fill' && kind === 'segment'
  if (needsCap) {
    o.onProgress?.('holes', 0.6)
    const r = repairMesh(out, { weld: 0, nonManifold: 'off', fixNormals: false, minIsland: 0, maxHole: 100000, ...(o.signal ? { signal: o.signal } : {}), onProgress: (_s, f) => o.onProgress?.('holes', 0.6 + 0.35 * f) })
    capTriangles = r.did.holeTriangles
    capsSkipped = r.did.holesTooBig + r.did.holesSkipped
    out = r.mesh
  }
  o.onProgress?.('parts', 1)
  const after = measureMesh(out)
  return { mesh: out, kind, name, trianglesBefore: nt, trianglesAfter: out.indices.length / 3, removed, closedBefore, closedAfter: after.watertight, capTriangles, capsSkipped, segmentsGone, groupsGone }
}

