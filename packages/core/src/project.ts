// Project files and the Atelier's save package. Everything is built from plain bytes: nothing is sent anywhere.
//  - `saveProject` / `loadProject`: the whole editing state as one ZIP (`.amproj`): base mesh, steps, rollback marker, assets, plugin lock.
//  - `buildPackage`: the file roles the Atelier asks for (source, final, render, operations, informational measurements).
import { tick } from './progress'
import type { ProgressOptions } from './progress'
import { MeshError } from './errors'
import { sha256Hex } from './canonical'
import { payloadKindOf, payloadKinds } from './payload'
import type { PayloadLimits } from './payload'
import type { MeshLimits } from './budget'
import { measureMesh } from './measure'
import type { Registry } from './registry'
import { STORE_NAME_RE, storeProblem } from './store'
import type { ProjectStore, StoreEntry } from './store'
import { parseStepList, serializeStepList } from './stack'
import type { StepList } from './stack'
import { write3mf, write3mfCompressed } from './threemf'
import type { PaletteEntry, SlicerColours } from './threemf'
import { stripColours } from './colors'
import { writeStlBinary } from './stl'
import type { Mesh, Payload, SegmentInfo } from './types'
import { colourMapProblems } from './colours'
import { applyRenames } from './rename'
import type { ColourMap } from './colours'
import { readZip, writeZip, writeZipDeflated } from './zip'
import type { ZipLimits } from './zip'

// ------------------------------------------------------------------ the native mesh format (exact, keeps segments and groups)

const MAGIC = 'AMMESH01'

/** A mesh as bytes, without loss: positions as 64-bit floats, indices, segment labels and names, groups. */
export function encodeMesh(m: Mesh): Uint8Array {
  const nv = m.positions.length / 3, nt = m.indices.length / 3
  const head = new TextEncoder().encode(JSON.stringify({ nv, nt, segments: m.segments ? m.segments.table : null, groups: m.groups ?? null }))
  const labelBytes = m.segments ? nt * 2 : 0
  const pad = (n: number): number => (8 - (n % 8)) % 8
  const headLen = 8 + 4 + head.length
  const start = headLen + pad(headLen)
  const out = new Uint8Array(start + nv * 24 + nt * 12 + labelBytes)
  const dv = new DataView(out.buffer)
  out.set(new TextEncoder().encode(MAGIC), 0)
  dv.setUint32(8, head.length, true)
  out.set(head, 12)
  let o = start
  const pos = new DataView(out.buffer, o, nv * 24)
  for (let i = 0; i < nv * 3; i++) pos.setFloat64(i * 8, m.positions[i] as number, true)
  o += nv * 24
  const idx = new DataView(out.buffer, o, nt * 12)
  for (let i = 0; i < nt * 3; i++) idx.setUint32(i * 4, m.indices[i] as number, true)
  o += nt * 12
  if (m.segments) { const lab = new DataView(out.buffer, o, nt * 2); for (let i = 0; i < nt; i++) lab.setUint16(i * 2, m.segments.labels[i] as number, true) }
  return out
}

export function decodeMesh(bytes: Uint8Array, limits: MeshLimits = {}): Mesh {
  const bad = (reason: string): MeshError => new MeshError('import.invalid_project', { reason })
  if (bytes.length < 12 || new TextDecoder().decode(bytes.subarray(0, 8)) !== MAGIC) throw bad('not_a_mesh_file')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const hl = dv.getUint32(8, true)
  if (12 + hl > bytes.length) throw bad('truncated_header')
  let head: { nv: number; nt: number; segments: SegmentInfo[] | null; groups: Mesh['groups'] | null }
  try { head = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + hl))) as typeof head } catch { throw bad('bad_header') }
  const { nv, nt } = head
  if (!Number.isInteger(nv) || !Number.isInteger(nt) || nv < 0 || nt < 0) throw bad('bad_counts')
  if (limits.maxTriangles !== undefined && nt > limits.maxTriangles) throw new MeshError('budget.triangles', { triangles: nt, max: limits.maxTriangles, of: 'file' })
  if (limits.maxVertices !== undefined && nv > limits.maxVertices) throw new MeshError('budget.vertices', { vertices: nv, max: limits.maxVertices, of: 'file' })
  const headLen = 12 + hl
  const start = headLen + ((8 - (headLen % 8)) % 8)
  const need = start + nv * 24 + nt * 12 + (head.segments ? nt * 2 : 0)
  if (bytes.length !== need) throw bad('wrong_size')
  const positions = new Float64Array(nv * 3), indices = new Uint32Array(nt * 3)
  let o = start
  for (let i = 0; i < nv * 3; i++) positions[i] = dv.getFloat64(o + i * 8, true)
  o += nv * 24
  for (let i = 0; i < nt * 3; i++) { const v = dv.getUint32(o + i * 4, true); if (v >= nv) throw bad('index_out_of_range'); indices[i] = v }
  o += nt * 12
  const mesh: Mesh = { positions, indices }
  if (head.segments) {
    const labels = new Uint16Array(nt)
    for (let i = 0; i < nt; i++) labels[i] = dv.getUint16(o + i * 2, true)
    mesh.segments = { labels, table: head.segments }
  }
  if (head.groups) mesh.groups = head.groups
  return mesh
}

// ------------------------------------------------------------------ the project file

export interface ProjectAsset { id: string; bytes: Uint8Array }

/** One plugin a project was made with. For a package loaded from outside, enough to offer to load it again. */
export interface PluginLockEntry { id: string; version: string; fileSha256?: string; origin?: string; signed?: boolean; signer?: string }

/** A preview picture in a project: a PNG of at most 1 MB and 1024 x 1024 pixels (the standalone writes 480 x 320). */
export const PREVIEW_MAX_BYTES = 1_000_000
export const PREVIEW_MAX_SIDE = 1024
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Why these bytes are not an acceptable preview, or null. Only the signature and the header are read: the bytes are never treated as markup. */
export function previewProblem(b: Uint8Array): string | null {
  if (b.length > PREVIEW_MAX_BYTES) return 'too_large'
  if (b.length < 33 || PNG_SIGNATURE.some((v, i) => b[i] !== v)) return 'not_a_png'
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (dv.getUint32(8) !== 13 || String.fromCharCode(b[12] as number, b[13] as number, b[14] as number, b[15] as number) !== 'IHDR') return 'not_a_png'
  const w = dv.getUint32(16), h = dv.getUint32(20)
  if (w < 1 || h < 1 || w > PREVIEW_MAX_SIDE || h > PREVIEW_MAX_SIDE) return 'bad_size'
  return null
}

export interface ProjectState<B extends Payload = Mesh> {
  /** A picture of the result for lists and cards (PNG, see `previewProblem`). Optional; older projects have none. */
  preview?: Uint8Array
  /** What the packages the steps need were, when the project was saved. Entries for the plugins the steps use are added automatically. */
  plugins?: PluginLockEntry[]
  name: string
  /** The starting point of the steps: a mesh (the default type), or a drawing or another registered kind. */
  base: B | null
  list: StepList
  rollback: string | null
  assets: ProjectAsset[]
  /** The imported entries of the project store (`store.ts`): named meshes, drawings or other payloads next to the steps. Absent or empty: none. */
  store?: ProjectStore
  /** Several colours (`colours.ts`): which part goes in which filament slot. Present means the design uses colour slots; absent means the whole model is one colour. */
  colours?: ColourMap
}

export interface ProjectJson {
  format_version: 1
  name: string
  workflow: ReturnType<typeof serializeStepList>
  rollback: string | null
  base: string | null
  /** The kind of the base when it is not a mesh (`drawing`). Absent: `mesh`. */
  base_kind?: string
  assets: Array<{ id: string; file: string; sha256: string; bytes: number }>
  /** The colour slots, when the design uses them. */
  colours?: ColourMap
  /** The project store: name to the kind and the file inside the project. Absent when there is none. */
  store?: Record<string, { kind: string; file: string; personalisable?: boolean; limits?: StoreEntry['limits']; /** The file the payload was extracted from (an SVG): the single source of truth; `importer` is the version of the importer that made the payload from it. */ source?: { kind: 'svg'; file: string; mode: 'fill' | 'line'; importer: number } }>
}

const enc = new TextEncoder()

export function saveProject(s: ProjectState<Payload>): Uint8Array {
  const entries: Array<{ name: string; data: Uint8Array }> = []
  const assets: ProjectJson['assets'] = []
  const seen = new Set<string>()
  for (const a of s.assets) {
    const sha = sha256Hex(a.bytes)
    const file = `assets/${sha}.bin`
    if (!seen.has(file)) { seen.add(file); entries.push({ name: file, data: a.bytes }) }
    assets.push({ id: a.id, file, sha256: sha, bytes: a.bytes.length })
  }
  const known = new Map((s.plugins ?? []).map(e => [e.id, e]))
  const lock = new Map<string, PluginLockEntry>()
  for (const st of s.list.steps) lock.set(st.plugin.id, { ...(known.get(st.plugin.id) ?? {}), id: st.plugin.id, version: st.plugin.version })
  const baseKind = payloadKinds.get(s.base ? payloadKindOf(s.base) : 'mesh')
  const json: ProjectJson = { format_version: 1, name: s.name, workflow: serializeStepList(s.list), rollback: s.rollback, base: s.base ? `inputs/base.${baseKind.extension}` : null, ...(s.base && baseKind.id !== 'mesh' ? { base_kind: baseKind.id } : {}), assets }
  const storeJson: NonNullable<ProjectJson['store']> = {}
  for (const [name, e] of Object.entries(s.store ?? {})) {
    if (!STORE_NAME_RE.test(name)) throw new MeshError('store.bad_name', { name })
    const kind = payloadKinds.get(payloadKindOf(e.payload))
    const file = `store/${name}.${kind.extension}`
    entries.push({ name: file, data: kind.encode(e.payload) })
    const src = e.source ? { kind: e.source.kind, file: `store/${name}.${e.source.kind}`, mode: e.source.mode, importer: e.source.importer } : undefined
    if (e.source && src) entries.push({ name: src.file, data: enc.encode(e.source.text) })
    storeJson[name] = { kind: kind.id, file, ...(src ? { source: src } : {}), ...(e.personalisable ? { personalisable: true } : {}), ...(e.limits ? { limits: e.limits } : {}) }
  }
  if (Object.keys(storeJson).length > 0) json.store = storeJson
  if (s.colours) json.colours = { slots: s.colours.slots.map(x => ({ id: x.id, name: x.name, parts: [...x.parts], ...(x.personalisable ? { personalisable: true } : {}), ...(x.color ? { color: x.color } : {}) })) }
  entries.unshift({ name: 'project.json', data: enc.encode(JSON.stringify(json, null, 1)) })
  entries.push({ name: 'plugins.lock.json', data: enc.encode(JSON.stringify([...lock.values()], null, 1)) })
  if (s.base) entries.push({ name: `inputs/base.${baseKind.extension}`, data: baseKind.encode(s.base) })
  if (s.preview) {
    const why = previewProblem(s.preview)
    if (why) throw new MeshError('export.invalid_preview', { reason: why })
    entries.push({ name: 'preview.png', data: s.preview })
  }
  return writeZip(entries)
}

export interface LoadedProject<B extends Payload = Mesh> extends ProjectState<B> {
  /** What plugins the project was made with (from plugins.lock.json). */
  lock: PluginLockEntry[]
  /** Plugins the steps need that are not installed, and installed ones whose version differs from the one the project was saved with. */
  missingPlugins: string[]
  /** Steps whose plugin id was rewritten because the plugin was renamed: the step, the id it was saved with and the id it has now. */
  renamedPlugins: Array<{ id: string; from: string; to: string }>
  versionDiffs: Array<{ id: string; saved: string; installed: string }>
  /**
   * Which steps use which asset: for every asset id a step refers to (an asset parameter, or any text parameter equal to the id of an asset the project carries),
   * the steps and parameters that use it, and whether the project carries the bytes (`inProject`). A host that has no store for assets refuses only the
   * ones with `inProject: true` that a step uses.
   */
  assetUse: AssetUse[]
  /** Fonts the steps use that the host does not know (needs `fonts`): they would fail at run time. The host can refuse, map or ask for them. */
  missingFonts: AssetUse[]
}

export interface AssetUse { id: string; inProject: boolean; used: Array<{ step: string; param: string }> }

export interface LoadProjectFonts {
  /** The font ids the host can serve (a list or a test). */
  known: readonly string[] | ((id: string) => boolean)
  /** Maps an id the project names to one the host knows, for example `roboto-regular` to `font:Roboto`; return undefined to leave it. The steps of the loaded project are rewritten. */
  alias?: (id: string) => string | undefined
}

export async function loadProject<B extends Payload = Mesh>(bytes: Uint8Array, opts: { limits?: PayloadLimits; zip?: ZipLimits; registry?: Registry; fonts?: LoadProjectFonts; /** The kinds of base this host accepts (default `['mesh']`); a project with another kind is refused, so a mesh-only host never gets a drawing. */ baseKinds?: readonly string[]; /** The kinds of entry in the project store this host accepts (default: the same as `baseKinds`). */ storeKinds?: readonly string[] } & ProgressOptions = {}): Promise<LoadedProject<B>> {
  const bad = (reason: string, extra: Record<string, unknown> = {}): MeshError => new MeshError('import.invalid_project', { reason, ...extra })
  opts.signal?.throwIfAborted(); opts.onProgress?.(0.02); await tick()
  const files = new Map((await readZip(bytes, opts.zip)).map(e => [e.name, e.data]))
  opts.signal?.throwIfAborted(); opts.onProgress?.(0.5); await tick()
  const raw = files.get('project.json')
  if (!raw) throw bad('missing_project_json')
  let json: ProjectJson
  try { json = JSON.parse(new TextDecoder().decode(raw)) as ProjectJson } catch { throw bad('bad_project_json') }
  if (json.format_version !== 1) throw bad('unsupported_format_version', { found: (json as { format_version?: unknown }).format_version ?? null })
  const wf = parseStepList(json.workflow)
  if (!wf.ok || !wf.value) throw bad('bad_workflow', { issues: wf.errors })
  const assets: ProjectAsset[] = []
  for (const a of json.assets ?? []) {
    const data = files.get(a.file)
    if (!data) throw bad('missing_asset', { id: a.id })
    if (sha256Hex(data) !== a.sha256) throw bad('asset_hash_mismatch', { id: a.id })
    assets.push({ id: a.id, bytes: data })
  }
  let base: B | null = null
  if (json.base) {
    const b = files.get(json.base)
    if (!b) throw bad('missing_base')
    const kindId = json.base_kind ?? 'mesh'
    if (!payloadKinds.has(kindId)) throw bad('unknown_base_kind', { kind: kindId })
    if (!(opts.baseKinds ?? ['mesh']).includes(kindId)) throw bad('base_kind_not_allowed', { kind: kindId })
    const kind = payloadKinds.get(kindId)
    base = kind.decode(b, opts.limits ?? {}) as B; opts.onProgress?.(0.9)
    if (opts.limits) kind.budget(base, opts.limits, 'file')
  }
  let store: ProjectStore | undefined
  if (json.store !== undefined) {
    if (typeof json.store !== 'object' || json.store === null || Array.isArray(json.store)) throw bad('bad_store')
    const allowed = opts.storeKinds ?? opts.baseKinds ?? ['mesh']
    store = {}
    for (const [name, rec] of Object.entries(json.store)) {
      if (!STORE_NAME_RE.test(name)) throw bad('bad_store_name', { name })
      const kindId = typeof rec?.kind === 'string' ? rec.kind : ''
      if (!payloadKinds.has(kindId)) throw bad('unknown_store_kind', { name, kind: kindId })
      if (!allowed.includes(kindId)) throw bad('store_kind_not_allowed', { name, kind: kindId })
      const data = typeof rec.file === 'string' ? files.get(rec.file) : undefined
      if (!data) throw bad('missing_store_file', { name })
      const kind = payloadKinds.get(kindId)
      const payload = kind.decode(data, opts.limits ?? {})
      if (opts.limits) kind.budget(payload, opts.limits, 'file')
      const lim = rec.limits && typeof rec.limits === 'object' ? Object.fromEntries(['maxPaths', 'maxPoints', 'maxTriangles', 'maxVertices'].filter(k => Number.isFinite((rec.limits as Record<string, unknown>)[k])).map(k => [k, (rec.limits as Record<string, unknown>)[k]])) as StoreEntry['limits'] : undefined
      let source: StoreEntry['source']
      if (rec.source !== undefined) {
        const rs = rec.source as { kind?: unknown; file?: unknown; mode?: unknown; importer?: unknown }
        const text = typeof rs.file === 'string' ? files.get(rs.file) : undefined
        if (rs.kind !== 'svg' || !text || (rs.mode !== 'fill' && rs.mode !== 'line') || !Number.isInteger(rs.importer)) throw bad('bad_store_source', { name })
        source = { kind: 'svg', text: new TextDecoder().decode(text), mode: rs.mode, importer: rs.importer as number }
      }
      store[name] = { payload, ...(source ? { source } : {}), ...(rec.personalisable === true ? { personalisable: true } : {}), ...(lim && Object.keys(lim).length > 0 ? { limits: lim } : {}) }
    }
    const why = storeProblem(store, opts.limits ?? {})
    if (why) throw bad('bad_store', { problem: why })
    if (Object.keys(store).length === 0) store = undefined
  }
  // the colour slots (several filaments): checked for shape and for what `colourMapProblems` says that cannot be used at all; the host's limit on slots is the host's to apply
  let colours: ColourMap | undefined
  if (json.colours !== undefined) {
    const c = json.colours as { slots?: unknown }
    if (!c || typeof c !== 'object' || !Array.isArray(c.slots)) throw bad('bad_colours')
    const slots: ColourMap['slots'] = []
    for (const raw of c.slots as unknown[]) {
      const x = raw as { id?: unknown; name?: unknown; parts?: unknown; personalisable?: unknown; color?: unknown }
      if (x && x.color !== undefined && (typeof x.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(x.color))) throw bad('bad_colours')
      if (!x || typeof x.id !== 'string' || typeof x.name !== 'string' || x.name.length > 60 || !Array.isArray(x.parts) || x.parts.length > 500 || x.parts.some(q => typeof q !== 'string' || q.length > 60)) throw bad('bad_colours')
      slots.push({ id: x.id, name: x.name, parts: x.parts as string[], ...(x.personalisable === true ? { personalisable: true } : {}), ...(typeof x.color === 'string' ? { color: x.color.toLowerCase() } : {}) })
    }
    const map: ColourMap = { slots }
    const problem = colourMapProblems(map, { maxColours: 1000 }).find(q => q.code !== 'colours.too_many')
    if (problem) throw bad('bad_colours', { problem })
    colours = map  }
  const rollback = typeof json.rollback === 'string' && wf.value.steps.some(s => s.id === json.rollback) ? json.rollback : null
  // a step saved under the id of a plugin that was renamed gets the new id here, so the editor shows the plugin that will run it
  const renamedSteps = opts.registry ? applyRenames(wf.value, opts.registry) : { list: wf.value, renamed: [] as Array<{ id: string; from: string; to: string }> }
  const missingPlugins: string[] = [], versionDiffs: LoadedProject['versionDiffs'] = []
  if (opts.registry) {
    for (const st of renamedSteps.list.steps) {
      const have = opts.registry.manifest(st.plugin.id)
      if (!have) { if (!missingPlugins.includes(st.plugin.id)) missingPlugins.push(st.plugin.id) }
      else if (have.version !== st.plugin.version && !versionDiffs.some(v => v.id === st.plugin.id)) versionDiffs.push({ id: st.plugin.id, saved: st.plugin.version, installed: have.version })
    }
  }
  // assets and fonts the steps use
  let list = renamedSteps.list
  const carried = new Set(assets.map(a => a.id))
  const fontParam = (st: { plugin: { id: string }; op: string }, name: string): 'font' | 'asset' | null => {
    const prm = opts.registry?.operation(st.plugin.id, st.op)?.op.params.find(x => x.name === name)
    return prm && prm.type === 'asset' ? (prm.widget === 'font' || (prm.accept ?? []).includes('font') ? 'font' : 'asset') : null
  }
  if (opts.fonts?.alias) {
    const alias = opts.fonts.alias
    list = { ...list, steps: list.steps.map(st => {
      let changed = false
      const params: Record<string, unknown> = { ...st.params }
      for (const [k, v] of Object.entries(params)) if (typeof v === 'string' && fontParam(st, k) === 'font' && !carried.has(v)) { const to = alias(v); if (to !== undefined && to !== v) { params[k] = to; changed = true } }
      return changed ? { ...st, params } : st
    }) }
  }
  const uses = new Map<string, AssetUse>(), fontUses = new Map<string, AssetUse>()
  const isKnown = (id: string): boolean => (opts.fonts ? (typeof opts.fonts.known === 'function' ? opts.fonts.known(id) : opts.fonts.known.includes(id)) : true)
  for (const st of list.steps) for (const [k, v] of Object.entries(st.params ?? {})) {
    if (typeof v !== 'string' || v === '') continue
    const kind = fontParam(st, k)
    if (kind === null && !carried.has(v)) continue
    const u = uses.get(v) ?? { id: v, inProject: carried.has(v), used: [] }
    u.used.push({ step: st.id, param: k }); uses.set(v, u)
    if (kind === 'font' && !carried.has(v) && !isKnown(v)) { const f = fontUses.get(v) ?? { id: v, inProject: false, used: [] }; f.used.push({ step: st.id, param: k }); fontUses.set(v, f) }
  }
  let lock: PluginLockEntry[] = []
  const lockFile = files.get('plugins.lock.json')
  if (lockFile) { try { const v = JSON.parse(new TextDecoder().decode(lockFile)) as unknown; if (Array.isArray(v)) lock = v.filter((e): e is PluginLockEntry => typeof e === 'object' && e !== null && typeof (e as PluginLockEntry).id === 'string' && typeof (e as PluginLockEntry).version === 'string') } catch { /* an unreadable lock only means no offer to load */ } }
  // a preview that is missing or not acceptable is simply left out: it is only a picture
  const pv = files.get('preview.png') ?? files.get('thumbnail.png')
  const preview = pv && previewProblem(pv) === null ? pv : undefined
  opts.onProgress?.(1)
  return { name: String(json.name ?? ''), base, list, rollback, assets, ...(store ? { store } : {}), ...(colours ? { colours } : {}), missingPlugins, renamedPlugins: renamedSteps.renamed, versionDiffs, lock, assetUse: [...uses.values()], missingFonts: [...fontUses.values()], ...(preview ? { preview } : {}) }
}

// ------------------------------------------------------------------ the Atelier's save package

export interface PackageInput {
  /** The model as the customer first gave it. Written untouched as `source.stl`. */
  source: Mesh
  /** The model after all steps. */
  final: Mesh
  steps: StepList
  /** PNG bytes of the rendered view. */
  render?: Uint8Array
  /** Segment to colour and extruder for the final 3MF. */
  palette?: PaletteEntry[]
  /** Also write `final.stl`, for servers that cannot read 3MF yet. */
  stl?: boolean
  title?: string
  /**
   * What `final.3mf` says about colour. Default `inline_sidecar` (colours and paint, as before). `none`: geometry only: no colours, no paint, no extruder numbers,
   * which is what a one-filament shop wants. Any other value is passed to `write3mf`.
   */
  slicer?: SlicerColours
  /**
   * The slicer `final.3mf` is for, set by the host: `prusa` (PrusaSlicer and EasyPrint) or `bambu` (Bambu Studio). It replaces `slicer` and is passed to `write3mf`, which says what
   * each writes (docs/3mf-colour.md section 4c). Not set: `slicer` decides, as before. Ignored when `slicer` is `none` (geometry only).
   */
  target?: 'prusa' | 'bambu'
}

function packageFiles(p: PackageInput, final3mf: Uint8Array | null): Array<{ name: string; data: Uint8Array }> {
  const m = measureMesh(p.final)
  const slicer = p.slicer ?? 'inline_sidecar'
  const geometryOnly = slicer === 'none'
  const files: Array<{ name: string; data: Uint8Array }> = [
    { name: 'source.stl', data: writeStlBinary(p.source) },
    { name: 'final.3mf', data: final3mf ?? write3mf(geometryOnly ? stripColours(p.final) : p.final, threemfOptions(p, slicer, geometryOnly)).bytes },
  ]
  if (p.stl) files.push({ name: 'final.stl', data: writeStlBinary(p.final) })
  if (p.render) files.push({ name: 'render.png', data: p.render })
  files.push({ name: 'operations.json', data: enc.encode(JSON.stringify(serializeStepList(p.steps), null, 1)) })
  files.push({ name: 'measure.json', data: enc.encode(JSON.stringify({ informational: true, note: 'Measured in the browser. The server measures again and prices from its own numbers.', triangles: m.triangles, size_mm: m.size, volume_mm3: m.volume, surface_area_mm2: m.surfaceArea, watertight: m.watertight }, null, 1)) })
  return files
}

const threemfOptions = (p: PackageInput, slicer: SlicerColours, geometryOnly: boolean): Parameters<typeof write3mf>[1] => ({ ...(p.title ? { title: p.title } : {}), ...(p.palette && !geometryOnly ? { palette: p.palette } : {}), slicer, ...(p.target && !geometryOnly ? { target: p.target } : {}) })

/** Files named as in the Atelier's vision document: source.stl, final.3mf (and final.stl), render.png, operations.json, measure.json. Everything is stored uncompressed. */
export function buildPackage(p: PackageInput): Uint8Array { return writeZip(packageFiles(p, null)) }

/**
 * The same package with `final.3mf` deflated (about a quarter of the size for a big mesh, the way slicers write it) and the other files deflated where that helps.
 * The server's reader has to inflate (every ordinary ZIP reader does). Needs `CompressionStream`.
 */
export async function buildPackageCompressed(p: PackageInput): Promise<Uint8Array> {
  const slicer = p.slicer ?? 'inline_sidecar', geometryOnly = slicer === 'none'
  const final3mf = (await write3mfCompressed(geometryOnly ? stripColours(p.final) : p.final, threemfOptions(p, slicer, geometryOnly))).bytes
  return writeZipDeflated(packageFiles(p, final3mf))
}
