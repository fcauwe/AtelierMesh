// Which parts (segments and groups) exist after each step, worked out from the manifests alone, without running anything.
// A step that names a part (a `part` parameter) can then be checked before it runs: is it in the file, or made by an earlier step, and
// was it dropped on the way? A page uses this to warn about an order that loses a part; a server can refuse the list.
import type { Operation } from './manifest'
import type { Registry } from './registry'
import type { StepList } from './stack'

export interface PartSet { segments: string[]; groups: string[] }
export interface PartIssue {
  stepId: string
  param: string
  value: string
  /** `part.not_produced`: no file or earlier step makes it. `part.dropped`: an earlier step made it and a later one threw it away. */
  code: 'part.not_produced' | 'part.dropped'
}

const names = (op: Operation, key: 'segments' | 'groups', params: Record<string, unknown>): string[] =>
  (op.outputs?.[key] ?? []).flatMap(x => (typeof x === 'string' ? [x] : typeof params[x.param] === 'string' && params[x.param] !== '' ? [params[x.param] as string] : []))

/**
 * @param base the segments and groups of the mesh the list starts from, when the host knows them. Without it, names the file might hold
 *   cannot be judged, so only a part that an earlier step made and a later one dropped is reported.
 */
export function checkPartReferences(list: StepList, registry: Registry, base?: PartSet): PartIssue[] {
  const have = { segments: new Set(base?.segments ?? []), groups: new Set(base?.groups ?? []) }
  const lost = { segments: new Set<string>(), groups: new Set<string>() }
  const issues: PartIssue[] = []
  for (const step of list.steps) {
    if (!step.enabled) continue
    const found = registry.operation(step.plugin.id, step.op)
    if (!found) continue
    const op = found.op
    // what this step asks for
    for (const p of op.params) {
      if (p.type !== 'part') continue
      const v = step.params[p.name]
      if (typeof v !== 'string' || v === '') continue
      // a part parameter that the operation uses to NAME a part it makes is not a reference
      if ([...(op.outputs?.segments ?? []), ...(op.outputs?.groups ?? [])].some(x => typeof x !== 'string' && x.param === p.name)) continue
      const m = /^(segment|group):(.*)$/.exec(v)
      const kinds = m ? [m[1] as 'segment' | 'group'] : p.kinds ?? ['segment', 'group']
      const name = m ? (m[2] as string) : v
      const inSeg = kinds.includes('segment') && have.segments.has(name), inGrp = kinds.includes('group') && have.groups.has(name)
      if (inSeg || inGrp) continue
      const wasLost = (kinds.includes('segment') && lost.segments.has(name)) || (kinds.includes('group') && lost.groups.has(name))
      if (wasLost) issues.push({ stepId: step.id, param: p.name, value: v, code: 'part.dropped' })
      else if (base) issues.push({ stepId: step.id, param: p.name, value: v, code: 'part.not_produced' })
    }
    // what it leaves behind
    for (const d of op.outputs?.drops ?? []) {
      if (typeof d === 'string') {
        const set = have[d]
        for (const n of set) lost[d].add(n)
        set.clear()
        continue
      }
      // a part named by a parameter: dropped, or (keep) the only one left of its kind
      const def = op.params.find(p => p.name === d.param)
      const v = step.params[d.param]
      if (!def || def.type !== 'part' || typeof v !== 'string' || v === '') continue
      const m = /^(segment|group):(.*)$/.exec(v)
      const name = m ? (m[2] as string) : v
      const kinds = (m ? [m[1] as 'segment' | 'group'] : def.kinds ?? ['segment', 'group']).filter(k => (k === 'segment' ? have.segments : have.groups).has(name))
      for (const k of kinds) {
        const set = k === 'segment' ? have.segments : have.groups, gone = k === 'segment' ? lost.segments : lost.groups
        if (d.keep) { for (const n of [...set]) if (n !== name) { gone.add(n); set.delete(n) } }
        else { set.delete(name); gone.add(name) }
      }
    }
    for (const n of names(op, 'segments', step.params)) { have.segments.add(n); lost.segments.delete(n) }
    for (const n of names(op, 'groups', step.params)) { have.groups.add(n); lost.groups.delete(n) }
  }
  return issues
}
