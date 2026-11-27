// The mirror operation as a plain function: easy to test without an engine, and the module in main.ts only wraps it.
import { MeshError } from '@ateliermesh/core'
import type { Mesh, MeshGroup } from '@ateliermesh/core'

export interface MirrorParams { axis: 'x' | 'y' | 'z'; mode: 'flip' | 'copy'; gap: number }
const AXIS = { x: 0, y: 1, z: 2 } as const

export function mirror(mesh: Mesh, p: MirrorParams, isCancelled: () => boolean = () => false): { mesh: Mesh; report: Record<string, unknown> } {
  const nv = mesh.positions.length / 3, nt = mesh.indices.length / 3
  if (nt === 0) throw new MeshError('mirror.empty')               // an expected problem: a MeshError with a code, never a bare Error
  const a = AXIS[p.axis]
  let lo = Infinity, hi = -Infinity
  for (let i = a; i < mesh.positions.length; i += 3) { const v = mesh.positions[i] as number; if (v < lo) lo = v; if (v > hi) hi = v }
  if (isCancelled()) throw new MeshError('run.cancelled')

  // flip: mirror in place (the bounding box stays where it is). copy: add a mirrored copy `gap` mm beyond the far end.
  const plane = p.mode === 'flip' ? lo + hi : 2 * hi + p.gap
  const copies = p.mode === 'flip' ? 1 : 2
  const positions = new Float64Array(mesh.positions.length * copies)
  const indices = new Uint32Array(mesh.indices.length * copies)
  const base = p.mode === 'flip' ? 0 : 1                           // the mirrored triangles start at this copy
  if (p.mode === 'copy') { positions.set(mesh.positions); indices.set(mesh.indices) }
  const po = base * mesh.positions.length, io = base * mesh.indices.length
  for (let i = 0; i < mesh.positions.length; i++) positions[po + i] = i % 3 === a ? plane - (mesh.positions[i] as number) : (mesh.positions[i] as number)
  // a mirror image turns every triangle inside out: swap two corners so it faces outwards again (counter-clockwise from outside)
  for (let t = 0; t < nt; t++) {
    indices[io + 3 * t] = (mesh.indices[3 * t] as number) + base * nv
    indices[io + 3 * t + 1] = (mesh.indices[3 * t + 2] as number) + base * nv
    indices[io + 3 * t + 2] = (mesh.indices[3 * t + 1] as number) + base * nv
  }
  const out: Mesh = { positions, indices }

  // carry the labels through: segments follow their triangles, groups (bodies) follow their ranges
  if (mesh.segments) {
    const labels = new Uint16Array(nt * copies)
    if (p.mode === 'copy') labels.set(mesh.segments.labels)
    labels.set(mesh.segments.labels, base * nt)
    out.segments = { labels, table: mesh.segments.table.map(s => ({ ...s })) }
  }
  if (p.mode === 'copy') {
    const own: MeshGroup[] = mesh.groups ?? [{ start: 0, count: nt, role: 'solid', name: 'original' }]
    out.groups = [...own.map(g => ({ ...g })), ...own.map((g, i) => ({ start: g.start + nt, count: g.count, role: g.role, name: `${g.name ?? `part_${i + 1}`}_mirror`, ...(g.color ? { color: g.color } : {}) }))]   // colour lives on parts: the copy keeps it
  } else if (mesh.groups) out.groups = mesh.groups.map(g => ({ ...g }))
  return { mesh: out, report: { axis: p.axis, plane: p.mode === 'flip' ? (lo + hi) / 2 : hi + p.gap / 2, triangles: nt * copies } }
}
