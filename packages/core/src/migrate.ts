// Migration: steps are stored for years, so a plugin update must not break them.
// A step records the plugin version that wrote it; an older step is brought forward by the plugin's `migrate`.
import { MeshError } from './errors'
import { applyMigration } from './host'
import type { MigrateResult, PluginHost } from './host'
import type { Registry } from './registry'
import type { Step, StepList } from './stack'
import { compareSemver } from './semver'

export interface Migrated {
  step: Step
  migrated: boolean
  /** The version the step was stored with, when it was migrated. */
  from?: string
}

// A migration gives the same answer for the same step every time (a plugin's `migrate` is a pure function of the old parameters), and the editor runs the list on every change:
// remember it, so an old project does not start a worker for each old step on each run. A new plugin version is a new key.
const remembered = new WeakMap<Registry, Map<string, MigrateResult>>()

/**
 * Bring a step saved by an older plugin version up to the installed one. The plugin's migration runs through `host.migrate` when the host offers it (a worker host: the page
 * cannot load the plugin's code); otherwise the module is loaded here, as before.
 */
export async function migrateStep(step: Step, registry: Registry, host?: PluginHost): Promise<Migrated> {
  const found = registry.operation(step.plugin.id, step.op)
  if (!registry.has(step.plugin.id)) throw new MeshError('step.unknown_plugin', { plugin: step.plugin.id })
  if (!found) throw new MeshError('step.unknown_op', { plugin: step.plugin.id, op: step.op })
  const cmp = compareSemver(step.plugin.version, found.manifest.version)
  if (cmp === 0) return { step, migrated: false }
  if (cmp > 0) throw new MeshError('step.version_newer', { stored: step.plugin.version, installed: found.manifest.version })
  const req = { pluginId: step.plugin.id, fromVersion: step.plugin.version, op: step.op, params: step.params }
  const key = `${step.plugin.id}@${step.plugin.version}>${found.manifest.version}|${step.op}|${JSON.stringify(step.params)}`
  let cache = remembered.get(registry); if (!cache) { cache = new Map(); remembered.set(registry, cache) }
  let out = cache.get(key)
  if (!out) {
    out = host?.migrate ? await host.migrate(req) : applyMigration(await registry.module(step.plugin.id), req)
    cache.set(key, out)
    if (cache.size > 500) cache.delete(cache.keys().next().value as string)
  }
  const { op, params } = out
  if (op !== step.op && !registry.operation(step.plugin.id, op)) throw new MeshError('step.unknown_op', { plugin: step.plugin.id, op })
  return { step: { ...step, op, plugin: { id: step.plugin.id, version: found.manifest.version }, params }, migrated: true, from: step.plugin.version }
}

export async function migrateStepList(list: StepList, registry: Registry, host?: PluginHost): Promise<{ list: StepList; migrated: Array<{ id: string; from: string }> }> {
  const steps: Step[] = []
  const migrated: Array<{ id: string; from: string }> = []
  for (const s of list.steps) {
    const r = await migrateStep(s, registry, host)
    steps.push(r.step)
    if (r.migrated && r.from) migrated.push({ id: s.id, from: r.from })
  }
  return { list: { ...list, steps }, migrated }
}
