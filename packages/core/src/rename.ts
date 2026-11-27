// Plugin renames: a plugin's manifest says which ids it `replaces`. A step saved with such an id runs with the plugin that replaces it.
import type { Registry } from './registry'
import type { Step, StepList } from './stack'

/** The step with its plugin id rewritten to the plugin that replaces it, when its own plugin is not installed and another one replaces it. The stored version stays: `migrate` gets it. */
export function renameStep(step: Step, registry: Registry): { step: Step; renamedFrom?: string } {
  if (registry.has(step.plugin.id)) return { step }
  const to = registry.canonicalId(step.plugin.id)
  return to === step.plugin.id ? { step } : { step: { ...step, plugin: { id: to, version: step.plugin.version } }, renamedFrom: step.plugin.id }
}

/** The list with every renamed step rewritten, and which ones were (`from` the old id `to` the new one). The same list object comes back when nothing was renamed. */
export function applyRenames(list: StepList, registry: Registry): { list: StepList; renamed: Array<{ id: string; from: string; to: string }> } {
  const renamed: Array<{ id: string; from: string; to: string }> = []
  const steps = list.steps.map(s => { const r = renameStep(s, registry); if (r.renamedFrom) renamed.push({ id: s.id, from: r.renamedFrom, to: r.step.plugin.id }); return r.step })
  return renamed.length === 0 ? { list, renamed } : { list: { ...list, steps }, renamed }
}
