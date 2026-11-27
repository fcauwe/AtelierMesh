/* global console */
// What the Atelier's server does with a customer's step list: the same code as the browser, no UI, no mesh.
// Run it in a project that has @ateliermesh/core and @ateliermesh/plugins installed: node server-check.mjs
import { Registry, addStep, emptyStepList, makeStep, parseStepList, serializeStepList } from '@ateliermesh/core'
import { CORE_PLUGIN_ID, CORE_PLUGIN_VERSION, corePlugin } from '@ateliermesh/plugins'

const registry = new Registry().register(corePlugin())
const plugin = { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }

// 1. what the designer saved (operations_json in the database)
const designer = addStep(emptyStepList(), makeStep({
  id: 'text', plugin, op: 'emboss', personalisable: true, personalisable_params: ['text', 'size', 'placement'],
  params: {
    text: 'Anna', font: 'roboto', size: 8, height: 0.8, mode: 'raised',
    placement: { anchor: { point: [0, 0, 4], normal: [0, 0, 1] }, direction: 0, limits: { max_distance: 5, direction: [-45, 45], size: [6, 10] } },
  },
}))
const stored = JSON.stringify(serializeStepList(designer))

// 2. what arrives from a customer's browser: parse the shape, then check it against the designer's list
export function check(customerJson) {
  const parsed = parseStepList(JSON.parse(customerJson))
  if (!parsed.ok) return { ok: false, errors: parsed.errors }
  const r = registry.validateStepList(parsed.value, { role: 'customer', base: designer })
  return { ok: r.ok, errors: r.errors.map(e => `${e.code} ${JSON.stringify(e.params ?? {})} at ${e.path ?? ''}`) }
}

const edit = patch => {
  const copy = JSON.parse(stored)
  Object.assign(copy.steps[0].params, patch.params ?? {})
  if (patch.placement) copy.steps[0].params.placement = { ...copy.steps[0].params.placement, ...patch.placement }
  return JSON.stringify(copy)
}
const cases = {
  'unchanged': stored,
  'new wording and a size inside the limits': edit({ params: { text: 'Bea', size: 9 } }),
  'a small nudge': edit({ placement: { offset: [2, 1] } }),
  'a size outside the limits': edit({ params: { size: 30 } }),
  'moved too far': edit({ placement: { offset: [9, 0] } }),
  'turned too far': edit({ placement: { direction: 90 } }),
  'a field the designer did not hand over (height)': edit({ params: { height: 3 } }),
  'the limits changed': edit({ placement: { limits: { max_distance: 500 } } }),
}
for (const [name, json] of Object.entries(cases)) {
  const r = check(json)
  console.log(`${r.ok ? 'accepted' : 'refused '}  ${name}${r.ok ? '' : '\n          ' + r.errors.join('\n          ')}`)
}
