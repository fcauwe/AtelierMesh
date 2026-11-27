// Soft hints about the order of steps. The engine allows any order; some orders are poor, and a page can say so with one button to fix it.
// Pure: it reads the step list (and, for the size note, the report of the Size steps) and returns what to say and what move fixes it.
import type { StepList } from '@ateliermesh/core'
import { CORE_PLUGIN_ID } from './core-plugin'
import { LOWPOLY_PLUGIN_ID } from './lowpoly-plugin'
import { VORONOI_PLUGIN_ID } from './voronoi-plugin'
import { REPAIR_PLUGIN_ID } from './repair-plugin'
import { DEFORM_PLUGIN_ID } from './deform-plugin'
import { PARTS_PLUGIN_ID } from './parts-plugin'
import { TEXTURE_PLUGIN_ID } from './texture-plugin'
import { HOLLOW_PLUGIN_ID } from './hollow-plugin'
import { HOLES_PLUGIN_ID } from './holes-plugin'
import { PRINTCHECK_PLUGIN_ID } from './printcheck-plugin'

export type OrderHintCode = 'holes_last' | 'holes_before_smooth' | 'cheese_last' | 'cheese_before_smooth' | 'hollow_last' | 'hollow_before_shell' | 'analyze_last' | 'decimate_after_text' | 'rotate_after_text' | 'size_after_text' | 'repair_first' | 'deform_after_text' | 'reduce_before_deform' | 'parts_first' | 'texture_before_text' | 'reduce_after_texture' | 'smooth_after_text' | 'smooth_before_surface'

export interface OrderHint {
  /** The step the hint is about. */
  step: string
  code: OrderHintCode
  /** Text steps involved: the ones above a step that scales or turns them, or the ones below that a poor step comes after. */
  texts: string[]
  /** The move that fixes it: put step `id` at index `to` (as `moveStep` takes it). */
  fix: { id: string; to: number }
  /** For `size_after_text`: the factor by which the later Size steps scale the letters of each text step, and whether that text's height is personalisable. */
  scale?: Record<string, { factor: number; personalisable: boolean }>
}

/** The steps these hints know about: the core operations, the low poly operation (which smooths letters like decimate does) and the Voronoi pattern (which reducing triangles smooths too). */
/** Cheese holes is a plugin of its own (`be.micro-fabriek.cheese`, built in the plugin factory, installed from a file or a catalog), not built in: the advice about its place in the list knows it by its id. */
const CHEESE_PLUGIN_ID = 'be.micro-fabriek.cheese'
const isCore = (s: { plugin: { id: string } }): boolean => s.plugin.id === CORE_PLUGIN_ID || s.plugin.id === HOLES_PLUGIN_ID || s.plugin.id === LOWPOLY_PLUGIN_ID || s.plugin.id === VORONOI_PLUGIN_ID || s.plugin.id === DEFORM_PLUGIN_ID || s.plugin.id === TEXTURE_PLUGIN_ID || s.plugin.id === HOLLOW_PLUGIN_ID || s.plugin.id === CHEESE_PLUGIN_ID || s.plugin.id === PRINTCHECK_PLUGIN_ID
const ANALYZERS = new Set(['auto_orient', 'overhang', 'printability'])

/**
 * @param sizeFactor the factor a Size step applied in its last run (from its report), when known; used for the printed-size notes.
 */
export function orderHints(list: StepList, sizeFactor: (stepId: string) => number | undefined = () => undefined): OrderHint[] {
  const steps = list.steps.filter(s => s.enabled && isCore(s))
  const idx = (id: string): number => list.steps.findIndex(s => s.id === id)
  const hints: OrderHint[] = []
  // repairing the file comes before everything: later steps should work on a sound mesh
  const repair = list.steps.find(s => s.enabled && s.plugin.id === REPAIR_PLUGIN_ID)
  if (repair && idx(repair.id) > 0) hints.push({ step: repair.id, code: 'repair_first', texts: [], fix: { id: repair.id, to: 0 } })
  // deleting or keeping a part also comes early: right after the repair step (and the other parts steps), before the steps that shape or decorate
  const preparing = (s: { plugin: { id: string } }): boolean => s.plugin.id === REPAIR_PLUGIN_ID || s.plugin.id === PARTS_PLUGIN_ID
  for (const p of list.steps.filter(x => x.enabled && x.plugin.id === PARTS_PLUGIN_ID)) {
    const i = idx(p.id)
    if (!list.steps.slice(0, i).some(x => !preparing(x))) continue
    let lead = 0
    while (lead < list.steps.length && lead !== i && preparing(list.steps[lead] as { plugin: { id: string } })) lead++
    hints.push({ step: p.id, code: 'parts_first', texts: [], fix: { id: p.id, to: lead } })
  }
  // the Voronoi pattern is decoration on the surface like letters; the Voronoi shell is a new shape, which reducing or smoothing does not harm
  const patternsAbove = (i: number): string[] => steps.filter(s => s.plugin.id === VORONOI_PLUGIN_ID && s.op === 'voronoi' && idx(s.id) < i).map(s => s.id)
  const textsAbove = (i: number): string[] => steps.filter(s => (s.op === 'emboss' || s.op === 'emboss_svg') && idx(s.id) < i).map(s => s.id)
  for (const s of steps) {
    const i = idx(s.id)
    if (ANALYZERS.has(s.op)) {
      // analyzers change nothing and look at the model at their place: last is best, unless only other analyzers follow
      const changesAfter = steps.some(o => idx(o.id) > i && !ANALYZERS.has(o.op))
      if (changesAfter) hints.push({ step: s.id, code: 'analyze_last', texts: [], fix: { id: s.id, to: list.steps.length - 1 } })
      continue
    }
    // a cut hole goes through the surface the earlier steps made: letters, a texture, a pattern or a twist added after it would run into the hole (or distort it).
    // A smoothing step above it would not round the rim of the hole.
    if (s.plugin.id === HOLES_PLUGIN_ID) {
      const later = steps.filter(d => idx(d.id) > i && (d.op === 'emboss' || d.op === 'emboss_svg' || d.plugin.id === TEXTURE_PLUGIN_ID || (d.plugin.id === VORONOI_PLUGIN_ID && d.op === 'voronoi') || d.plugin.id === CHEESE_PLUGIN_ID || (d.plugin.id === DEFORM_PLUGIN_ID && d.op !== 'smooth'))).map(d => d.id)
      if (later.length > 0) hints.push({ step: s.id, code: 'holes_last', texts: later, fix: { id: s.id, to: Math.max(...later.map(idx)) } })
      const smoothAbove = steps.filter(d => d.plugin.id === DEFORM_PLUGIN_ID && d.op === 'smooth' && idx(d.id) < i).map(d => idx(d.id))
      if (smoothAbove.length > 0) hints.push({ step: s.id, code: 'holes_before_smooth', texts: [], fix: { id: s.id, to: Math.min(...smoothAbove) } })
      continue
    }
    // the holes are cut into the outside the earlier steps made: letters, a texture, a pattern or a twist added after it would be cut by (or distort) the holes.
    // A smoothing step above it would not round the rims of the holes.
    if (s.plugin.id === CHEESE_PLUGIN_ID) {
      const later = steps.filter(d => idx(d.id) > i && (d.op === 'emboss' || d.op === 'emboss_svg' || d.plugin.id === TEXTURE_PLUGIN_ID || (d.plugin.id === VORONOI_PLUGIN_ID && d.op === 'voronoi') || (d.plugin.id === DEFORM_PLUGIN_ID && d.op !== 'smooth'))).map(d => d.id)
      if (later.length > 0) hints.push({ step: s.id, code: 'cheese_last', texts: later, fix: { id: s.id, to: Math.max(...later.map(idx)) } })
      const smoothAbove = steps.filter(d => d.plugin.id === DEFORM_PLUGIN_ID && d.op === 'smooth' && idx(d.id) < i).map(d => idx(d.id))
      if (smoothAbove.length > 0) hints.push({ step: s.id, code: 'cheese_before_smooth', texts: [], fix: { id: s.id, to: Math.min(...smoothAbove) } })
      continue
    }
    // hollowing works on the outside the earlier steps made: letters, a texture or a pattern added after it would touch (or cut into) the wall.
    // And a Voronoi shell above it would be made from the whole solid, not from the hollow part.
    if (s.plugin.id === HOLLOW_PLUGIN_ID) {
      const later = steps.filter(d => idx(d.id) > i && (d.op === 'emboss' || d.op === 'emboss_svg' || d.plugin.id === TEXTURE_PLUGIN_ID || (d.plugin.id === VORONOI_PLUGIN_ID && d.op === 'voronoi'))).map(d => d.id)
      if (later.length > 0) hints.push({ step: s.id, code: 'hollow_last', texts: later, fix: { id: s.id, to: Math.max(...later.map(idx)) } })
      const shellAbove = steps.filter(d => d.plugin.id === VORONOI_PLUGIN_ID && d.op === 'voronoi_shell' && idx(d.id) < i).map(d => idx(d.id))
      if (shellAbove.length > 0) hints.push({ step: s.id, code: 'hollow_before_shell', texts: [], fix: { id: s.id, to: Math.min(...shellAbove) } })
      continue
    }
    // smoothing evens out the surface the earlier steps made (a shell, a texture, a twist), and it rounds letters and patterns like reducing triangles does:
    // it belongs below the steps that make the surface and above the text steps
    if (s.plugin.id === DEFORM_PLUGIN_ID && s.op === 'smooth') {
      const above = [...textsAbove(i), ...patternsAbove(i)].sort((a, b) => idx(a) - idx(b))
      if (above.length > 0) hints.push({ step: s.id, code: 'smooth_after_text', texts: above, fix: { id: s.id, to: idx(above[0] as string) } })
      const makers = steps.filter(d => idx(d.id) > i && (d.plugin.id === TEXTURE_PLUGIN_ID || (d.plugin.id === VORONOI_PLUGIN_ID && d.op === 'voronoi_shell') || (d.plugin.id === DEFORM_PLUGIN_ID && d.op !== 'smooth'))).map(d => idx(d.id))
      if (makers.length > 0) hints.push({ step: s.id, code: 'smooth_before_surface', texts: [], fix: { id: s.id, to: Math.max(...makers) } })
      continue
    }
    // a twist or a taper moves the letters with the surface: it belongs above the text steps, like Rotate
    if (s.plugin.id === DEFORM_PLUGIN_ID) {
      const t = textsAbove(i)
      if (t.length > 0) hints.push({ step: s.id, code: 'deform_after_text', texts: t, fix: { id: s.id, to: idx(t[0] as string) } })
      continue
    }
    // a texture is a surface pattern like the letters: the letters must stay crisp on top of it, so the texture belongs above the text steps
    if (s.plugin.id === TEXTURE_PLUGIN_ID) {
      const t = textsAbove(i)
      if (t.length > 0) hints.push({ step: s.id, code: 'texture_before_text', texts: t, fix: { id: s.id, to: idx(t[0] as string) } })
      continue
    }
    // reducing triangles after a texture flattens it: the reducing belongs above the texture, which adds the detail it needs
    if (s.op === 'decimate' || s.op === 'low_poly') {
      const firstTexture = steps.filter(d => d.plugin.id === TEXTURE_PLUGIN_ID && idx(d.id) < i).map(d => idx(d.id)).sort((x, y) => x - y)[0]
      if (firstTexture !== undefined) hints.push({ step: s.id, code: 'reduce_after_texture', texts: [], fix: { id: s.id, to: firstTexture } })
    }
    // reducing triangles works on the shape the deform step makes: it belongs below it
    if (s.op === 'decimate' || s.op === 'low_poly') {
      const lastDeform = steps.filter(d => d.plugin.id === DEFORM_PLUGIN_ID && idx(d.id) > i).map(d => idx(d.id)).sort((x, y) => y - x)[0]
      if (lastDeform !== undefined) hints.push({ step: s.id, code: 'reduce_before_deform', texts: [], fix: { id: s.id, to: lastDeform } })
    }
    // reducing triangles smooths a pattern as it smooths letters
    const smoothing = s.op === 'decimate' || s.op === 'low_poly'
    const above = smoothing ? [...textsAbove(i), ...patternsAbove(i)].sort((a, b) => idx(a) - idx(b)) : textsAbove(i)
    if (above.length === 0) continue
    const firstText = idx(above[0] as string)
    if (smoothing) hints.push({ step: s.id, code: 'decimate_after_text', texts: above, fix: { id: s.id, to: firstText } })
    else if (s.op === 'rotate') hints.push({ step: s.id, code: 'rotate_after_text', texts: above, fix: { id: s.id, to: firstText } })
    else if (s.op === 'resize') {
      const f = sizeFactor(s.id) ?? 1
      const scale: NonNullable<OrderHint['scale']> = {}
      for (const t of above) {
        const text = list.steps.find(x => x.id === t)
        const prev = scale[t]?.factor ?? 1
        scale[t] = { factor: prev * f, personalisable: !!text && text.personalisable_params.includes('size') }
      }
      hints.push({ step: s.id, code: 'size_after_text', texts: above, fix: { id: s.id, to: 0 }, scale })
    }
  }
  return hints
}
