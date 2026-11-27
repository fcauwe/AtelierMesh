// Colour slots: which part of a model is printed in which filament. A project keeps a `ColourMap` (a few slots, each with the names of the parts that go in it); it is applied after
// the last step. By default the whole model is in the one slot, `'*'`. Parts that no slot has: in the editor they stay visible as their own parts (so the designer sees what is
// left); everywhere else (previews, the customer's screen, pictures, the export) they join the first slot. See docs/proposals/colour-slots-plan.md.
import { MeshError } from './errors'
import { groupName } from './groups'
import { DEFAULT_SEGMENT, segmentTable, triangleCount } from './segments'
import type { Mesh, MeshSegments, SegmentInfo } from './types'

/** The most slots a project may have unless the host says otherwise (the standalone Settings, the Atelier connector). */
export const DEFAULT_MAX_COLOURS = 5

export interface ColourSlot {
  /** Stable, `^[a-z0-9_]{1,12}$` (`'1'`, `'2'`, ...): the host keeps the filament it chose for a slot under this id. */
  id: string
  /** For the designer and the customer: "Part", "Text", "Base". */
  name: string
  /** Names of segments or bodies (groups) that go in this slot. `'*'` stands for every part no slot names; it may be in one slot only. */
  parts: string[]
  /** The customer may choose this slot's filament. Only the first slot is used for now. */
  personalisable?: boolean
  /** The colour this slot shows and prints in when the host does not choose one (the standalone app, which has no filament list): `#rrggbb`. A host that passes its own colours for the slots wins. */
  color?: string
}

export interface ColourMap { slots: ColourSlot[] }

/** The whole model in one slot. A host copies it before changing anything. */
export const DEFAULT_COLOUR_MAP: ColourMap = { slots: [{ id: '1', name: 'Part', parts: ['*'] }] }

export const isDefaultColourMap = (m: ColourMap | undefined | null): boolean => !m || (m.slots.length === 1 && m.slots[0]?.id === '1' && m.slots[0].parts.length === 1 && m.slots[0].parts[0] === '*' && m.slots[0].name === 'Part' && !m.slots[0].personalisable)

const SLOT_ID_RE = /^[a-z0-9_]{1,12}$/
const WHOLE = '*'

export interface ColourProblem { code: string; params: Record<string, unknown> }

/**
 * What is wrong with a map, if anything: `colours.no_slots`, `colours.too_many` (`count`, `max`), `colours.bad_slot` (`id`), `colours.duplicate_slot` (`id`),
 * `colours.part_twice` (`part`, `slots`: the ids; a part may be in one slot only). A host shows these; nothing is changed silently.
 */
export function colourMapProblems(map: ColourMap, opts: { maxColours?: number } = {}): ColourProblem[] {
  const out: ColourProblem[] = []
  const max = opts.maxColours ?? DEFAULT_MAX_COLOURS
  if (map.slots.length === 0) out.push({ code: 'colours.no_slots', params: {} })
  if (map.slots.length > max) out.push({ code: 'colours.too_many', params: { count: map.slots.length, max } })
  const ids = new Set<string>()
  const where = new Map<string, string[]>()
  for (const s of map.slots) {
    if (!SLOT_ID_RE.test(s.id)) out.push({ code: 'colours.bad_slot', params: { id: s.id } })
    if (ids.has(s.id)) out.push({ code: 'colours.duplicate_slot', params: { id: s.id } })
    ids.add(s.id)
    for (const p of new Set(s.parts)) where.set(p, [...(where.get(p) ?? []), s.id])
  }
  for (const [part, slots] of where) if (slots.length > 1) out.push({ code: 'colours.part_twice', params: { part, slots } })
  return out
}

/** The parts a map can name: the segments (with at least one triangle) and the bodies of a mesh, in that order, each name once. */
export function colourParts(mesh: Mesh): { segments: string[]; groups: string[] } {
  const used = new Set<number>()
  if (mesh.segments) { const l = mesh.segments.labels; for (let t = 0; t < l.length; t++) used.add(l[t] as number) } else used.add(0)
  const segments = segmentTable(mesh).filter(s => used.has(s.id)).map(s => s.name)
  const groups = (mesh.groups ?? []).filter(g => g.role !== 'negative').map(groupName)
  return { segments, groups: [...new Set(groups)] }
}

export interface ColourResolution {
  /** The index in `map.slots` of the slot of every triangle, or -1 for a triangle no slot has (only in `edit` mode). */
  slot: Int16Array
  /** The part names with a triangle no slot has: segments, and bodies for a triangle of the default segment. Empty in `preview` mode. */
  unassigned: string[]
}

/**
 * Which slot every triangle is in. A segment named in a slot wins over the body it is in, which wins over `'*'`. A triangle that nothing claims is `-1` in `edit` mode
 * and in the first slot in `preview` mode (previews, the customer's screen, pictures and the export).
 */
export function resolveColours(mesh: Mesh, map: ColourMap, opts: { mode: 'edit' | 'preview' }): ColourResolution {
  const n = triangleCount(mesh)
  const slot = new Int16Array(n).fill(-1)
  const bySeg = new Map<string, number>(), byGroup = new Map<string, number>()
  let whole = -1
  map.slots.forEach((s, i) => { for (const p of s.parts) { if (p === WHOLE) { if (whole < 0) whole = i } else { if (!bySeg.has(p)) bySeg.set(p, i); if (!byGroup.has(p)) byGroup.set(p, i) } } })
  const names = new Map<number, string>(segmentTable(mesh).map(s => [s.id, s.name]))
  const labels = mesh.segments?.labels
  const groupOf = new Array<string | null>(n).fill(null)
  ;(mesh.groups ?? []).forEach((g, k) => { const gn = groupName(g, k); for (let t = g.start; t < g.start + g.count && t < n; t++) groupOf[t] = gn })
  const left = new Set<string>()
  for (let t = 0; t < n; t++) {
    const sn = names.get(labels ? (labels[t] as number) : 0) ?? DEFAULT_SEGMENT
    const gn = groupOf[t]
    let i = bySeg.get(sn) ?? -1
    if (i < 0 && gn !== null) i = byGroup.get(gn) ?? -1
    if (i < 0) i = whole
    if (i < 0) { left.add(sn !== DEFAULT_SEGMENT || gn === null ? sn : gn); if (opts.mode === 'preview') i = 0 }
    slot[t] = i
  }
  return { slot, unassigned: opts.mode === 'preview' ? [] : [...left] }
}

export interface ColourPlanSlot { id: string; name: string; parts: string[]; triangles: number; volume_mm3: number }
export interface ColourPlan { slots: ColourPlanSlot[]; /** Parts no slot names (they are counted in the first slot). */ unassigned: string[] }

/**
 * What a host needs to price and print: for each slot its triangles and its volume (a body marked `negative` is subtracted), resolved the way every preview and the export are.
 * `unassigned` lists the parts that only reach a slot because unassigned parts join the first one: a designer may want to look at them.
 */
export function colourPlan(mesh: Mesh, map: ColourMap): ColourPlan {
  const { slot } = resolveColours(mesh, map, { mode: 'preview' })
  const unassigned = resolveColours(mesh, map, { mode: 'edit' }).unassigned
  const tris = new Array<number>(map.slots.length).fill(0), vol = new Array<number>(map.slots.length).fill(0)
  const P = mesh.positions, T = mesh.indices
  const sign = new Int8Array(slot.length).fill(1)
  ;(mesh.groups ?? []).forEach(g => { if (g.role === 'negative') sign.fill(-1, g.start, g.start + g.count) })
  for (let t = 0; t < slot.length; t++) {
    const i = slot[t] as number
    tris[i] = (tris[i] as number) + 1
    const a = 3 * (T[3 * t] as number), b = 3 * (T[3 * t + 1] as number), c = 3 * (T[3 * t + 2] as number)
    const ax = P[a] as number, ay = P[a + 1] as number, az = P[a + 2] as number
    const bx = P[b] as number, by = P[b + 1] as number, bz = P[b + 2] as number
    const cx = P[c] as number, cy = P[c + 1] as number, cz = P[c + 2] as number
    vol[i] = (vol[i] as number) + (sign[t] as number) * (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
  }
  return { slots: map.slots.map((s, i) => ({ id: s.id, name: s.name, parts: [...s.parts], triangles: tris[i] as number, volume_mm3: Math.round((vol[i] as number) * 1000) / 1000 })), unassigned }
}

/** The name of the segment a slot becomes: the first slot is the default segment `body`; the others are `slot_<id>`. */
export const slotSegmentName = (map: ColourMap, index: number): string => (index === 0 ? DEFAULT_SEGMENT : `slot_${map.slots[index]?.id ?? index + 1}`)

const HEX = /^#[0-9a-fA-F]{6}$/

/**
 * The mesh as it is printed or shown with the map applied. Every triangle a slot has is relabelled as the slot's segment (the first slot is `body`, the others `slot_<id>`); the
 * slots carry `colours` (`{ slotId: { color } }`) when given. `preview` (the default): every triangle has a slot, so a one-slot map gives a one-segment mesh that a viewer paints in
 * its body colour. `edit`: triangles no slot has keep their own part (renamed `unassigned` if they were the default segment), so they stay distinguishable. Bodies keep their
 * roles and ranges but lose their colours (the slots decide the colour). The input is not changed.
 */
export function applyColourMap(mesh: Mesh, map: ColourMap, opts: { mode?: 'edit' | 'preview'; colours?: Record<string, { color: string }> } = {}): Mesh {
  const problems = colourMapProblems(map, { maxColours: Math.max(map.slots.length, DEFAULT_MAX_COLOURS) })
  const bad = problems.find(p => p.code !== 'colours.too_many')
  if (bad) throw new MeshError(bad.code, bad.params)
  const mode = opts.mode ?? 'preview'
  const { slot } = resolveColours(mesh, map, { mode })
  const n = slot.length
  const table: SegmentInfo[] = map.slots.map((s, i) => {
    const color = opts.colours?.[s.id]?.color
    if (color !== undefined && !HEX.test(color)) throw new MeshError('segment.bad_color', { segment: slotSegmentName(map, i), color: String(color).slice(0, 40) })
    return { id: i, name: slotSegmentName(map, i), ...(color ? { color } : {}) }
  })
  const labels = new Uint16Array(n)
  const keep = new Map<number, number>()   // original label to the new one, for the triangles no slot has
  const taken = new Set(table.map(s => s.name))
  const old = new Map<number, string>(segmentTable(mesh).map(s => [s.id, s.name]))
  for (let t = 0; t < n; t++) {
    const i = slot[t] as number
    if (i >= 0) { labels[t] = i; continue }
    const lab = mesh.segments ? (mesh.segments.labels[t] as number) : 0
    let id = keep.get(lab)
    if (id === undefined) {
      id = table.length
      let name = old.get(lab) ?? DEFAULT_SEGMENT
      if (name === DEFAULT_SEGMENT) name = 'unassigned'
      for (let k = 2; taken.has(name); k++) name = `${name.replace(/_\d+$/, '')}_${k}`
      taken.add(name)
      const own = segmentTable(mesh).find(s => s.id === lab)
      table.push({ id, name, ...(own?.color ? { color: own.color } : {}) })
      keep.set(lab, id)
    }
    labels[t] = id
  }
  const segments: MeshSegments = { labels, table }
  const groups = mesh.groups?.map(g => { const { color: _c, ...rest } = g; return rest as typeof g })
  return { ...mesh, ...(groups ? { groups } : {}), segments }
}

/**
 * The colour slots a model that was loaded with several colours should start with (a 3MF painted in a slicer, or one AtelierMesh wrote): the unpainted part is the first slot (`'*'`),
 * and every painted segment is a slot of its own, in the order of the file, with the colour the file gives it (`color`). `undefined` when nothing is painted: the model stays one colour.
 */
export function colourMapFromMesh(mesh: Mesh): ColourMap | undefined {
  const seg = mesh.segments
  if (!seg) return undefined
  const used = new Set<number>()
  for (let i = 0; i < seg.labels.length; i++) { const l = seg.labels[i] as number; if (l !== 0) used.add(l) }
  const painted = seg.table.filter(s => s.id !== 0 && used.has(s.id))
  if (painted.length === 0) return undefined
  const hex = (c: string | undefined): string | undefined => (c && /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : undefined)
  const first = hex(seg.table.find(s => s.id === 0)?.color)
  const slots: ColourSlot[] = [{ id: '1', name: 'Part', parts: [WHOLE], ...(first ? { color: first } : {}) }]
  const taken = new Set(['1'])
  for (const s of painted) {
    const own = /^slot_([a-z0-9_]{1,12})$/.exec(s.name)?.[1]   // a file AtelierMesh wrote keeps its slot ids
    let id = own && !taken.has(own) ? own : ''
    for (let n = slots.length + 1; !id; n++) if (!taken.has(String(n))) id = String(n)
    taken.add(id)
    const c = hex(s.color)
    slots.push({ id, name: `Colour ${slots.length + 1}`, parts: [s.name], ...(c ? { color: c } : {}) })
  }
  return { slots }
}
