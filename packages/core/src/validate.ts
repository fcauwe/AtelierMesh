// Validation: of manifests and of the parameters of a step. Pure functions of their input.
// Min and max are security limits, not only UI hints: the same rules are exported as JSON Schema (jsonschema.ts)
// so a server can enforce them with any standard validator.
import { parseExpr, exprIdentifiers } from './expr'
import { badLimitsField, checkPlacementLimits, isPlacement } from './placement'
import type { PlacementValue } from './placement'
import { MeshError } from './errors'
import type { StructuredError } from './errors'
import { canonicalJson } from './canonical'
import { imagePathOk } from './imageinfo'
import { ICON_NAME_RE, IMPORTANCES, MAX_SHAPES, SHAPE_PATH_RE, OPERATION_IMPORTANCES, optionValues, PARAM_TYPES, WIDGETS_FOR } from './manifest'
import type { Manifest, Operation, ParamDef } from './manifest'

export interface ValidationResult<T> {
  ok: boolean
  errors: StructuredError[]
  value: T
}

export const ID_RE = /^[a-z][a-z0-9_]*$/
export const PLUGIN_ID_RE = /^[a-z0-9]+(\.[a-z0-9][a-z0-9_-]*)+$/
/** The name of an entry in the project store, and a kind word (`mesh`, `drawing`, ...). */
export const STORE_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/
const PAYLOAD_KIND_RE = STORE_NAME_RE
export const SEGMENT_NAME_RE = /^[a-z][a-z0-9_]*$/
export const SEGMENT_OR_EMPTY_SOURCE = '^([a-z][a-z0-9_]{0,39})?$'
/** The name of a part a step picks: any readable text up to 120 characters (a body keeps the name its file gave it, like "Part 6" or "Lid (left)"). */
export const PART_NAME_SOURCE = '^[^\\u0000-\\u001f]{1,120}$'
const PART_NAME_RE = new RegExp(PART_NAME_SOURCE, 'u')
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const OPERATION_KINDS = ['generator', 'modifier', 'analyzer', 'exporter']

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

// ------------------------------------------------------------------ one parameter value

/** Check one value against its definition. Returns the first problem, or null. */
export function checkValue(p: ParamDef, v: unknown): StructuredError | null {
  switch (p.type) {
    case 'bool':
      return typeof v === 'boolean' ? null : { code: 'param.type', params: { expected: 'boolean' } }
    case 'int':
      if (typeof v !== 'number' || !Number.isInteger(v)) return { code: 'param.type', params: { expected: 'integer' } }
      return range(v, p.min, p.max)
    case 'float':
    case 'angle':
      if (!num(v)) return { code: 'param.type', params: { expected: 'number' } }
      return range(v, p.min, p.max)
    case 'string': {
      if (typeof v !== 'string') return { code: 'param.type', params: { expected: 'string' } }
      const len = [...v].length // code points, not UTF-16 units
      if (p.min_length !== undefined && len < p.min_length) return { code: 'param.too_short', params: { min_length: p.min_length, length: len } }
      if (p.max_length !== undefined && len > p.max_length) return { code: 'param.too_long', params: { max_length: p.max_length, length: len } }
      if (p.pattern !== undefined && !new RegExp(p.pattern, 'u').test(v)) return { code: 'param.pattern', params: { pattern: p.pattern } }
      return null
    }
    case 'enum': {
      if (typeof v !== 'string') return { code: 'param.type', params: { expected: 'string' } }
      const options = optionValues(p)
      return options.includes(v) ? null : { code: 'param.not_enum', params: { options } }
    }
    case 'vector': {
      if (!Array.isArray(v) || v.length !== p.size) return { code: 'param.length', params: { expected: p.size, length: Array.isArray(v) ? v.length : null } }
      for (let i = 0; i < v.length; i++) {
        const x: unknown = v[i]
        if (!num(x)) return { code: 'param.type', params: { expected: 'number', index: i } }
        const r = range(x, p.min, p.max)
        if (r) return { ...r, params: { ...r.params, index: i } }
      }
      return null
    }
    case 'asset':
      return v === null || (typeof v === 'string' && v.length > 0) ? null : { code: 'param.type', params: { expected: 'asset id (non-empty string) or null' } }
    case 'payload':
      return v === null || (typeof v === 'string' && STORE_NAME_RE.test(v)) ? null : { code: 'param.type', params: { expected: 'store name or null' } }
    case 'placement':
      return checkPlacement(v)
    case 'range': {
      if (!Array.isArray(v) || v.length !== 2) return { code: 'param.length', params: { expected: 2, length: Array.isArray(v) ? v.length : null } }
      for (let i = 0; i < 2; i++) {
        if (!num(v[i])) return { code: 'param.type', params: { expected: 'number', index: i } }
        const r = range(v[i] as number, p.min, p.max)
        if (r) return { ...r, params: { ...r.params, index: i } }
      }
      return (v[0] as number) <= (v[1] as number) ? null : { code: 'param.invalid', params: { field: 'low_above_high' } }
    }
    case 'selection': return checkSelection(v)
    case 'color': {
      if (typeof v !== 'string') return { code: 'param.type', params: { expected: 'colour string like #aabbcc' } }
      if (!(p.alpha ? /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/ : /^#[0-9a-fA-F]{6}$/).test(v)) return { code: 'param.pattern', params: { pattern: p.alpha ? '#rrggbb or #rrggbbaa' : '#rrggbb' } }
      if (p.only_palette && p.palette && !p.palette.some(c => c.toLowerCase() === v.toLowerCase())) return { code: 'param.not_enum', params: { options: p.palette } }
      return null
    }
    case 'object': {
      if (!isObject(v)) return { code: 'param.type', params: { expected: 'object' } }
      const known = new Set(p.fields.map(f => f.name))
      for (const k of Object.keys(v)) if (!known.has(k)) return { code: 'param.unknown', params: { name: k } }
      for (const f of p.fields) {
        if (!(f.name in v) || v[f.name] === undefined) continue
        const e = checkValue(f, v[f.name])
        if (e) return { ...e, params: { ...(e.params ?? {}), field: e.params?.['field'] ? `${f.name}.${String(e.params['field'])}` : f.name } }
      }
      return null
    }
    case 'list': {
      if (!Array.isArray(v)) return { code: 'param.type', params: { expected: 'array' } }
      if (p.min_items !== undefined && v.length < p.min_items) return { code: 'param.too_few_items', params: { min_items: p.min_items, length: v.length } }
      if (p.max_items !== undefined && v.length > p.max_items) return { code: 'param.too_many_items', params: { max_items: p.max_items, length: v.length } }
      for (let i = 0; i < v.length; i++) {
        const row: unknown = v[i]
        if (!isObject(row)) return { code: 'param.type', params: { expected: 'object', index: i } }
        const known = new Set(p.item.map(f => f.name))
        for (const k of Object.keys(row)) if (!known.has(k)) return { code: 'param.unknown', params: { name: k, index: i } }
        for (const f of p.item) {
          if (!(f.name in row) || row[f.name] === undefined) continue          // a missing field takes its default
          const e = checkValue(f, row[f.name])
          if (e) return { ...e, params: { ...(e.params ?? {}), index: i, field: e.params?.['field'] ? `${f.name}.${String(e.params['field'])}` : f.name } }
        }
      }
      return null
    }
    case 'part': {
      if (typeof v !== 'string') return { code: 'param.type', params: { expected: 'string' } }
      const both = !p.kinds || p.kinds.length > 1
      const m = /^(?:(segment|group):)?(.*)$/.exec(v) as RegExpExecArray
      const name = both ? (m[2] as string) : v
      const bad = v === '' ? p.allow_empty === false : (!both && /^(segment|group):/.test(v)) || !PART_NAME_RE.test(name) || /^[a-z][a-z0-9_]*:/.test(name)
      if (bad) return { code: 'param.pattern', params: { pattern: PART_NAME_SOURCE } }
      return null
    }
  }
}

function range(v: number, min?: number, max?: number): StructuredError | null {
  if ((min !== undefined && v < min) || (max !== undefined && v > max)) return { code: 'param.out_of_range', params: { value: v, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) } }
  return null
}

function vec(v: unknown, n: number): v is number[] {
  return Array.isArray(v) && v.length === n && v.every(num)
}

function checkSelection(v: unknown): StructuredError | null {
  if (v === null) return null
  const bad = (field: string): StructuredError => ({ code: 'param.invalid', params: { field } })
  if (!isObject(v)) return { code: 'param.type', params: { expected: 'selection object or null' } }
  if (v['mode'] !== 'include' && v['mode'] !== 'exclude') return bad('mode')
  if (v['basis'] !== undefined && typeof v['basis'] !== 'string') return bad('basis')
  const runs = v['triangles']
  if (!Array.isArray(runs)) return bad('triangles')
  let end = 0
  for (const r of runs as unknown[]) {
    if (!Array.isArray(r) || r.length !== 2 || !Number.isInteger(r[0]) || !Number.isInteger(r[1]) || (r[0] as number) < end || (r[1] as number) < 1) return bad('triangles')
    end = (r[0] as number) + (r[1] as number)
  }
  return null
}

function checkPlacement(v: unknown): StructuredError | null {
  if (v === null) return null
  const bad = (field: string): StructuredError => ({ code: 'param.invalid', params: { field } })
  if (!isObject(v)) return { code: 'param.type', params: { expected: 'placement object or null' } }
  const a = v['anchor']
  if (!isObject(a)) return bad('anchor')
  if (!vec(a['point'], 3)) return bad('anchor.point')
  if (!vec(a['normal'], 3)) return bad('anchor.normal')
  if (a['tri'] !== undefined && !(typeof a['tri'] === 'number' && Number.isInteger(a['tri']) && a['tri'] >= 0)) return bad('anchor.tri')
  if (a['bary'] !== undefined && !vec(a['bary'], 3)) return bad('anchor.bary')
  if (a['fingerprint'] !== undefined && typeof a['fingerprint'] !== 'string') return bad('anchor.fingerprint')
  if (v['up_ref'] !== undefined && !['x', 'y', 'z'].includes(v['up_ref'] as string)) return bad('up_ref')
  if (v['direction'] !== undefined && !(num(v['direction']) && v['direction'] >= -180 && v['direction'] <= 180)) return bad('direction')
  if (v['offset'] !== undefined && !vec(v['offset'], 2)) return bad('offset')
  const badLimits = badLimitsField(v['limits'])
  if (badLimits) return bad(badLimits)
  const al = v['align']
  if (al !== undefined && !(isObject(al) && ['left', 'center', 'right'].includes(al['h'] as string) && ['baseline', 'middle'].includes(al['v'] as string))) return bad('align')
  return null
}

// ------------------------------------------------------------------ parameters of a step

export interface ParamOptions {
  /** `designer` may change everything. `customer` may change only parameters that are personalisable (and handed over by the step). */
  role?: 'designer' | 'customer'
  /** For the customer role: the designer's stored values to compare against. */
  base?: Record<string, unknown>
  /** For the customer role: the step's own list of parameters it hands over (a subset of the personalisable ones). */
  personalisableParams?: string[]
  /** For the customer role: limits on the text of string parameters (lines, characters per line). */
  textLimits?: Record<string, { max_lines?: number; max_line_length?: number }>
  /** Fill missing parameters with their defaults (default true). */
  fillDefaults?: boolean
}

export function validateParams(op: Operation, params: unknown, opts: ParamOptions = {}): ValidationResult<Record<string, unknown>> {
  const errors: StructuredError[] = []
  const value: Record<string, unknown> = {}
  if (!isObject(params)) return { ok: false, errors: [{ code: 'param.type', params: { expected: 'object' }, path: 'params' }], value }
  const known = new Map(op.params.map(p => [p.name, p]))
  for (const k of Object.keys(params)) if (!known.has(k)) errors.push({ code: 'param.unknown', params: { name: k }, path: `params.${k}` })
  for (const p of op.params) {
    const given = Object.prototype.hasOwnProperty.call(params, p.name) && params[p.name] !== undefined
    if (!given) { if (opts.fillDefaults !== false) value[p.name] = p.default; continue }
    const e = checkValue(p, params[p.name])
    if (e) errors.push({ ...e, path: `params.${p.name}` })
    else value[p.name] = params[p.name]
  }
  if (opts.role === 'customer') {
    if (!opts.base) errors.push({ code: 'param.invalid', params: { reason: 'customer validation needs the designer values' }, path: 'params' })
    else {
      const has = (name: string, part?: string): boolean => opts.personalisableParams === undefined || opts.personalisableParams.includes(name) || (part !== undefined && opts.personalisableParams.includes(`${name}.${part}`))
      const allowed = new Set(op.params.filter(p => p.personalisable === true && has(p.name)).map(p => p.name))
      for (const p of op.params) {
        const mine = Object.prototype.hasOwnProperty.call(value, p.name) ? value[p.name] : p.default
        const theirs = Object.prototype.hasOwnProperty.call(opts.base, p.name) ? opts.base[p.name] : p.default
        const changed = canonicalJson(mine) !== canonicalJson(theirs)
        // a placement can be opened as a whole, or only its position or only its direction
        let open = allowed.has(p.name)
        if (!open && changed && p.type === 'placement' && p.personalisable === true && isPlacement(mine) && isPlacement(theirs)) {
          const pos = has(p.name, 'position'), dir = has(p.name, 'direction')
          if (pos || dir) {
            const masked: PlacementValue = { ...mine }
            if (pos) { masked.anchor = theirs.anchor; if (theirs.offset !== undefined) masked.offset = theirs.offset; else delete masked.offset }
            if (dir) { if (theirs.direction !== undefined) masked.direction = theirs.direction; else delete masked.direction }
            // whatever the open parts do not cover must be unchanged
            open = canonicalJson(masked) === canonicalJson(theirs)
          }
        }
        if (changed && !open) errors.push({ code: 'param.not_editable', params: { name: p.name }, path: `params.${p.name}` })
        // the designer's limits on a placement bind the customer
        if (p.type === 'placement' && open && isPlacement(mine) && isPlacement(theirs) && changed) {
          const sizeName = theirs.limits?.size_param ?? 'size'
          const sizeValue = typeof value[sizeName] === 'number' ? (value[sizeName] as number) : undefined
          for (const e of checkPlacementLimits(theirs, mine, sizeValue)) errors.push({ ...e, path: `params.${p.name}` })
        }
        // the designer's limits on a text bind the customer
        const tl = opts.textLimits?.[p.name]
        if (tl && p.type === 'string' && typeof mine === 'string') {
          const lines = mine.split('\n')
          if (tl.max_lines !== undefined && lines.length > tl.max_lines) errors.push({ code: 'param.too_many_lines', params: { max_lines: tl.max_lines, lines: lines.length }, path: `params.${p.name}` })
          if (tl.max_line_length !== undefined) {
            const longest = Math.max(...lines.map(l => [...l].length))
            if (longest > tl.max_line_length) errors.push({ code: 'param.line_too_long', params: { max_line_length: tl.max_line_length, length: longest }, path: `params.${p.name}` })
          }
        }
      }
      // a limit on the size also holds when the customer changes the size and leaves the placement alone
      for (const p of op.params) {
        const base = Object.prototype.hasOwnProperty.call(opts.base, p.name) ? opts.base[p.name] : p.default
        if (p.type === 'placement' && isPlacement(base) && base.limits?.size) {
          const sizeName = base.limits.size_param ?? 'size'
          const v = value[sizeName]
          const lim = base.limits.size
          if (typeof v === 'number' && (v < lim[0] - 1e-9 || v > lim[1] + 1e-9) && !errors.some(e => e.code === 'placement.size_out_of_range')) errors.push({ code: 'placement.size_out_of_range', params: { size: v, min: lim[0], max: lim[1] }, path: `params.${sizeName}` })
        }
      }
    }
  }
  return { ok: errors.length === 0, errors, value }
}

// ------------------------------------------------------------------ manifests

// ---- the plugin's metadata: licence, description, contact, package address
const LICENSE_RE = /^[A-Za-z0-9.+\- ]+$/
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/
const EMAIL_RE = /^[^\s@<>"'()[\],;:\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/

/** True for an email address of the shape a manifest's `contact.email` may have (what the plugin manager builds a mailto link from). */
export function isValidEmail(v: unknown): v is string { return typeof v === 'string' && v.length <= 120 && EMAIL_RE.test(v) }

/** Why a text is not an acceptable https address, or null when it is one: https only, no user name or password in it, a real host name, within `max` characters. */
export function httpsUrlProblem(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return 'not_text'
  if (v.length === 0) return 'empty'
  if (v.length > max) return 'too_long'
  if (CONTROL_RE.test(v) || /\s/.test(v)) return 'bad_characters'
  let u: URL
  try { u = new URL(v) } catch { return 'not_a_url' }
  if (u.protocol !== 'https:') return 'not_https'
  if (u.username !== '' || u.password !== '') return 'has_credentials'
  if (!u.hostname.includes('.')) return 'bad_host'
  return null
}

/** The problems of the metadata fields of a manifest, as structured errors. `require` also asks for licence and description. */
export function manifestMetadataProblems(m: Record<string, unknown>, require: boolean): StructuredError[] {
  const out: StructuredError[] = []
  const fail = (code: string, path: string, params: Record<string, unknown> = {}): void => { out.push({ code, params, path }) }
  const lic = m['license']
  if (lic === undefined || lic === null) { if (require) fail('manifest.missing_license', 'license') }
  else if (typeof lic !== 'string') fail('manifest.bad_license', 'license', { reason: 'not_text' })
  else if (lic.length === 0 || lic.trim().length === 0) { if (require) fail('manifest.missing_license', 'license'); else fail('manifest.bad_license', 'license', { reason: 'empty' }) }
  else if (lic.length > 64) fail('manifest.bad_license', 'license', { reason: 'too_long', max: 64 })
  else if (!LICENSE_RE.test(lic)) fail('manifest.bad_license', 'license', { reason: 'bad_characters' })
  const desc = m['description']
  if (desc === undefined || desc === null) { if (require) fail('manifest.missing_description', 'description') }
  else if (typeof desc !== 'string') fail('manifest.bad_description', 'description', { reason: 'not_text' })
  else if (CONTROL_RE.test(desc)) fail('manifest.bad_description', 'description', { reason: 'bad_characters' })
  else if (desc.trim().length === 0) { if (require) fail('manifest.missing_description', 'description'); else fail('manifest.bad_description', 'description', { reason: 'too_short', min: 10 }) }
  else if (desc.trim().length < 10) fail('manifest.bad_description', 'description', { reason: 'too_short', min: 10 })
  else if (desc.length > 300) fail('manifest.bad_description', 'description', { reason: 'too_long', max: 300 })
  const c = m['contact']
  if (c !== undefined) {
    if (!isObject(c)) fail('manifest.bad_contact', 'contact', { field: 'contact', reason: 'not_an_object' })
    else {
      for (const k of Object.keys(c)) if (k !== 'url' && k !== 'email' && k !== 'name') fail('manifest.bad_contact', `contact.${k}`, { field: k, reason: 'unknown_field' })
      if (c['url'] !== undefined) { const r = httpsUrlProblem(c['url'], 200); if (r) fail('manifest.bad_contact', 'contact.url', { field: 'url', reason: r }) }
      if (c['email'] !== undefined) {
        const e = c['email']
        if (typeof e !== 'string') fail('manifest.bad_contact', 'contact.email', { field: 'email', reason: 'not_text' })
        else if (e.length > 120) fail('manifest.bad_contact', 'contact.email', { field: 'email', reason: 'too_long' })
        else if (!EMAIL_RE.test(e)) fail('manifest.bad_contact', 'contact.email', { field: 'email', reason: 'not_an_email' })
      }
      if (c['name'] !== undefined) {
        const n = c['name']
        if (typeof n !== 'string') fail('manifest.bad_contact', 'contact.name', { field: 'name', reason: 'not_text' })
        else if (n.trim().length === 0) fail('manifest.bad_contact', 'contact.name', { field: 'name', reason: 'empty' })
        else if (n.length > 80) fail('manifest.bad_contact', 'contact.name', { field: 'name', reason: 'too_long' })
        else if (CONTROL_RE.test(n)) fail('manifest.bad_contact', 'contact.name', { field: 'name', reason: 'bad_characters' })
      }
    }
  }
  const us = m['uses']
  if (us !== undefined) {
    if (!Array.isArray(us)) fail('manifest.bad_uses', 'uses', { reason: 'not_a_list' })
    else if (us.length > 4) fail('manifest.bad_uses', 'uses', { reason: 'too_many' })
    else us.forEach((u, i) => { if (u !== 'fonts') fail('manifest.bad_uses', `uses.${i}`, { reason: 'unknown_service', value: typeof u === 'string' ? u.slice(0, 40) : String(typeof u) }) })
  }
  const rp = m['replaces']
  if (rp !== undefined) {
    if (!Array.isArray(rp)) fail('manifest.bad_replaces', 'replaces', { reason: 'not_a_list' })
    else if (rp.length > 8) fail('manifest.bad_replaces', 'replaces', { reason: 'too_many' })
    else rp.forEach((x, i) => {
      if (typeof x !== 'string' || x.length > 100 || !PLUGIN_ID_RE.test(x)) fail('manifest.bad_replaces', `replaces.${i}`, { reason: 'bad_id' })
      else if (x === m['id']) fail('manifest.bad_replaces', `replaces.${i}`, { reason: 'itself', value: x })
      else if (rp.indexOf(x) !== i) fail('manifest.bad_replaces', `replaces.${i}`, { reason: 'twice', value: x })
    })
  }
  const pu = m['package_url']
  if (pu !== undefined) { const r = httpsUrlProblem(pu, 300); if (r) fail('manifest.bad_package_url', 'package_url', { reason: r }) }
  const im = m['image']
  if (im !== undefined) {
    if (!isObject(im)) fail('manifest.bad_image', 'image', { field: 'image', reason: 'not_an_object' })
    else {
      for (const k of Object.keys(im)) if (k !== 'file' && k !== 'alt') fail('manifest.bad_image', `image.${k}`, { field: k, reason: 'unknown_field' })
      if (typeof im['file'] !== 'string' || !imagePathOk(im['file'])) fail('manifest.bad_image', 'image.file', { field: 'file', reason: 'bad_path' })
      const a = im['alt']
      if (typeof a !== 'string') fail('manifest.bad_image', 'image.alt', { field: 'alt', reason: 'not_text' })
      else if (CONTROL_RE.test(a)) fail('manifest.bad_image', 'image.alt', { field: 'alt', reason: 'bad_characters' })
      else if (a.trim().length < 5) fail('manifest.bad_image', 'image.alt', { field: 'alt', reason: 'too_short', min: 5 })
      else if (a.length > 160) fail('manifest.bad_image', 'image.alt', { field: 'alt', reason: 'too_long', max: 160 })
    }
  }
  return out
}

export interface ValidateManifestOptions {
  /** Ask for `license` and `description` too (external packages and built-in plugins). Without it a manifest that has neither is still valid, but one that has them is checked. */
  requireMetadata?: boolean
}

export function validateManifest(input: unknown, opts: ValidateManifestOptions = {}): ValidationResult<Manifest | null> {
  const errors: StructuredError[] = []
  const bad = (reason: string, path: string, extra: Record<string, unknown> = {}): void => { errors.push({ code: 'manifest.invalid', params: { reason, ...extra }, path }) }
  if (!isObject(input)) { bad('not_an_object', ''); return { ok: false, errors, value: null } }
  if (input['manifest_version'] !== 1) bad('unsupported_manifest_version', 'manifest_version', { found: input['manifest_version'] ?? null })
  if (typeof input['id'] !== 'string' || !PLUGIN_ID_RE.test(input['id'])) bad('bad_plugin_id', 'id')
  if (input['icon'] !== undefined && !(typeof input['icon'] === 'string' && ICON_NAME_RE.test(input['icon']))) bad('bad_icon', 'icon')
  if (typeof input['name'] !== 'string' || input['name'].length === 0) bad('missing_name', 'name')
  if (typeof input['version'] !== 'string' || !SEMVER_RE.test(input['version'])) bad('bad_version', 'version')
  errors.push(...manifestMetadataProblems(input, opts.requireMetadata === true))
  const perms = input['permissions']
  if (perms !== undefined && !(Array.isArray(perms) && perms.length <= 20 && perms.every(p => typeof p === 'string' && /^[a-z]+(:[^\s]{1,200})?$/.test(p)))) bad('bad_permissions', 'permissions')
  const ops = input['operations']
  if (!Array.isArray(ops) || ops.length === 0) bad('no_operations', 'operations')
  else {
    const seen = new Set<string>()
    ops.forEach((o: unknown, i: number) => {
      const at = `operations[${i}]`
      if (!isObject(o)) return bad('operation_not_an_object', at)
      if (typeof o['id'] !== 'string' || !ID_RE.test(o['id'])) bad('bad_operation_id', `${at}.id`)
      else if (seen.has(o['id'])) bad('duplicate_operation', `${at}.id`, { id: o['id'] })
      else seen.add(o['id'])
      if (!OPERATION_KINDS.includes(o['kind'] as string)) bad('bad_operation_kind', `${at}.kind`, { found: o['kind'] ?? null })
      if (o['importance'] !== undefined && !OPERATION_IMPORTANCES.includes(o['importance'] as never)) bad('bad_operation_importance', `${at}.importance`, { found: o['importance'] as string })
      if (o['category'] !== undefined && !(typeof o['category'] === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(o['category']))) bad('bad_operation_category', `${at}.category`, { found: o['category'] })
      const lim = o['limits']
      if (lim !== undefined) {
        if (!isObject(lim)) bad('bad_limits', `${at}.limits`)
        else for (const k of ['max_input_triangles', 'max_output_triangles', 'max_memory_mb']) if (lim[k] !== undefined && !(typeof lim[k] === 'number' && Number.isFinite(lim[k]) && (lim[k] as number) > 0)) bad('bad_limits', `${at}.limits.${k}`)
      }
      const pl = o['payload']
      if (pl !== undefined && !(isObject(pl) && ['in', 'out'].every(k => pl[k] === undefined || (typeof pl[k] === 'string' && /^([a-z][a-z0-9_]{0,39}|\*)$/.test(pl[k] as string))))) bad('bad_payload', `${at}.payload`)
      const outs = o['outputs']
      if (outs !== undefined && (!isObject(outs) || (outs['closed'] !== undefined && typeof outs['closed'] !== 'boolean'))) bad('bad_outputs', `${at}.outputs`)
      if (isObject(outs)) {
        const name = (x: unknown): boolean => (typeof x === 'string' && SEGMENT_NAME_RE.test(x) && x.length <= 40) || (isObject(x) && typeof x['param'] === 'string' && ID_RE.test(x['param']))
        for (const k of ['segments', 'groups']) if (outs[k] !== undefined && !(Array.isArray(outs[k]) && (outs[k] as unknown[]).every(name))) bad('bad_outputs', `${at}.outputs.${k}`)
        if (outs['drops'] !== undefined && !(Array.isArray(outs['drops']) && (outs['drops'] as unknown[]).every(x => x === 'segments' || x === 'groups' || (isObject(x) && typeof x['param'] === 'string' && ID_RE.test(x['param']) && (x['keep'] === undefined || typeof x['keep'] === 'boolean'))))) bad('bad_outputs', `${at}.outputs.drops`)
      }
      if (o['personalisable'] !== undefined && !['never', 'optional', 'always'].includes(o['personalisable'] as string)) bad('bad_personalisable', `${at}.personalisable`)
      if (!Array.isArray(o['params'])) return bad('params_not_an_array', `${at}.params`)
      const names = new Set<string>()
      o['params'].forEach((p: unknown, j: number) => checkParamDef(p, `${at}.params[${j}]`, names, bad))
      // conditions must parse and may only read parameters of the same operation
      o['params'].forEach((p: unknown, j: number) => {
        if (!isObject(p)) return
        for (const f of ['visible_if', 'enabled_if'] as const) {
          const src = p[f]
          if (src === undefined) continue
          try {
            const unknown = [...exprIdentifiers(parseExpr(src as string))].filter(n => !names.has(n))
            if (unknown.length > 0) bad('condition_unknown_param', `${at}.params[${j}].${f}`, { names: unknown })
          } catch (e) { bad('bad_condition', `${at}.params[${j}].${f}`, { problem: e instanceof MeshError ? (e.params['reason'] ?? null) : null }) }
        }
      })
      if (o['icon'] !== undefined && !(typeof o['icon'] === 'string' && ICON_NAME_RE.test(o['icon']))) bad('bad_icon', `${at}.icon`)
      if (o['summary'] !== undefined) {
        if (!(typeof o['summary'] === 'string' && o['summary'].length <= 120)) bad('bad_summary', `${at}.summary`)
        else {
          const unknown = [...o['summary'].matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)].map(m => m[1] as string).filter(n => !names.has(n))
          if (unknown.length > 0) bad('summary_unknown_param', `${at}.summary`, { names: unknown })
        }
      }
    })
  }
  return { ok: errors.length === 0, errors, value: errors.length === 0 ? (input as unknown as Manifest) : null }
}

function checkParamDef(p: unknown, at: string, names: Set<string>, bad: (reason: string, path: string, extra?: Record<string, unknown>) => void): void {
  if (!isObject(p)) return bad('param_not_an_object', at)
  const name = p['name']
  if (typeof name !== 'string' || !ID_RE.test(name)) bad('bad_param_name', `${at}.name`)
  else if (names.has(name)) bad('duplicate_param', `${at}.name`, { name })
  else names.add(name)
  const type = p['type']
  // an unknown parameter type must refuse the plugin, never be ignored (SPEC.md section 11)
  if (typeof type !== 'string' || !(PARAM_TYPES as readonly string[]).includes(type)) return bad('unknown_param_type', `${at}.type`, { found: type ?? null })
  if (p['personalisable'] !== undefined && typeof p['personalisable'] !== 'boolean') bad('bad_personalisable', `${at}.personalisable`)
  if (!('default' in p)) return bad('missing_default', `${at}.default`)
  const min = p['min'], max = p['max']
  for (const [k, v] of [['min', min], ['max', max]] as const) if (v !== undefined && !num(v)) bad('bad_limit', `${at}.${k}`)
  if (num(min) && num(max) && min > max) bad('min_above_max', at)
  // presentation hints: all optional, checked so a typo is noticed; a host that does not know a hint ignores it
  if (p['widget'] !== undefined) {
    const allowed = (WIDGETS_FOR[type] ?? []) as readonly string[]
    if (!(typeof p['widget'] === 'string' && allowed.includes(p['widget']))) bad('bad_widget', `${at}.widget`, { found: typeof p['widget'] === 'string' ? p['widget'] : null, type })
    else if (p['widget'] === 'slider' && !(num(min) && num(max))) bad('slider_needs_range', at)
  }
  if (p['shape_style'] !== undefined && !(type === 'enum' && (p['shape_style'] === 'line' || p['shape_style'] === 'fill'))) bad('bad_shape_style', `${at}.shape_style`, { found: typeof p['shape_style'] === 'string' ? p['shape_style'] : null })
  if (p['importance'] !== undefined && !(IMPORTANCES as readonly string[]).includes(p['importance'] as string)) bad('bad_importance', `${at}.importance`, { found: typeof p['importance'] === 'string' ? p['importance'] : null })
  if (p['icon'] !== undefined && !(typeof p['icon'] === 'string' && ICON_NAME_RE.test(p['icon']))) bad('bad_icon', `${at}.icon`)
  if (p['help'] !== undefined && typeof p['help'] !== 'string') bad('bad_help', `${at}.help`)
  if (type === 'vector' && p['size'] !== 2 && p['size'] !== 3) bad('bad_vector_size', `${at}.size`)
  if (type === 'enum') {
    const opts = p['options']
    if (!Array.isArray(opts) || opts.length === 0) return bad('no_enum_options', `${at}.options`)
    const values = opts.map((o: unknown) => (typeof o === 'string' ? o : isObject(o) && typeof o['value'] === 'string' ? o['value'] : null))
    if (values.some(v => v === null)) return bad('bad_enum_option', `${at}.options`)
    if (new Set(values).size !== values.length) return bad('duplicate_enum_option', `${at}.options`)
    if (opts.some((o: unknown) => isObject(o) && o['icon'] !== undefined && !(typeof o['icon'] === 'string' && ICON_NAME_RE.test(o['icon'])))) bad('bad_icon', `${at}.options`)
    const shaped = opts.filter((o: unknown) => isObject(o) && o['shape'] !== undefined)
    if (shaped.length > MAX_SHAPES || shaped.some((o: unknown) => !(typeof (o as Record<string, unknown>)['shape'] === 'string' && SHAPE_PATH_RE.test((o as Record<string, unknown>)['shape'] as string)))) bad('bad_shape', `${at}.options`)
  }
  if (type === 'range') {
    if (!(Array.isArray(p['default']) && p['default'].length === 2)) return bad('bad_default', `${at}.default`)
  }
  if (type === 'color') {
    const ok = (c: unknown): boolean => typeof c === 'string' && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(c)
    if (p['palette'] !== undefined && !(Array.isArray(p['palette']) && p['palette'].every(ok))) bad('bad_palette', `${at}.palette`)
    if (p['alpha'] !== undefined && typeof p['alpha'] !== 'boolean') bad('bad_alpha', `${at}.alpha`)
    if (p['only_palette'] !== undefined && typeof p['only_palette'] !== 'boolean') bad('bad_only_palette', `${at}.only_palette`)
    if (p['only_palette'] === true && !(Array.isArray(p['palette']) && p['palette'].length > 0)) bad('only_palette_without_palette', at)
  }
  if (type === 'part' && p['preselect'] !== undefined && p['preselect'] !== 'first') bad('bad_preselect', `${at}.preselect`)
  if (type === 'part' && p['kinds'] !== undefined && !(Array.isArray(p['kinds']) && p['kinds'].length > 0 && p['kinds'].every((k: unknown) => k === 'segment' || k === 'group'))) bad('bad_kinds', `${at}.kinds`)
  if (type === 'object') {
    const fields = p['fields']
    if (!Array.isArray(fields) || fields.length === 0) return bad('no_object_fields', `${at}.fields`)
    const inner = new Set<string>()
    fields.forEach((f: unknown, k: number) => {
      if (isObject(f) && ['list', 'placement', 'object'].includes(f['type'] as string)) return bad('bad_item_type', `${at}.fields[${k}].type`, { found: f['type'] as string })
      checkParamDef(f, `${at}.fields[${k}]`, inner, bad)
    })
  }
  if (type === 'list') {
    const item = p['item']
    if (!Array.isArray(item) || item.length === 0) return bad('no_list_item', `${at}.item`)
    const inner = new Set<string>()
    item.forEach((f: unknown, k: number) => {
      if (isObject(f) && f['type'] === 'list') return bad('bad_item_type', `${at}.item[${k}].type`, { found: f['type'] as string })
      checkParamDef(f, `${at}.item[${k}]`, inner, bad)
    })
    for (const k of ['min_items', 'max_items']) if (p[k] !== undefined && !(typeof p[k] === 'number' && Number.isInteger(p[k]) && (p[k] as number) >= 0)) bad('bad_limit', `${at}.${k}`)
    if (typeof p['min_items'] === 'number' && typeof p['max_items'] === 'number' && p['min_items'] > p['max_items']) bad('min_above_max', at)
  }
  if (type === 'asset') {
    if (p['allow_upload'] !== undefined && typeof p['allow_upload'] !== 'boolean') bad('bad_allow_upload', `${at}.allow_upload`)
    if (p['searchable'] !== undefined && typeof p['searchable'] !== 'boolean') bad('bad_searchable', `${at}.searchable`)
    if (p['categories'] !== undefined && !(Array.isArray(p['categories']) && p['categories'].every((c: unknown) => typeof c === 'string'))) bad('bad_categories', `${at}.categories`)
    if (p['preview'] !== undefined && p['preview'] !== 'text') bad('bad_preview', `${at}.preview`, { found: p['preview'] as string })
  }
  if (type === 'payload') {
    const acc = p['accept']
    if (!(Array.isArray(acc) && acc.length > 0 && acc.every((k: unknown) => typeof k === 'string' && (k === '*' || PAYLOAD_KIND_RE.test(k))))) bad('bad_accept', `${at}.accept`)
  }
  if (type === 'string' && typeof p['pattern'] === 'string') { try { new RegExp(p['pattern'], 'u') } catch { bad('bad_pattern', `${at}.pattern`) } }
  if (errorsBefore(p, type)) return
  const e = checkValue(p as unknown as ParamDef, p['default'])
  if (e) bad('bad_default', `${at}.default`, { problem: e.code, ...(e.params ?? {}) })
}

// the definition itself must be usable before the default can be checked against it
function errorsBefore(p: Record<string, unknown>, type: string): boolean {
  if (type === 'vector' && p['size'] !== 2 && p['size'] !== 3) return true
  if (type === 'object' && (!Array.isArray(p['fields']) || p['fields'].length === 0)) return true
  if (type === 'list' && (!Array.isArray(p['item']) || p['item'].length === 0)) return true
  if (type === 'enum' && (!Array.isArray(p['options']) || p['options'].length === 0)) return true
  if (type === 'payload' && !(Array.isArray(p['accept']) && p['accept'].length > 0)) return true
  if (type === 'string' && typeof p['pattern'] === 'string') { try { new RegExp(p['pattern'], 'u') } catch { return true } }
  return false
}
