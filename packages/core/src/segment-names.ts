// A step that makes a segment (the letters of a text, a drawing) names it with a setting (`outputs.segments: [{ param: 'segment' }]`), and the setting has one default for every step of
// that kind. Two such steps then wrote into the same segment: one part, one colour. A host that adds a step gives it names that no earlier step uses.
import type { Operation } from './manifest'
import type { Registry } from './registry'
import type { StepList } from './stack'

const NAME_RE = /^[a-z][a-z0-9_]*$/

/** The segment names the steps of a list write: the values of the settings their operations name in `outputs.segments`. */
export function segmentNamesWritten(list: StepList, registry: Registry): Set<string> {
  const used = new Set<string>()
  for (const s of list.steps) {
    const op = registry.operation(s.plugin.id, s.op)?.op
    for (const o of op?.outputs?.segments ?? []) {
      if (typeof o === 'string') continue
      const v = s.params[o.param]
      if (typeof v === 'string' && v !== '') used.add(v)
    }
  }
  return used
}

/**
 * The segment-name settings of a new step, made unique: a name an earlier step already writes gets `_2`, `_3`, ... (the same number for all the step's names, so `text` and `text_walls`
 * become `text_2` and `text_walls_2`). Returns only what changes. A person who wants two steps in one part sets the same name on both; this only changes the starting point.
 */
export function uniqueOutputSegments(list: StepList, registry: Registry, op: Pick<Operation, 'outputs'>, params: Record<string, unknown>): Record<string, unknown> {
  const mine: Array<[string, string]> = []
  for (const o of op.outputs?.segments ?? []) {
    if (typeof o === 'string') continue
    const v = params[o.param]
    if (typeof v === 'string' && v !== '') mine.push([o.param, v])
  }
  if (mine.length === 0) return {}
  const used = segmentNamesWritten(list, registry)
  if (!mine.some(([, v]) => used.has(v))) return {}
  for (let n = 2; n < 1000; n++) {
    const next = mine.map(([p, v]) => [p, `${v}_${n}`] as [string, string])
    if (next.every(([, v]) => !used.has(v) && v.length <= 40 && NAME_RE.test(v))) return Object.fromEntries(next)
  }
  return {}
}

