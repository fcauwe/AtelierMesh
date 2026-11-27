// The plugin registry: manifests plus lazily loaded code. First-party plugins are compiled in; nothing is installed at runtime.
import type { StructuredError } from './errors'
import { MeshError } from './errors'
import type { Manifest, Operation } from './manifest'
import type { PluginModule } from './types'
import { compareSemver } from './semver'
import { validateManifest, validateParams } from './validate'
import type { ValidationResult } from './validate'
import type { Step, StepList } from './stack'

/** Where a plugin came from, for the UI and for `plugins.lock.json`. */
export interface PluginSource {
  kind: 'builtin' | 'package'
  /** SHA-256 over the package's files. */
  hash?: string
  /** Where it was loaded from (a file name or a URL). */
  origin?: string
  signed?: boolean
  signer?: string
}

export interface PluginEntry {
  /** Code that is not part of the app: every mesh it returns is checked before use. */
  untrusted?: boolean
  source?: PluginSource
  manifest: Manifest
  /** Load the plugin code. Called at most once per plugin, on first use. */
  load: () => Promise<PluginModule> | PluginModule
}

export interface StepValidationOptions {
  role?: 'designer' | 'customer'
  /** For the customer role: the designer's version of this step. */
  base?: Step
}

export interface StepValidation extends ValidationResult<Step> {
  /** The step was stored by an older plugin version: run `migrateStep` before using it. */
  needsMigration: boolean
}

/** Why a plugin is switched off: the host or the user did it, or the engine did after the plugin crashed. */
export interface DisabledPlugin {
  /** What the user may read: for a crash, the first line of what was thrown. Empty when switched off by hand. */
  reason: string
  /** Milliseconds since 1970 when it was switched off. */
  at: number
  /** The engine switched it off because it crashed (the user did not choose it). */
  crashed: boolean
}

export class Registry {
  private readonly entries = new Map<string, PluginEntry>()
  private readonly modules = new Map<string, Promise<PluginModule>>()
  private readonly off = new Map<string, DisabledPlugin>()
  private readonly listeners = new Set<() => void>()
  private changes = 0

  /** Add a plugin. The manifest is validated; an invalid one is refused. */
  register(entry: PluginEntry): this {
    const v = validateManifest(entry.manifest)
    if (!v.ok) throw new MeshError('manifest.invalid', { issues: v.errors, plugin: (entry.manifest as { id?: unknown } | null)?.id ?? null })
    if (this.entries.has(entry.manifest.id)) throw new MeshError('manifest.invalid', { reason: 'duplicate_plugin', id: entry.manifest.id }, 'id')
    this.entries.set(entry.manifest.id, entry)
    this.changed()
    return this
  }

  /**
   * The id a step's plugin id stands for: itself when that plugin is registered, else the registered plugin whose manifest `replaces` it, else itself. A plugin that is installed is
   * never renamed away; when several registered plugins replace one id, the one registered first answers.
   */
  canonicalId(pluginId: string): string {
    if (this.entries.has(pluginId)) return pluginId
    for (const [id, e] of this.entries) if (e.manifest.replaces?.includes(pluginId)) return id
    return pluginId
  }

  /** The ids a registered plugin replaces (empty when it replaces none or is not registered). */
  replacedIds(pluginId: string): string[] { return [...(this.entries.get(pluginId)?.manifest.replaces ?? [])] }

  /** A number that goes up whenever a plugin is added, removed, switched off or on: a UI can use it as the snapshot of `subscribe`. */
  get version(): number { return this.changes }
  /** Call `cb` after every change to the plugin list or to which plugins are on. Returns the function that stops it. */
  subscribe(cb: () => void): () => void { this.listeners.add(cb); return () => { this.listeners.delete(cb) } }
  private changed(): void { this.changes++; for (const cb of [...this.listeners]) cb() }

  /**
   * Switch a plugin off or on. A switched-off plugin stays registered (its steps stay in the list) but does not run: its steps fail with
   * `plugin.disabled`. Switching it on again forgets the code that was loaded, so a plugin that failed to load gets a fresh try.
   * Returns false for a plugin that is not registered.
   */
  setEnabled(pluginId: string, enabled: boolean, reason = '', crashed = false): boolean {
    if (!this.entries.has(pluginId)) return false
    if (enabled) { if (!this.off.delete(pluginId)) return true; this.modules.delete(pluginId) }
    else { if (this.off.has(pluginId)) return true; this.off.set(pluginId, { reason, at: Date.now(), crashed }) }
    this.changed()
    return true
  }
  isEnabled(pluginId: string): boolean { return !this.off.has(pluginId) }
  /** The plugins that are switched off, by id. */
  disabledPlugins(): Record<string, DisabledPlugin> { return Object.fromEntries(this.off) }

  /** Remove a plugin, for example when the user unloads a package. Steps that use it then fail with `step.unknown_plugin`. */
  unregister(pluginId: string): boolean { this.modules.delete(pluginId); this.off.delete(pluginId); const had = this.entries.delete(pluginId); if (had) this.changed(); return had }
  has(pluginId: string): boolean { return this.entries.has(pluginId) }
  isUntrusted(pluginId: string): boolean { return this.entries.get(pluginId)?.untrusted === true }
  sourceOf(pluginId: string): PluginSource | undefined { return this.entries.get(pluginId)?.source ?? (this.entries.has(pluginId) ? { kind: 'builtin' } : undefined) }
  manifest(pluginId: string): Manifest | undefined { return this.entries.get(pluginId)?.manifest }
  list(): Manifest[] { return [...this.entries.values()].map(e => e.manifest) }

  operation(pluginId: string, opId: string): { manifest: Manifest; op: Operation } | undefined {
    const manifest = this.manifest(pluginId)
    const op = manifest?.operations.find(o => o.id === opId)
    return manifest && op ? { manifest, op } : undefined
  }

  /** The plugin code, loaded once. */
  module(pluginId: string): Promise<PluginModule> {
    const entry = this.entries.get(pluginId)
    if (!entry) return Promise.reject(new MeshError('step.unknown_plugin', { plugin: pluginId }))
    let m = this.modules.get(pluginId)
    if (!m) { m = Promise.resolve().then(() => entry.load()); this.modules.set(pluginId, m) }
    return m
  }

  /** Check one step against the manifests. The returned value has parameters validated and defaults filled in. */
  validateStep(step: Step, opts: StepValidationOptions = {}): StepValidation {
    const errors: StructuredError[] = []
    const fail = (e: StructuredError): StepValidation => ({ ok: false, errors: [...errors, e], value: step, needsMigration: false })
    const found = this.operation(step.plugin.id, step.op)
    if (!this.has(step.plugin.id)) return fail({ code: 'step.unknown_plugin', params: { plugin: step.plugin.id } })
    if (!found) return fail({ code: 'step.unknown_op', params: { plugin: step.plugin.id, op: step.op } })
    const cmp = compareSemver(step.plugin.version, found.manifest.version)
    if (cmp > 0) return fail({ code: 'step.version_newer', params: { stored: step.plugin.version, installed: found.manifest.version } })
    const needsMigration = cmp < 0
    const { op } = found
    // personalisable parameters must exist, be flagged personalisable in the manifest, and the operation must allow personalisation
    for (const entry of step.personalisable_params) {
      // `<placement>.position` and `<placement>.direction` open one part of a placement
      const m = /^([a-z][a-z0-9_]*)\.(position|direction)$/.exec(entry)
      const name = m ? m[1] as string : entry
      const p = op.params.find(x => x.name === name)
      if (m && p && p.type !== 'placement') { errors.push({ code: 'step.not_personalisable', params: { name: entry, reason: 'only_a_placement_has_parts' }, path: 'personalisable_params' }); continue }
      if (!p || p.personalisable !== true) errors.push({ code: 'step.not_personalisable', params: { name }, path: 'personalisable_params' })
    }
    if ((step.personalisable || step.personalisable_params.length > 0) && op.personalisable === 'never') errors.push({ code: 'step.not_personalisable', params: { op: op.id, reason: 'operation_not_personalisable' }, path: 'personalisable' })
    let value = step
    if (!needsMigration) {
      const r = validateParams(op, step.params, opts.role === 'customer' ? { role: 'customer', base: opts.base?.params, personalisableParams: step.personalisable_params, ...(step.personalisable_limits ? { textLimits: step.personalisable_limits } : {}) } : {})
      errors.push(...r.errors)
      value = { ...step, params: r.value }
    }
    return { ok: errors.length === 0, errors, value, needsMigration }
  }

  /** Check a whole list. For the customer role, pass the designer's list: only parameters the designer handed over may differ. */
  validateStepList(list: StepList, opts: { role?: 'designer' | 'customer'; base?: StepList } = {}): ValidationResult<StepList> {
    const errors: StructuredError[] = []
    const steps: Step[] = []
    if (opts.role === 'customer') {
      const base = opts.base
      if (!base) return { ok: false, errors: [{ code: 'step.invalid', params: { reason: 'customer validation needs the designer list' } }], value: list }
      const same = base.steps.length === list.steps.length && base.steps.every((b, i) => { const s = list.steps[i] as Step; return b.id === s.id && b.plugin.id === s.plugin.id && b.plugin.version === s.plugin.version && b.op === s.op && (b.name ?? '') === (s.name ?? '') && b.enabled === s.enabled && b.personalisable === s.personalisable && JSON.stringify(b.personalisable_params) === JSON.stringify(s.personalisable_params) && JSON.stringify(b.personalisable_limits ?? null) === JSON.stringify(s.personalisable_limits ?? null) })
      if (!same) errors.push({ code: 'step.invalid', params: { reason: 'customer_changed_the_structure' }, path: 'steps' })
    }
    list.steps.forEach((s, i) => {
      const base = opts.role === 'customer' ? opts.base?.steps.find(b => b.id === s.id) : undefined
      const r = this.validateStep(s, { role: opts.role, base })
      for (const e of r.errors) errors.push({ ...e, path: `steps[${i}]` + (e.path ? `.${e.path}` : '') })
      steps.push(r.value)
    })
    return { ok: errors.length === 0, errors, value: { ...list, steps } }
  }
}
