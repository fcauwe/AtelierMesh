// Starting a customer from an earlier visit. The designer's list is the authority: it says which steps exist, in what order, which parameters are open and
// within what limits. The customer's list only supplies VALUES for the parameters that are open. Everything else in it is ignored, so a stale list (the designer
// has since removed a step or closed a field) or a made-up one can never reach a field the designer did not open.
import { clampParam, fitTextToLimits } from './clamp'
import { clampPlacementToLimits, isPlacement } from './placement'
import type { Registry } from './registry'
import type { PlacementValue } from './placement'
import { hasPersonalisable } from './stack'
import type { Step, StepList } from './stack'

export interface MergeNote {
  /** The step of the customer's list that was left out or only partly taken. */
  step: string
  /** `step_unknown` (the designer has no such step, or it is another operation), `param_closed` (the designer has closed this field), `text_cut` (cut to the designer's limits). */
  reason: 'step_unknown' | 'param_closed' | 'text_cut'
  param?: string
}

function takePlacement(step: Step, name: string, designer: PlacementValue, customer: PlacementValue): PlacementValue {
  const whole = step.personalisable_params.includes(name)
  const out: PlacementValue = whole ? { ...customer } : { ...designer }
  if (!whole) {
    if (step.personalisable_params.includes(`${name}.position`)) { out.anchor = customer.anchor; if (customer.offset) out.offset = customer.offset; else delete out.offset }
    if (step.personalisable_params.includes(`${name}.direction`)) { if (customer.direction !== undefined) out.direction = customer.direction; else delete out.direction }
  }
  // the limits are the designer's, whatever the customer's list says
  if (designer.limits) out.limits = designer.limits; else delete out.limits
  return clampPlacementToLimits(designer, out)
}

/**
 * The list a customer continues from: the designer's list with the customer's values for the open parameters. Steps are matched by id, plugin and operation.
 * Values for a closed parameter, steps the designer does not have, and the customer's own idea of what is open are dropped. A text is cut to the designer's
 * limits and a placement is pulled inside its limits. With a `registry` a number or a choice is also brought into the range the parameter allows now (the
 * designer may have narrowed it since); without one it is kept as it is and the step checks it when it runs. With `notes` the caller learns what was dropped.
 */
export function mergeCustomerList(designer: StepList, customer: StepList | null | undefined, opts: { registry?: Registry; notes?: MergeNote[] } = {}): StepList {
  const { notes, registry } = opts
  if (!customer) return designer
  const byId = new Map(customer.steps.map(s => [s.id, s]))
  for (const c of customer.steps) if (!designer.steps.some(d => d.id === c.id && d.plugin.id === c.plugin.id && d.op === c.op)) notes?.push({ step: c.id, reason: 'step_unknown' })
  return {
    ...designer,
    steps: designer.steps.map(d => {
      const c = byId.get(d.id)
      if (!c || c.plugin.id !== d.plugin.id || c.op !== d.op || !c.params || typeof c.params !== 'object') return d
      let params = d.params
      for (const [name, value] of Object.entries(c.params)) {
        if (!hasPersonalisable(d, name)) { if (JSON.stringify(value) !== JSON.stringify(d.params[name])) notes?.push({ step: d.id, reason: 'param_closed', param: name }); continue }
        let v: unknown = value
        const dv = d.params[name]
        if (isPlacement(dv)) { if (!isPlacement(value)) continue; v = takePlacement(d, name, dv, value) }
        else if (typeof value === 'string') { const cut = fitTextToLimits(value, d.personalisable_limits?.[name]); if (cut !== value) notes?.push({ step: d.id, reason: 'text_cut', param: name }); v = cut }
        const def = registry?.operation(d.plugin.id, d.op)?.op.params.find(x => x.name === name)
        if (def && !isPlacement(dv) && typeof value !== 'string') v = clampParam(def, v)
        if (params === d.params) params = { ...d.params }
        params[name] = v
      }
      return params === d.params ? d : { ...d, params }
    }),
  }
}
