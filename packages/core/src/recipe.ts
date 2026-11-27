// Recipes: an export of the steps you have, without the model. Save the steps that made a nice result (a text, a texture, a twist) and add them to
// another model later. The recipe is plain JSON (`.amrecipe`, UTF-8), so a host can keep it in a file, in the browser or in its own database (the Atelier:
// a designer's "template"). Everything here is pure: no DOM, no storage, no three.js.
//
// ORDER. A recipe is the step list as it was, in order: the steps run top to bottom. `applyRecipe` appends them after the target's own steps, in that order.
import { canonicalJson } from './canonical'
import type { StructuredError } from './errors'
import type { Registry } from './registry'
import { parseStepList, serializeStepList } from './stack'
import type { Step, StepList } from './stack'

export const RECIPE_FORMAT = 'ateliermesh-recipe'
export const RECIPE_VERSION = 1
/** The file extension of a recipe file. */
export const RECIPE_EXTENSION = '.amrecipe'

export const RECIPE_LIMITS = {
  /** The text of a recipe without its embedded assets. */
  textBytes: 1_048_576,
  /** Embedded SVGs and images (only those a step refers to), decoded, in total. Fonts are never embedded: a step refers to a font by its id. */
  assetBytes: 2_097_152,
  steps: 100,
  name: 120,
} as const

export interface RecipeAsset { id: string; name: string; mime: 'image/svg+xml' | 'image/png' | 'image/jpeg'; base64: string }
export interface RecipePlugin { id: string; version: string }

export interface Recipe {
  format: typeof RECIPE_FORMAT
  version: 1
  name: string
  /** ISO 8601 date and time. */
  created: string
  /** The steps, in the order they run. */
  steps: StepList
  /** The plugins the steps use, in the order they first appear. Worked out from the steps. */
  plugins: RecipePlugin[]
  /** Only when a step refers to an SVG or an image the host keeps: the asset itself, so the recipe works elsewhere. */
  assets?: RecipeAsset[]
}

const ASSET_MIMES = ['image/svg+xml', 'image/png', 'image/jpeg']
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/
const decodedLength = (b64: string): number => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0)

// ---------------------------------------------------------------------------------------------------------------------- making
/** The plugins a step list uses, each once, in the order they first appear. */
export function pluginsOf(list: StepList): RecipePlugin[] {
  const seen = new Map<string, RecipePlugin>()
  for (const s of list.steps) if (!seen.has(s.plugin.id)) seen.set(s.plugin.id, { id: s.plugin.id, version: s.plugin.version })
  return [...seen.values()]
}

export interface MakeRecipeInput {
  name: string
  /** The current steps: all of them, in their order. */
  list: StepList
  assets?: RecipeAsset[]
  /** ISO date; default now. Pass it to get the same file twice. */
  created?: string
}

export function makeRecipe(i: MakeRecipeInput): Recipe {
  const steps = serializeStepList(i.list)
  const r: Recipe = { format: RECIPE_FORMAT, version: RECIPE_VERSION, name: i.name.trim().slice(0, RECIPE_LIMITS.name) || 'Recipe', created: i.created ?? new Date().toISOString(), steps, plugins: pluginsOf(steps) }
  if (i.assets && i.assets.length > 0) r.assets = i.assets.map(a => ({ id: a.id, name: a.name, mime: a.mime, base64: a.base64 }))
  return r
}

/** The recipe as text: the same recipe always gives the same text (keys are sorted; the step order is kept). */
export function serializeRecipe(r: Recipe): string { return canonicalJson(r) }

// ---------------------------------------------------------------------------------------------------------------------- reading
export type ParsedRecipe = { ok: true; recipe: Recipe; errors: [] } | { ok: false; recipe: null; errors: StructuredError[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function unsafeKey(v: unknown, path = '', depth = 0): { key: string; path: string } | null {
  if (depth > 40 || typeof v !== 'object' || v === null) return null
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const r = unsafeKey(v[i], `${path}[${i}]`, depth + 1); if (r) return r } return null }
  for (const k of Object.keys(v)) {
    if (UNSAFE_KEYS.has(k)) return { key: k, path: `${path}.${k}` }
    const r = unsafeKey((v as Record<string, unknown>)[k], `${path}.${k}`, depth + 1); if (r) return r
  }
  return null
}

/** Reads and checks a recipe. Never throws: the errors come back as `{ code: 'recipe.*', params, path }`. */
export function parseRecipe(text: string): ParsedRecipe {
  const fail = (...errors: StructuredError[]): ParsedRecipe => ({ ok: false, recipe: null, errors })
  if (typeof text !== 'string') return fail({ code: 'recipe.not_json' })
  if (text.length > RECIPE_LIMITS.textBytes + Math.ceil((RECIPE_LIMITS.assetBytes * 4) / 3)) return fail({ code: 'recipe.too_large', params: { max: RECIPE_LIMITS.textBytes, size: text.length } })
  let raw: unknown
  try { raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) } catch { return fail({ code: 'recipe.not_json' }) }
  if (!isObj(raw)) return fail({ code: 'recipe.not_a_recipe' })
  const u = unsafeKey(raw); if (u) return fail({ code: 'recipe.unsafe_key', params: { key: u.key }, path: u.path })
  if (raw['format'] !== RECIPE_FORMAT) return fail({ code: 'recipe.not_a_recipe' })
  if (typeof raw['version'] !== 'number' || !Number.isInteger(raw['version']) || raw['version'] < 1) return fail({ code: 'recipe.field', params: { field: 'version' }, path: 'version' })
  if (raw['version'] > RECIPE_VERSION) return fail({ code: 'recipe.version_newer', params: { version: raw['version'], supported: RECIPE_VERSION } })
  const errors: StructuredError[] = []
  const field = (name: string, reason: string, extra: Record<string, unknown> = {}): void => { errors.push({ code: 'recipe.field', params: { field: name, reason, ...extra }, path: name }) }

  // the text without the assets
  let bulk = 0
  if (Array.isArray(raw['assets'])) for (const a of raw['assets']) if (isObj(a) && typeof a['base64'] === 'string') bulk += a['base64'].length
  if (text.length - bulk > RECIPE_LIMITS.textBytes) return fail({ code: 'recipe.too_large', params: { max: RECIPE_LIMITS.textBytes, size: text.length - bulk } })

  const name = raw['name']
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > RECIPE_LIMITS.name) field('name', typeof name === 'string' && name.trim().length > 0 ? 'too_long' : 'missing', { max: RECIPE_LIMITS.name })
  const created = raw['created']
  if (typeof created !== 'string' || created.length > 40 || Number.isNaN(Date.parse(created))) field('created', 'not_a_date')

  const stepsRaw = raw['steps']
  let list: StepList | null = null
  if (!isObj(stepsRaw) || !Array.isArray(stepsRaw['steps'])) field('steps', 'missing')
  else if (stepsRaw['steps'].length > RECIPE_LIMITS.steps) errors.push({ code: 'recipe.too_many_steps', params: { max: RECIPE_LIMITS.steps, count: stepsRaw['steps'].length }, path: 'steps' })
  else {
    const p = parseStepList(stepsRaw)
    if (!p.ok || !p.value) errors.push({ code: 'recipe.steps_invalid', params: { first: p.errors[0]?.params?.['reason'] ?? p.errors[0]?.code ?? 'invalid', count: p.errors.length }, path: 'steps' })
    else list = p.value
  }

  let assets: RecipeAsset[] | undefined
  if (raw['assets'] !== undefined) {
    if (!Array.isArray(raw['assets'])) field('assets', 'not_a_list')
    else {
      assets = []; let total = 0; const ids = new Set<string>()
      for (const a of raw['assets']) {
        if (!isObj(a) || typeof a['id'] !== 'string' || a['id'].length === 0 || a['id'].length > 64 || typeof a['name'] !== 'string' || a['name'].length > RECIPE_LIMITS.name) { errors.push({ code: 'recipe.bad_asset', params: { reason: 'shape' }, path: 'assets' }); continue }
        if (!ASSET_MIMES.includes(a['mime'] as string)) { errors.push({ code: 'recipe.bad_asset', params: { id: a['id'], reason: 'type' }, path: 'assets' }); continue }
        if (ids.has(a['id'])) { errors.push({ code: 'recipe.bad_asset', params: { id: a['id'], reason: 'duplicate' }, path: 'assets' }); continue }
        if (typeof a['base64'] !== 'string' || !B64_RE.test(a['base64']) || a['base64'].length % 4 !== 0) { errors.push({ code: 'recipe.bad_asset', params: { id: a['id'], reason: 'base64' }, path: 'assets' }); continue }
        ids.add(a['id']); total += decodedLength(a['base64'])
        assets.push({ id: a['id'], name: a['name'], mime: a['mime'] as RecipeAsset['mime'], base64: a['base64'] })
      }
      if (total > RECIPE_LIMITS.assetBytes) errors.push({ code: 'recipe.assets_too_large', params: { max: RECIPE_LIMITS.assetBytes, size: total }, path: 'assets' })
    }
  }
  if (errors.length > 0 || !list) return { ok: false, recipe: null, errors: errors.length > 0 ? errors : [{ code: 'recipe.field', params: { field: 'steps' }, path: 'steps' }] }

  const recipe: Recipe = { format: RECIPE_FORMAT, version: 1, name: (name as string).trim(), created: created as string, steps: list, plugins: pluginsOf(list) }
  if (assets && assets.length > 0) recipe.assets = assets
  return { ok: true, recipe, errors: [] }
}

// ---------------------------------------------------------------------------------------------------------------------- using
export interface RecipeProblems {
  /** Plugins the recipe uses that are not registered here. */
  missingPlugins: RecipePlugin[]
  /** Plugins that are here, in another version than the recipe was made with (it may still run). */
  versionDiffers: Array<{ id: string; recipe: string; installed: string }>
  /** Steps whose operation the installed plugin does not have. */
  unknownOps: Array<{ stepId: string; plugin: string; op: string }>
}

export function recipeProblems(recipe: Pick<Recipe, 'steps' | 'plugins'>, registry: Registry): RecipeProblems {
  const have = new Map(registry.list().map(m => [m.id, m.version]))
  const out: RecipeProblems = { missingPlugins: [], versionDiffers: [], unknownOps: [] }
  for (const p of recipe.plugins) {
    const v = have.get(p.id)
    if (v === undefined) out.missingPlugins.push({ id: p.id, version: p.version })
    else if (v !== p.version) out.versionDiffers.push({ id: p.id, recipe: p.version, installed: v })
  }
  for (const s of recipe.steps.steps) if (have.has(s.plugin.id) && !registry.operation(s.plugin.id, s.op)) out.unknownOps.push({ stepId: s.id, plugin: s.plugin.id, op: s.op })
  return out
}

export interface ApplyRecipeOptions {
  /** Leave out the steps whose plugin or operation is not here (needs `registry`). Without it such steps are added and fail when they run. */
  skipMissing?: boolean
  registry?: Registry
}
export interface AppliedRecipe {
  list: StepList
  /** The ids of the steps that were added, in the order they now run. */
  added: string[]
  skipped: Array<{ stepId: string; plugin: string; op: string; reason: 'plugin_missing' | 'operation_unknown' }>
}

/**
 * Appends a recipe's steps to a step list, after the steps it already has and in the recipe's own order. They get new ids (`s<n>`, continuing after the
 * highest in the target); names, parameters, personalisable flags and limits are kept as they are. Part references stay as written:
 * `checkPartReferences` warns afterwards when the new model has no such part.
 */
export function applyRecipe(target: StepList, recipe: Pick<Recipe, 'steps'>, o: ApplyRecipeOptions = {}): AppliedRecipe {
  let n = target.steps.reduce((m, s) => Math.max(m, Number(/^s(\d+)$/.exec(s.id)?.[1] ?? 0)), 0)
  const used = new Set(target.steps.map(s => s.id))
  const fresh = (): string => { let id: string; do id = `s${++n}`; while (used.has(id)); used.add(id); return id }
  const added: string[] = []; const skipped: AppliedRecipe['skipped'] = []
  const steps: Step[] = [...target.steps]
  for (const s of serializeStepList(recipe.steps).steps) {
    if (o.skipMissing && o.registry) {
      if (!o.registry.list().some(m => m.id === s.plugin.id)) { skipped.push({ stepId: s.id, plugin: s.plugin.id, op: s.op, reason: 'plugin_missing' }); continue }
      if (!o.registry.operation(s.plugin.id, s.op)) { skipped.push({ stepId: s.id, plugin: s.plugin.id, op: s.op, reason: 'operation_unknown' }); continue }
    }
    const id = fresh(); added.push(id)
    steps.push({ ...s, id })
  }
  return { list: { schema_version: target.schema_version, steps }, added, skipped }
}
