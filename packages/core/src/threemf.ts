// 3MF: the default export format. Writing follows docs/3mf-colour.md for the per-triangle paint some slicers read.
// Every part of the mesh, a segment (a coloured region) or a group (a body), can carry a colour: standard 3MF colours for viewers, and the paint attribute for the extruder.
// Reading accepts plain 3MF from slicers (one or many objects, components, transforms, units); it follows the Production extension (`p:path` to objects in other model parts).
import { tick } from './progress'
import type { ProgressOptions } from './progress'
import { MeshError } from './errors'
import type { StructuredError } from './errors'
import { checkMeshBudget, meshShapeProblem } from './budget'
import type { MeshLimits } from './budget'
import { DEFAULT_SEGMENT, segmentTable } from './segments'
import type { Mesh, SegmentInfo } from './types'
import { UNIT_TO_MM } from './units'
import { readZip, writeZip, writeZipDeflated } from './zip'
import type { ZipEntry } from './zip'
import type { ZipLimits } from './zip'

// ---------------------------------------------------------------- slicer paint strings

/** Whole-triangle paint value for an extruder number 1 to 16 (the slicers that read paint agree up to 16). */
export function encodePaint(extruder: number): string {
  if (!Number.isInteger(extruder) || extruder < 1 || extruder > 16) throw new MeshError('export.bad_extruder', { extruder })
  if (extruder === 1) return '4'
  if (extruder === 2) return '8'
  return (extruder - 3).toString(16).toUpperCase() + 'C'
}

/**
 * Decode a paint string into the state of the triangle. A triangle the brush has split holds several states; the most frequent
 * non-zero one is returned and `split` is true (the loss is reported, not hidden). State 0 means no paint.
 */
export function decodePaint(value: string): { state: number; split: boolean } | null {
  if (!/^[0-9A-F]+$/.test(value)) return null
  const s = value
  let pos = 0
  const nib = (): number => { if (pos >= s.length) throw new RangeError('end'); return parseInt(s[s.length - 1 - pos++] as string, 16) }
  const counts = new Map<number, number>()
  let split = false
  const node = (depth: number): void => {
    if (depth > 12) throw new RangeError('too deep')
    const v = nib(), low = v & 3, high = v >> 2
    if (low !== 0) { split = true; for (let i = 0; i <= low; i++) node(depth + 1); return }
    let state: number
    if (high < 3) state = high
    else { const z = nib(); if (z !== 14) state = z + 3; else { const lo = nib(), hi = nib(); state = (lo | (hi << 4)) + 17 } }
    counts.set(state, (counts.get(state) ?? 0) + 1)
  }
  try { node(0) } catch { return null }
  let best = 0, bestN = 0
  for (const [st, n] of counts) if (st !== 0 && n > bestN) { best = st; bestN = n }
  return { state: best, split }
}

// File-format names. Slicers that read per-triangle paint look for these exact spellings, so they are the format itself, not a choice of ours (docs/3mf-colour.md, section 1).
export const PAINT_PREFIX = 'slic3rpe'
export const PAINT_NS_URI = 'http://schemas.slic3r.org/3mf/2017/06'
export const PAINT_ATTR = `${PAINT_PREFIX}:mmu_segmentation`   // the per-triangle paint attribute
export const PAINT_ATTR_ALT = 'paint_color'                       // the same paint, under the name other slicers use
export const FACETS_FILE = 'Metadata/Slic3r_facets_annotation.json'   // the sidecar file that holds the paint as JSON
export const OBJECT_CONFIG_FILE = 'Metadata/Slic3r_PE_model.config'   // the object configuration (one extruder per body)
export const CONFIG_VERSION_META = `${PAINT_PREFIX}:Version3mf`        // marks a file as carrying that configuration
export const PAINT_VERSION_META = `${PAINT_PREFIX}:MmPaintingVersion`  // the version of the paint encoding (PrusaSlicer writes 1)
export const PROJECT_CONFIG_FILE = 'Metadata/Slic3r_PE.config'         // the project settings of PrusaSlicer: here the colour of each extruder
export const BAMBU_NS_URI = 'http://schemas.bambulab.com/package/2021'
export const BAMBU_SETTINGS_FILE = 'Metadata/model_settings.config'    // Bambu Studio: the objects and their extruders
export const BAMBU_PROJECT_FILE = 'Metadata/project_settings.config'   // Bambu Studio: the filament colours

// ---------------------------------------------------------------- writing

export interface PaletteEntry {
  /** Segment name. */
  segment: string
  /** `#rrggbb`. Falls back to the segment's own colour. */
  color?: string
  /** Extruder number 1 to 16, written for the slicer. The file never says which filament. */
  extruder?: number
}

/** What to write for slicers, besides the standard colours that every reader understands (docs/3mf-colour.md). */
export type SlicerColours = 'none' | 'inline' | 'sidecar' | 'alt_inline' | 'inline_sidecar' | 'all'

export interface Write3mfOptions {
  title?: string
  palette?: PaletteEntry[]
  /**
   * Which slicer data to write for painted triangles (the standard colours are always written). Default `inline_sidecar`.
   * `inline`: the paint as an attribute on each triangle. `sidecar`: the paint in a JSON file next to the model. `inline_sidecar`: both, they do not disturb each other.
   * `alt_inline`: the attribute under the name other slicers use. `all`: every form above. `none`: standard colours only.
   */
  slicer?: SlicerColours
  /**
   * The slicer the file is for. `prusa`: PrusaSlicer, PrusaSlicer-based services (EasyPrint) and Orca-like readers of that format: the paint on each triangle and in `Metadata/Slic3r_facets_annotation.json` (PrusaSlicer 3.0 reads only the file), the object
   * configuration with the model's name, and `Metadata/Slic3r_PE.config` with the colour of each extruder (what makes EasyPrint show every colour). `bambu`: Bambu Studio: the
   * paint under its own name, the object settings and the filament colours. Either replaces `slicer`. Not set: `slicer` decides (default `inline_sidecar`).
   */
  target?: 'prusa' | 'bambu'
  /**
   * Extruder number per body (a mesh group's name): written as an object configuration file so a multi-body part opens with one extruder per body
   * in the slicers that read it (with `inline`, `inline_sidecar` and `all`). Other slicers ignore the file.
   */
  groupExtruders?: Record<string, number>
  /** Extra metadata, written in the `am:` namespace. */
  metadata?: Record<string, string>
}

export interface Write3mfResult {
  bytes: Uint8Array
  warnings: StructuredError[]
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const num = (n: number): string => {
  if (!Number.isFinite(n)) throw new MeshError('export.not_finite')
  return n === 0 ? '0' : String(n)
}
const COLOR_RE = /^#[0-9a-fA-F]{6}$/
/** The most colours one imported file may bring in as parts. */
const MAX_COLOURS = 64

interface Body { name: string; mesh: Mesh; color?: string }

function bodies(mesh: Mesh, title: string, warnings: StructuredError[]): Body[] {
  if (!mesh.groups || mesh.groups.length === 0) return [{ name: title, mesh }]
  const nt = mesh.indices.length / 3
  const covered = new Uint8Array(nt)
  const out: Body[] = []
  for (const g of mesh.groups) {
    if (g.role === 'negative') { warnings.push({ code: 'export.negative_dropped', params: { name: g.name ?? null } }); continue }
    const tris: number[] = []
    for (let t = g.start; t < Math.min(nt, g.start + g.count); t++) { tris.push(t); covered[t] = 1 }
    if (g.color !== undefined && !COLOR_RE.test(g.color)) throw new MeshError('export.bad_color', { group: g.name ?? null, color: String(g.color).slice(0, 40) })
    out.push({ name: g.name ?? title, mesh: subMesh(mesh, tris), ...(g.color ? { color: g.color.toUpperCase() } : {}) })
  }
  const rest: number[] = []
  for (let t = 0; t < nt; t++) if (!covered[t] && !mesh.groups.some(g => g.role === 'negative' && t >= g.start && t < g.start + g.count)) rest.push(t)
  if (rest.length > 0) out.push({ name: title, mesh: subMesh(mesh, rest) })
  return out
}

function subMesh(mesh: Mesh, tris: number[]): Mesh {
  const map = new Map<number, number>()
  const pos: number[] = []
  const idx = new Uint32Array(tris.length * 3)
  const labels = mesh.segments ? new Uint16Array(tris.length) : undefined
  tris.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[3 * t + k] as number
      let m = map.get(v)
      if (m === undefined) { m = map.size; map.set(v, m); pos.push(mesh.positions[3 * v] as number, mesh.positions[3 * v + 1] as number, mesh.positions[3 * v + 2] as number) }
      idx[3 * i + k] = m
    }
    if (labels && mesh.segments) labels[i] = mesh.segments.labels[t] as number
  })
  return { positions: Float64Array.from(pos), indices: idx, ...(labels && mesh.segments ? { segments: { labels, table: mesh.segments.table } } : {}) }
}

/** The object configuration: one object per body, its extruder on the object and on its one volume (the triangles of the object). */
function peConfig(list: Body[], extruders: Record<string, number>): string {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<config>']
  list.forEach((b, i) => {
    const e = extruders[b.name]
    const nt = b.mesh.indices.length / 3
    out.push(` <object id="${i + 1}" instances_count="1">`, `  <metadata type="object" key="name" value="${esc(b.name)}"/>`)
    if (e !== undefined) out.push(`  <metadata type="object" key="extruder" value="${e}"/>`)
    out.push(`  <volume firstid="0" lastid="${nt - 1}">`, `   <metadata type="volume" key="name" value="${esc(b.name)}"/>`, '   <metadata type="volume" key="volume_type" value="ModelPart"/>')
    if (e !== undefined) out.push(`   <metadata type="volume" key="extruder" value="${e}"/>`)
    out.push('  </volume>', ' </object>')
  })
  out.push('</config>')
  return out.join('\n')
}

/** The 3MF as bytes with the entries stored uncompressed (deterministic, no library). */
export function write3mf(mesh: Mesh, opts: Write3mfOptions = {}): Write3mfResult {
  const { entries, warnings } = build3mf(mesh, opts)
  return { bytes: writeZip(entries), warnings }
}

/** The same file with every entry deflated, as slicers write them: about a quarter of the size for a big mesh. Needs `CompressionStream`. */
export async function write3mfCompressed(mesh: Mesh, opts: Write3mfOptions = {}): Promise<Write3mfResult> {
  const { entries, warnings } = build3mf(mesh, opts)
  return { bytes: await writeZipDeflated(entries), warnings }
}

/** The colour of extruder 1, 2, 3 ... as the slicer lists them: the default segment's colour is extruder 1, a palette entry gives its extruder's colour, a gap is white. */
function extruderColours(table: SegmentInfo[], palette: Map<string, PaletteEntry>, colorOf: Map<number, string>): string[] {
  const by = new Map<number, string>()
  const first = colorOf.get(0)
  if (first) by.set(1, first)
  for (const s of table) { const e = palette.get(s.name)?.extruder; const c = colorOf.get(s.id); if (e !== undefined && c && !by.has(e)) by.set(e, c) }
  const n = Math.max(1, ...by.keys())
  return Array.from({ length: n }, (_, i) => by.get(i + 1) ?? '#FFFFFF')
}

const prusaProjectConfig = (colours: string[]): string => `; extruder_colour = ${colours.join(';')}\n; filament_colour = ${colours.join(';')}\n; nozzle_diameter = ${colours.map(() => '0.4').join(',')}\n`

/** Bambu Studio's object settings: a name and an extruder per body. */
function bambuConfig(list: Body[], extruders: Record<string, number>): string {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<config>']
  list.forEach((b, i) => {
    out.push(`  <object id="${i + 1}">`, `    <metadata key="name" value="${esc(b.name)}"/>`)
    if (extruders[b.name] !== undefined) out.push(`    <metadata key="extruder" value="${extruders[b.name]}"/>`)
    out.push('    <part id="1" subtype="normal_part">', `      <metadata key="name" value="${esc(b.name)}"/>`, '    </part>', '  </object>')
  })
  out.push('</config>')
  return out.join('\n')
}

/** The extruder of every part, from Bambu Studio's / Creality Print's object settings: `<object id>` > `<part id>` > `extruder`. Key `"<object>:<part>"`; empty when the file has none. */
function partExtrudersOf(files: Map<string, Uint8Array>): Map<string, number> {
  const out = new Map<string, number>()
  const raw = files.get(BAMBU_SETTINGS_FILE)
  if (!raw) return out
  const text = new TextDecoder().decode(raw)
  for (const o of text.matchAll(/<object id="([^"]+)"[^>]*>([\s\S]*?)<\/object>/g)) {
    for (const p of (o[2] as string).matchAll(/<part id="([^"]+)"[^>]*>([\s\S]*?)<\/part>/g)) {
      const e = /key="extruder" value="(\d+)"/.exec(p[2] as string)
      const n = e ? Number(e[1]) : 0
      if (n >= 1 && n <= 16) out.set(`${o[1]}:${p[1]}`, n)
    }
  }
  return out
}

const HEX7 = /^#[0-9a-fA-F]{6}/
/** The colour of extruder 1, 2, 3 ... from the slicer's own settings in the file; empty when it has none. A value that is not `#rrggbb` is left out. */
function extruderColoursOf(files: Map<string, Uint8Array>): string[] {
  const clean = (list: unknown[]): string[] => list.map(c => (typeof c === 'string' && HEX7.test(c.trim()) ? c.trim().slice(0, 7).toLowerCase() : ''))
  const pe = files.get(PROJECT_CONFIG_FILE)
  if (pe) {
    const text = new TextDecoder().decode(pe)
    const line = (key: string): string[] | null => { const m = new RegExp(`^; ${key} = (.*)$`, 'm').exec(text); return m ? clean((m[1] as string).split(';').map(x => x.replace(/"/g, ''))) : null }
    return line('extruder_colour') ?? []
  }
  const bambu = files.get(BAMBU_PROJECT_FILE)
  if (bambu) { try { const j = JSON.parse(new TextDecoder().decode(bambu)) as { filament_colour?: unknown }; if (Array.isArray(j.filament_colour)) return clean(j.filament_colour) } catch { /* not ours to read */ } }
  return []
}

function build3mf(mesh: Mesh, opts: Write3mfOptions): { entries: ZipEntry[]; warnings: StructuredError[] } {
  const problem = meshShapeProblem(mesh)
  if (problem) throw new MeshError('export.invalid_mesh', { reason: problem })
  const warnings: StructuredError[] = []
  const target = opts.target
  const slicer: SlicerColours = target === 'prusa' ? 'inline_sidecar' : target === 'bambu' ? 'alt_inline' : (opts.slicer ?? 'inline_sidecar')
  const title = opts.title ?? 'ateliermesh'
  const palette = new Map((opts.palette ?? []).map(p => [p.segment, p]))
  for (const p of palette.values()) {
    if (p.color !== undefined && !COLOR_RE.test(p.color)) throw new MeshError('export.bad_color', { segment: p.segment, color: p.color })
    if (p.extruder !== undefined) encodePaint(p.extruder)
  }
  const list = bodies(mesh, title, warnings)
  if (list.length === 0) throw new MeshError('export.invalid_mesh', { reason: 'nothing_to_write' })

  // colours: one entry per segment that has a colour, in table order
  const table = segmentTable(mesh)
  const colorOf = new Map<number, string>()   // segment id -> #RRGGBB
  const paintOf = new Map<number, string>()   // segment id -> paint string
  for (const s of table) {
    const p = palette.get(s.name)
    const c = p?.color ?? s.color
    if (c) colorOf.set(s.id, c.toUpperCase())
    if (p?.extruder !== undefined && slicer !== 'none') paintOf.set(s.id, encodePaint(p.extruder))
  }
  const baseIndex = new Map<number, number>()
  const materialId = list.length + 1
  const bases: string[] = []
  for (const s of table) { const c = colorOf.get(s.id); if (c) { baseIndex.set(s.id, bases.length); bases.push(`<base name="${esc(s.name)}" displaycolor="${c}FF"/>`) } }
  // a body that carries a colour gets a colour of its own (named after the body); its triangles use it unless a segment colour is set on them
  const bodyBase = new Map<number, number>()
  list.forEach((b, i) => { if (b.color) { bodyBase.set(i, bases.length); bases.push(`<base name="${esc(b.name)}" displaycolor="${b.color}FF"/>`) } })
  const wantsInline = slicer === 'inline_sidecar' || slicer === 'inline' || slicer === 'all'
  const usePaintAttr = wantsInline && paintOf.size > 0
  const groupCfg = target === 'prusa' || (opts.groupExtruders && Object.keys(opts.groupExtruders).length > 0 && wantsInline)
  if (groupCfg) for (const e of Object.values(opts.groupExtruders ?? {})) encodePaint(e) // the same 1 to 16 rule
  const useSidecar = (slicer === 'inline_sidecar' || slicer === 'sidecar' || slicer === 'all') && paintOf.size > 0
  const useAltAttr = (slicer === 'alt_inline' || slicer === 'all') && paintOf.size > 0

  const xml: string[] = ['<?xml version="1.0" encoding="UTF-8"?>']
  xml.push(`<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"${usePaintAttr || groupCfg ? ` xmlns:${PAINT_PREFIX}="${PAINT_NS_URI}"` : ''}${target === 'bambu' ? ` xmlns:BambuStudio="${BAMBU_NS_URI}"` : ''} xmlns:am="urn:ateliermesh:3mf:1">`)
  xml.push('<metadata name="Application">AtelierMesh</metadata>')
  xml.push(`<metadata name="Title">${esc(title)}</metadata>`)
  if (groupCfg) xml.push(`<metadata name="${CONFIG_VERSION_META}">1</metadata>`)
  if (target === 'prusa') xml.push(`<metadata name="${PAINT_VERSION_META}">1</metadata>`)
  if (target === 'bambu') xml.push('<metadata name="BambuStudio:3mfVersion">1</metadata>')
  for (const [k, v] of Object.entries(opts.metadata ?? {})) {
    if (!/^[A-Za-z][\w.-]*$/.test(k)) throw new MeshError('export.bad_metadata_key', { key: k })
    xml.push(`<metadata name="am:${k}">${esc(v)}</metadata>`)
  }
  const facetsJson: Array<Record<string, unknown>> = []
  xml.push('<resources>')
  if (bases.length > 0) xml.push(`<basematerials id="${materialId}">${bases.join('')}</basematerials>`)
  list.forEach((b, oi) => {
    const m = b.mesh, P = m.positions, T = m.indices
    const ob = bodyBase.get(oi)
    xml.push(`<object id="${oi + 1}" type="model" name="${esc(b.name)}"${ob !== undefined ? ` pid="${materialId}" pindex="${ob}"` : ''}><mesh><vertices>`)
    const v: string[] = []
    for (let i = 0; i < P.length; i += 3) v.push(`<vertex x="${num(P[i] as number)}" y="${num(P[i + 1] as number)}" z="${num(P[i + 2] as number)}"/>`)
    xml.push(v.join(''), '</vertices><triangles>')
    const t: string[] = []
    const facets: Array<{ triangle: number; dividing: string }> = []
    for (let i = 0; i < T.length / 3; i++) {
      const label = m.segments ? (m.segments.labels[i] as number) : 0
      let extra = ''
      // a segment colour wins over the body colour; the default segment's colour is the layer below the body colour
      let bi = baseIndex.get(label)
      if (ob !== undefined && (label === 0 || bi === undefined)) bi = ob
      if (bi !== undefined) extra += ` pid="${materialId}" p1="${bi}"`
      const paint = paintOf.get(label)
      if (paint !== undefined && useSidecar) facets.push({ triangle: i, dividing: paint })
      if (paint !== undefined) { if (usePaintAttr) extra += ` ${PAINT_ATTR}="${paint}"`; if (useAltAttr) extra += ` ${PAINT_ATTR_ALT}="${paint}"` }
      t.push(`<triangle v1="${T[3 * i]}" v2="${T[3 * i + 1]}" v3="${T[3 * i + 2]}"${extra}/>`)
    }
    xml.push(t.join(''), '</triangles></mesh></object>')
    if (facets.length > 0) facetsJson.push({ id: oi + 1, mmSegmentationFacets: facets, mmSegmentationFacetsVersion: 1 })
  })
  xml.push('</resources><build>')
  list.forEach((_, oi) => xml.push(`<item objectid="${oi + 1}"/>`))
  xml.push('</build></model>')

  const enc = new TextEncoder()
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>') },
    { name: '_rels/.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>') },
    { name: '3D/3dmodel.model', data: enc.encode(xml.join('\n')) },
    ...(groupCfg ? [{ name: OBJECT_CONFIG_FILE, data: enc.encode(peConfig(list, opts.groupExtruders ?? {})) }] : []),
    ...(target === 'prusa' ? [{ name: PROJECT_CONFIG_FILE, data: enc.encode(prusaProjectConfig(extruderColours(table, palette, colorOf))) }] : []),
    ...(target === 'bambu' ? [{ name: BAMBU_SETTINGS_FILE, data: enc.encode(bambuConfig(list, opts.groupExtruders ?? {})) }, { name: BAMBU_PROJECT_FILE, data: enc.encode(JSON.stringify({ filament_colour: extruderColours(table, palette, colorOf) }, null, 2)) }] : []),
    ...(facetsJson.length > 0 ? [{ name: FACETS_FILE, data: enc.encode(JSON.stringify(facetsJson)) }] : []),
  ]
  return { entries, warnings }
}

// ---------------------------------------------------------------- reading

export interface Read3mfOptions extends ProgressOptions {
  limits?: MeshLimits
  zip?: ZipLimits
}

export interface Read3mfResult {
  /** In millimetres, build transforms applied, all build items merged into one mesh. */
  mesh: Mesh
  unit: string
  objects: number
  /** Triangles that carried a slicer paint value. */
  paintedTriangles: number
  /** Painted triangles the brush had split: they were given their most frequent colour. */
  splitTriangles: number
  /** How many distinct colours the file's materials gave (at most 64; they became colours of bodies or `material_N` segments). */
  colours: number
  metadata: Record<string, string>
  warnings: StructuredError[]
}

interface Comp { id: string; path: string; m: number[] | null }
/** A material of the file: a list of colours (`#RRGGBB`), from `basematerials` (`displaycolor`) or the materials extension's `colorgroup`. */
interface Obj {
  id: string; type: string; name?: string; path: string; v: number[]; t: number[]; paint: Array<string | undefined>; comps: Comp[]
  /** The object's default material: the resource id and the index in it. */
  pid?: string; pindex?: number
  /** Triangles that name a material of their own: the triangle, the resource id and the index (`p1`). */
  mat: Array<{ t: number; pid: string; p1: number }>
}

const bad = (reason: string, extra: Record<string, unknown> = {}): MeshError => new MeshError('import.invalid_3mf', { reason, ...extra })
const UNITS: Record<string, number> = { micron: UNIT_TO_MM.micron, millimeter: 1, centimeter: 10, meter: 1000, inch: 25.4, foot: 304.8 }

/** The text of an XML attribute or element as it was meant: the five named entities and numeric ones, in one pass (`&amp;lt;` is `&lt;`, not `<`). */
export function xmlUnescape(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/g, (all, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name] as string
    const cp = dec !== undefined ? Number(dec) : parseInt(hex as string, 16)
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : all
  })
}

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  for (let m = re.exec(s); m; m = re.exec(s)) out[m[1] as string] = xmlUnescape((m[2] ?? m[3]) as string)
  return out
}

function* tags(xml: string): Generator<{ name: string; attrs: string; closing: boolean; end: number }> {
  let i = 0
  const n = xml.length
  while (i < n) {
    i = xml.indexOf('<', i)
    if (i < 0) return
    if (xml.startsWith('<!--', i)) { const e = xml.indexOf('-->', i + 4); if (e < 0) throw bad('unterminated_comment'); i = e + 3; continue }
    if (xml.startsWith('<?', i)) { const e = xml.indexOf('?>', i + 2); if (e < 0) throw bad('unterminated_declaration'); i = e + 2; continue }
    if (xml.startsWith('<!', i)) throw bad('dtd_not_allowed') // no DTD, no entities
    let j = i + 1, q = ''
    for (; j < n; j++) { const c = xml[j] as string; if (q) { if (c === q) q = '' } else if (c === '"' || c === "'") q = c; else if (c === '>') break }
    if (j >= n) throw bad('unterminated_tag')
    const body = xml.slice(i + 1, j)
    const closing = body.startsWith('/')
    const sp = body.search(/[\s/]/)
    const name = (closing ? body.slice(1) : sp < 0 ? body : body.slice(0, sp)).trim()
    yield { name, attrs: closing ? '' : sp < 0 ? '' : body.slice(sp), closing, end: j + 1 }
    i = j + 1
  }
}

function parseMatrix(s: string | undefined): number[] | null {
  if (!s) return null
  const m = s.trim().split(/\s+/).map(Number)
  if (m.length !== 12 || m.some(x => !Number.isFinite(x))) throw bad('bad_transform')
  return m
}

function compose(a: number[] | null, b: number[] | null): number[] | null {
  if (!a) return b
  if (!b) return a
  // row-vector convention: p' = p * B * A ... applied as inner first: point -> b -> a
  const r: number[] = new Array<number>(12).fill(0)
  const A = (i: number, j: number): number => (i === 3 ? (j === 3 ? 1 : (a[9 + j] as number)) : j === 3 ? 0 : (a[3 * i + j] as number))
  const B = (i: number, j: number): number => (i === 3 ? (j === 3 ? 1 : (b[9 + j] as number)) : j === 3 ? 0 : (b[3 * i + j] as number))
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) { let s = 0; for (let k = 0; k < 4; k++) s += B(i, k) * A(k, j); r[i === 3 ? 9 + j : 3 * i + j] = s }
  return r
}

export async function read3mf(bytes: Uint8Array, opts: Read3mfOptions = {}): Promise<Read3mfResult> {
  // progress: unzip 0 to 0.15, parse the XML 0.15 to 0.6, build the mesh 0.6 to 1; the loops give the event loop a turn now and then
  let lastP = 0
  const report = (f: number): void => { if (f > lastP) { lastP = f; opts.onProgress?.(Math.min(0.999, f)) } }
  const pause = async (f: number): Promise<void> => { opts.signal?.throwIfAborted(); report(f); await tick() }
  await pause(0.01)
  const entries = await readZip(bytes, opts.zip, name => name.endsWith('.rels') || name.endsWith('.model') || name === FACETS_FILE || name === PROJECT_CONFIG_FILE || name === BAMBU_PROJECT_FILE || name === BAMBU_SETTINGS_FILE)
  await pause(0.15)
  const files = new Map(entries.map(e => [e.name, e.data]))
  const dec = new TextDecoder()
  let modelPath = '3D/3dmodel.model'
  const rels = files.get('_rels/.rels')
  if (rels) {
    const text = dec.decode(rels)
    for (const t of tags(text)) if (t.name === 'Relationship' && !t.closing) {
      const a = attrs(t.attrs)
      if (a['Type']?.endsWith('/3dmodel') && a['Target']) modelPath = a['Target'].replace(/^\//, '')
    }
  }
  const warnings: StructuredError[] = []
  const metadata: Record<string, string> = {}
  const objects = new Map<string, Obj>()   // key: `${part}#${id}`
  const materials = new Map<string, string[]>()   // key: `${part}#${resource id}` -> colours
  // the names of the materials (`<base name>`) and the order they come in, for a file AtelierMesh wrote: a material is then a segment (a colour slot), not only a colour
  const materialNames = new Map<string, string[]>()
  const materialOrder = new Map<string, number>()   // `${part}#${resource id}:${index}` -> position in the file
  const hex6 = (c: string | undefined): string | null => { const m = /^#?([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?$/.exec((c ?? '').trim()); return m ? `#${(m[1] as string).toLowerCase()}` : null }
  const items: Array<{ id: string; path: string; m: number[] | null }> = []
  let unit = 'millimeter'
  let nTri = 0
  let sawModel = false
  const normPath = (p: string): string => {
    const parts: string[] = []
    for (const seg of p.replace(/^\/+/, '').split('/')) { if (seg === '..') throw bad('unsafe_part_path', { path: p }); if (seg !== '' && seg !== '.') parts.push(seg) }
    return parts.join('/')
  }
  const loaded = new Set<string>()

  const parsePart = async (path: string, isRoot: boolean): Promise<void> => {
    const data = files.get(path)
    if (!data) throw bad('missing_model_part', { path })
    loaded.add(path)
    const xml = dec.decode(data)
    let cur: Obj | null = null
    let res: string[] | null = null   // the material resource being read
    let resNames: string[] | null = null, resKey = ''
    let partUnit = 'millimeter'
    let seen = 0
    for (const t of tags(xml)) {
      if (++seen % 40000 === 0) await pause(0.15 + 0.45 * (t.end / xml.length))
      if (t.closing) { if (t.name === 'object') cur = null; else if (/(^|:)(basematerials|colorgroup)$/.test(t.name)) { res = null; resNames = null } continue }
      const local = t.name.includes(':') && !t.name.startsWith(PAINT_PREFIX) ? t.name.slice(t.name.indexOf(':') + 1) : t.name
      switch (local) {
        case 'model': {
          if (isRoot) sawModel = true
          const a = attrs(t.attrs)
          if (a['unit']) partUnit = a['unit']
          if (isRoot) unit = partUnit
          else if (partUnit !== unit) throw bad('unit_differs_between_parts', { path })
          if (a['requiredextensions']) { const req = a['requiredextensions'].split(/\s+/).filter(Boolean).filter(x => x !== 'p'); if (req.length > 0) throw bad('required_extension_not_supported', { extensions: req }) }
          break
        }
        case 'metadata': {
          if (!isRoot) break
          const a = attrs(t.attrs)
          const close = xml.indexOf('</', t.end)
          if (a['name'] && close > 0 && close - t.end < 4096 && Object.keys(metadata).length < 100) metadata[a['name']] = xmlUnescape(xml.slice(t.end, close).trim())
          break
        }
        case 'basematerials': case 'colorgroup': { const a = attrs(t.attrs); if (a['id'] !== undefined) { resKey = `${path}#${a['id']}`; res = []; resNames = []; materials.set(resKey, res); materialNames.set(resKey, resNames) } break }
        case 'base': { if (res) { const a = attrs(t.attrs); materialOrder.set(`${resKey}:${res.length}`, materialOrder.size); resNames?.push(a['name'] ?? ''); res.push(hex6(a['displaycolor']) ?? '') } break }
        case 'color': { if (res) res.push(hex6(attrs(t.attrs)['color']) ?? ''); break }
        case 'object': { const a = attrs(t.attrs); cur = { id: a['id'] ?? '', type: a['type'] ?? 'model', ...(a['name'] ? { name: a['name'].slice(0, 120) } : {}), path, v: [], t: [], paint: [], comps: [], mat: [], ...(a['pid'] !== undefined ? { pid: a['pid'], pindex: Number(a['pindex'] ?? 0) } : {}) }; if (!cur.id) throw bad('object_without_id'); const key = `${path}#${cur.id}`; if (objects.has(key)) throw bad('duplicate_object_id', { id: cur.id }); objects.set(key, cur); break }
        case 'vertex': { if (!cur) break; const a = attrs(t.attrs); cur.v.push(Number(a['x']), Number(a['y']), Number(a['z'])); break }
        case 'triangle': {
          if (!cur) break
          const a = attrs(t.attrs)
          cur.t.push(Number(a['v1']), Number(a['v2']), Number(a['v3']))
          cur.paint.push(a[PAINT_ATTR] || a[PAINT_ATTR_ALT] || undefined)
          if (a['pid'] !== undefined && a['p1'] !== undefined) cur.mat.push({ t: cur.paint.length - 1, pid: a['pid'], p1: Number(a['p1']) })
          nTri++
          if (opts.limits?.maxTriangles !== undefined && nTri > opts.limits.maxTriangles) throw new MeshError('budget.triangles', { triangles: nTri, max: opts.limits.maxTriangles, of: 'file' })
          break
        }
        case 'component': {
          if (!cur) break
          const a = attrs(t.attrs)
          cur.comps.push({ id: a['objectid'] ?? '', path: a['p:path'] ? normPath(a['p:path']) : path, m: parseMatrix(a['transform']) })
          break
        }
        case 'item': {
          if (!isRoot) throw bad('build_in_sub_model', { path })
          const a = attrs(t.attrs)
          items.push({ id: a['objectid'] ?? '', path: a['p:path'] ? normPath(a['p:path']) : path, m: parseMatrix(a['transform']) })
          break
        }
      }
    }
  }
  await parsePart(modelPath, true)
  // some slicers keep the paint in a JSON file next to the model: [{ id, mmSegmentationFacets: [{ triangle, dividing }] }]
  const facets = files.get(FACETS_FILE)
  if (facets) {
    let parsed: unknown
    try { parsed = JSON.parse(dec.decode(facets)) } catch { warnings.push({ code: 'import.paint_file_unreadable', params: { file: FACETS_FILE } }); parsed = [] }
    if (Array.isArray(parsed)) for (const e of parsed as Array<Record<string, unknown>>) {
      const o = objects.get(`${modelPath}#${String(e?.['id'])}`)
      const list = e?.['mmSegmentationFacets']
      if (!o || !Array.isArray(list)) continue
      for (const f of list as Array<Record<string, unknown>>) {
        const tri = f['triangle'], div = f['dividing']
        if (typeof tri === 'number' && Number.isInteger(tri) && tri >= 0 && tri < o.paint.length && typeof div === 'string' && o.paint[tri] === undefined) o.paint[tri] = div
      }
    }
  }
  // follow p:path references; a part is read once, however often it is referenced
  for (let guard = 0; guard < 1000; guard++) {
    const missing = new Set<string>()
    for (const r of items) if (!loaded.has(r.path)) missing.add(r.path)
    for (const o of objects.values()) for (const c of o.comps) if (!loaded.has(c.path)) missing.add(c.path)
    if (missing.size === 0) break
    if (loaded.size >= 64) throw bad('too_many_model_parts')
    for (const p of missing) await parsePart(p, false)
  }
  if (!sawModel) throw bad('no_model_element')
  const scale = UNITS[unit]
  if (scale === undefined) throw bad('unknown_unit', { unit })

  const roots = items.length > 0 ? items : [...objects.entries()].filter(([, o]) => o.type === 'model').map(([k, o]) => ({ id: o.id, path: k.slice(0, k.lastIndexOf('#')), m: null as number[] | null }))
  if (roots.length === 0) throw bad('no_objects')
  const pos: number[] = [], idx: number[] = [], states: number[] = []
  let painted = 0, split = 0
  const colourIds = new Map<string, number>(), colourList: string[] = ['']   // id 0 = no colour
  const triCol: number[] = []   // the colour id of every triangle of the mesh we build
  // a file AtelierMesh wrote: the material of a triangle is its colour slot, kept by name (see the end of the colours below)
  const slotMode = metadata['Application'] === 'AtelierMesh'
  const SLOT_NAME_RE = /^[a-z][a-z0-9_]*$/
  const slotOf = new Map<number, { key: string; name: string; colour: string }>()   // triangle of the mesh -> its material
  const colourId = (c: string): number => { let id = colourIds.get(c); if (id === undefined) { id = colourList.length; colourIds.set(c, id); colourList.push(c) } return id }

  const partSpans: Array<{ object: string; part: string; start: number; end: number }> = []   // the parts (components) of every object of the build, as ranges of triangles
  const emit = async (o: Obj, m: number[] | null, depth: number): Promise<void> => {
    if (depth > 8) throw bad('components_too_deep')
    if (o.type !== 'model') { warnings.push({ code: 'import.object_skipped', params: { id: o.id, type: o.type } }); return }
    const nv = o.v.length / 3
    const base = pos.length / 3
    for (let i = 0; i < nv; i++) {
      const x = o.v[3 * i] as number, y = o.v[3 * i + 1] as number, z = o.v[3 * i + 2] as number
      if (m) pos.push(x * (m[0] as number) + y * (m[3] as number) + z * (m[6] as number) + (m[9] as number), x * (m[1] as number) + y * (m[4] as number) + z * (m[7] as number) + (m[10] as number), x * (m[2] as number) + y * (m[5] as number) + z * (m[8] as number) + (m[11] as number))
      else pos.push(x, y, z)
    }
    // a mirroring transform turns the triangles inside out: restore the winding
    const det = m ? (m[0] as number) * ((m[4] as number) * (m[8] as number) - (m[5] as number) * (m[7] as number)) - (m[1] as number) * ((m[3] as number) * (m[8] as number) - (m[5] as number) * (m[6] as number)) + (m[2] as number) * ((m[3] as number) * (m[7] as number) - (m[4] as number) * (m[6] as number)) : 1
    const flip = det < 0
    // the colour each triangle asks for: its own material, else the object's default material
    const objRes = o.pid !== undefined ? materials.get(`${o.path}#${o.pid}`) : undefined
    const objColour = objRes ? (objRes[o.pindex ?? 0] || undefined) : undefined
    const own = o.mat.length > 0 ? new Map(o.mat.map(e => [e.t, e])) : null
    for (let i = 0; i < o.t.length / 3; i++) {
      if (i > 0 && i % 100_000 === 0) await pause(0.6 + 0.4 * Math.min(1, idx.length / 3 / Math.max(1, nTri)))
      const a = o.t[3 * i] as number, b = o.t[3 * i + 1] as number, c = o.t[3 * i + 2] as number
      if (![a, b, c].every(v => Number.isInteger(v) && v >= 0 && v < nv)) throw bad('triangle_index_out_of_range', { object: o.id })
      if (flip) idx.push(base + a, base + c, base + b); else idx.push(base + a, base + b, base + c)
      const p = o.paint[i]
      let st = 0
      if (p) { const d = decodePaint(p); if (d) { st = d.state; if (st > 0) painted++; if (d.split) split++ } }
      states.push(st)
      let col = objColour
      const mt = own?.get(i)
      if (mt) {
        const rk = `${o.path}#${mt.pid}`
        col = materials.get(rk)?.[mt.p1] || objColour
        const nm = materialNames.get(rk)?.[mt.p1]
        // the object's own material (a body's colour) is a colour of the body, not a slot
        if (slotMode && nm && col && SLOT_NAME_RE.test(nm) && nm.length <= 40 && !(mt.pid === o.pid && mt.p1 === (o.pindex ?? 0))) {
          slotOf.set(triCol.length, { key: `${rk}:${mt.p1}`, name: nm, colour: col })
          states[states.length - 1] = 0   // (`paintedTriangles` still counts the paint) our own paint is the slot's extruder: the slot, by name, says more
          triCol.push(0)
          continue
        }
      }
      triCol.push(col ? colourId(col) : 0)
    }
    for (const c of o.comps) {
      const child = objects.get(`${c.path}#${c.id}`); if (!child) throw bad('component_refers_to_missing_object', { id: c.id })
      const from = idx.length / 3
      await emit(child, compose(c.m, m), depth + 1)
      if (depth === 0) partSpans.push({ object: o.id, part: c.id, start: from, end: idx.length / 3 })
    }
  }
  // every object of the file is a body of its own: a contiguous range of triangles with its name (a file with one object has no groups)
  const ranges: Array<{ start: number; count: number; name: string }> = []
  const firstName = (o: Obj, depth = 0): string | undefined => o.name ?? (depth < 4 ? o.comps.map(c => objects.get(`${c.path}#${c.id}`)).map(ch => (ch ? firstName(ch, depth + 1) : undefined)).find(Boolean) : undefined)
  for (const r of roots) {
    const o = objects.get(`${r.path}#${r.id}`); if (!o) throw bad('item_refers_to_missing_object', { id: r.id })
    const before = idx.length / 3
    await emit(o, r.m, 0)
    await pause(0.6 + 0.4 * Math.min(1, idx.length / 3 / Math.max(1, nTri)))
    const count = idx.length / 3 - before
    if (count > 0) ranges.push({ start: before, count, name: firstName(o) ?? `Part ${ranges.length + 1}` })
  }
  if (idx.length === 0) throw bad('no_triangles')

  const positions = Float64Array.from(pos)
  if (scale !== 1) for (let i = 0; i < positions.length; i++) positions[i] = (positions[i] as number) * scale
  const mesh: Mesh = { positions, indices: Uint32Array.from(idx) }
  if (ranges.length > 1) {
    const seen = new Map<string, number>()
    mesh.groups = ranges.map(g => { const n = (seen.get(g.name) ?? 0) + 1; seen.set(g.name, n); return { start: g.start, count: g.count, role: 'solid' as const, name: n > 1 ? `${g.name} ${n}` : g.name } })
  }
  // the colour a slicer file gives each extruder (PrusaSlicer's project settings, Bambu Studio's filament colours): the segment of that extruder's paint gets it
  const extruderColour = extruderColoursOf(files)
  // Bambu Studio and Creality Print give each part of an object an extruder in `Metadata/model_settings.config` (the part is a component of the object): a part with no paint of its own takes it
  const partExtruder = partExtrudersOf(files)
  let partsColoured = false
  if (partExtruder.size > 0 && new Set(partExtruder.values()).size > 1) {
    for (const sp of partSpans) {
      const e = partExtruder.get(`${sp.object}:${sp.part}`)
      if (e === undefined) continue
      for (let i = sp.start; i < sp.end; i++) if (states[i] === 0) { states[i] = e; partsColoured = true }
    }
  }
  if (painted > 0 || partsColoured) {
    const labels = new Uint16Array(states.length)
    const table: SegmentInfo[] = [{ id: 0, name: DEFAULT_SEGMENT }]
    const ids = new Map<number, number>()
    states.forEach((st, i) => {
      if (st === 0) return
      let id = ids.get(st)
      if (id === undefined) { id = table.length; ids.set(st, id); const c = extruderColour[st - 1]; table.push({ id, name: `extruder_${st}`, ...(c ? { color: c } : {}) }) }
      labels[i] = id
    })
    mesh.segments = { labels, table }
  }
  // a file AtelierMesh wrote: every material that triangles use is one segment with its name and colour (the first slot is `body`), so two slots of one colour stay two
  // slots. A triangle of such a file that has a slot's material is that slot even when it also carries paint (the paint is only the slot's extruder number); paint on a triangle
  // with no slot material keeps its own segment. Files of other programs are not read this way: there a material name is free text.
  const slotColours = new Set<string>()
  if (slotOf.size > 0) {
    const mats = new Map<string, { order: number; name: string; colour: string }>()
    for (const s of slotOf.values()) if (!mats.has(s.key)) mats.set(s.key, { order: materialOrder.get(s.key) ?? 0, name: s.name, colour: s.colour })
    if (!mesh.segments) mesh.segments = { labels: new Uint16Array(states.length), table: [{ id: 0, name: DEFAULT_SEGMENT }] }
    const seg = mesh.segments
    const taken = new Set(seg.table.map(s => s.name))
    const idOf = new Map<string, number>()
    let firstTaken = false
    for (const [key, m] of [...mats.entries()].sort((a, b) => a[1].order - b[1].order)) {
      slotColours.add(m.colour)
      if (m.name === DEFAULT_SEGMENT && !firstTaken) { firstTaken = true; idOf.set(key, 0); seg.table[0] = { ...(seg.table[0] as SegmentInfo), color: m.colour }; continue }
      let name = m.name === DEFAULT_SEGMENT ? 'body_2' : m.name
      for (let k = 2; taken.has(name); k++) name = `${m.name.replace(/_\d+$/, '')}_${k}`
      taken.add(name)
      const id = seg.table.length
      seg.table.push({ id, name, color: m.colour })
      idOf.set(key, id)
    }
    for (const [t, s] of slotOf) seg.labels[t] = idOf.get(s.key) as number
  }
  // colours of the file become colours of parts: one colour for a whole body -> the body's colour (a single-object file: the colour of the default segment);
  // several colours inside one body -> a segment `material_1`, `material_2` ... per colour. At most 64 colours; the rest take the nearest of them.
  let colourCount = 0
  if (colourList.length > 1) {
    const counts = new Array<number>(colourList.length).fill(0)
    for (const c of triCol) counts[c] = (counts[c] as number) + 1
    const order = colourList.map((_, i) => i).filter(i => i > 0 && (counts[i] as number) > 0).sort((a, b) => (counts[b] as number) - (counts[a] as number) || a - b)
    const remap = colourList.map((_, i) => i)
    if (order.length > MAX_COLOURS) {
      const keep = order.slice(0, MAX_COLOURS)
      const rgb = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]
      for (const id of order.slice(MAX_COLOURS)) {
        const a = rgb(colourList[id] as string)
        let best = keep[0] as number, bestD = Infinity
        for (const k of keep) { const b = rgb(colourList[k] as string); const d = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2; if (d < bestD) { bestD = d; best = k } }
        remap[id] = best
      }
      warnings.push({ code: 'import.colours_reduced', params: { found: order.length, kept: MAX_COLOURS } })
    }
    colourCount = Math.min(order.length, MAX_COLOURS)
    for (const i of order) slotColours.delete(colourList[i] as string)   // a colour counted once
    const spans = ranges.length > 1 ? ranges : [{ start: 0, count: triCol.length, name: '' }]
    const materialSeg = new Map<number, number>()   // colour id -> segment id
    spans.forEach((r, ri) => {
      const seen = new Set<number>()
      let hasNone = false
      for (let t = r.start; t < r.start + r.count; t++) { const c = remap[triCol[t] as number] as number; if (c === 0) hasNone = true; else seen.add(c) }
      if (seen.size === 0) return
      if (seen.size === 1 && !hasNone) {
        const colour = colourList[[...seen][0] as number] as string
        if (ranges.length > 1 && mesh.groups) mesh.groups[ri] = { ...(mesh.groups[ri] as NonNullable<Mesh['groups']>[number]), color: colour }
        else {
          const table = mesh.segments ? mesh.segments.table : [{ id: 0, name: DEFAULT_SEGMENT }]
          const first = table[0] as SegmentInfo
          mesh.segments = { labels: mesh.segments ? mesh.segments.labels : new Uint16Array(triCol.length), table: [{ ...first, color: colour }, ...table.slice(1)] }
        }
        return
      }
      if (!mesh.segments) mesh.segments = { labels: new Uint16Array(triCol.length), table: [{ id: 0, name: DEFAULT_SEGMENT }] }
      for (let t = r.start; t < r.start + r.count; t++) {
        const c = remap[triCol[t] as number] as number
        if (c === 0 || (states[t] as number) !== 0) continue   // no colour, or painted: the paint's segment stays
        let sid = materialSeg.get(c)
        if (sid === undefined) { sid = mesh.segments.table.length; materialSeg.set(c, sid); mesh.segments.table.push({ id: sid, name: `material_${materialSeg.size}`, color: colourList[c] as string }) }
        mesh.segments.labels[t] = sid
      }
    })
  }
  const prob = meshShapeProblem(mesh)
  if (prob) throw bad('invalid_mesh', { problem: prob })
  if (opts.limits) checkMeshBudget(mesh, opts.limits, 'file')
  if (split > 0) warnings.push({ code: 'import.paint_split_triangles', params: { count: split } })
  opts.signal?.throwIfAborted(); opts.onProgress?.(1)
  return { mesh, unit, objects: roots.length, paintedTriangles: painted, splitTriangles: split, colours: colourCount + slotColours.size, metadata, warnings }
}
