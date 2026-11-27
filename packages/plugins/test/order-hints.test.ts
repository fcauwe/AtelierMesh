import { describe, expect, it } from 'vitest'
import { addStep, emptyStepList, makeStep, moveStep } from '@ateliermesh/core'
import type { StepList } from '@ateliermesh/core'
import { CORE_PLUGIN_ID, HOLLOW_PLUGIN_ID, TEXTURE_PLUGIN_ID, VORONOI_PLUGIN_ID, orderHints } from '../src'

const list = (...ops: Array<[string, string, Record<string, unknown>?]>): StepList =>
  ops.reduce((l, [id, op, extra]) => addStep(l, makeStep({ id, plugin: { id: CORE_PLUGIN_ID, version: '1.0.0' }, op, ...(extra ?? {}) })), emptyStepList())

describe('order hints', () => {
  it('says nothing for the default order: Size, text, text, analyzer', () => {
    expect(orderHints(list(['a', 'resize'], ['b', 'emboss'], ['c', 'emboss'], ['d', 'auto_orient']))).toEqual([])
  })
  it('an analyzer above a step that changes the model should move to the end; two analyzers in a row at the end are fine', () => {
    const l = list(['a', 'overhang'], ['b', 'emboss'])
    const [h] = orderHints(l)
    expect(h).toMatchObject({ step: 'a', code: 'analyze_last', fix: { id: 'a', to: 1 } })
    expect(moveStep(l, h!.fix.id, h!.fix.to).steps.map(s => s.id)).toEqual(['b', 'a'])
    expect(orderHints(list(['a', 'emboss'], ['b', 'overhang'], ['c', 'auto_orient']))).toEqual([])
  })
  it('decimate and rotate after the text should move above the first text', () => {
    const l = list(['a', 'resize'], ['t1', 'emboss'], ['t2', 'emboss'], ['d', 'decimate'], ['r', 'rotate'])
    const hints = orderHints(l)
    expect(hints.map(h => [h.step, h.code, h.fix.to])).toEqual([['d', 'decimate_after_text', 1], ['r', 'rotate_after_text', 1]])
    expect(hints[0]!.texts).toEqual(['t1', 't2'])
  })
  it('Size after a text scales the letters; the note carries the factor and whether the height is personalisable', () => {
    const l = list(['t', 'emboss', { personalisable_params: ['size'] }], ['s', 'resize'])
    const [h] = orderHints(l, id => (id === 's' ? 0.9375 : undefined))
    expect(h).toMatchObject({ step: 's', code: 'size_after_text', fix: { id: 's', to: 0 } })
    expect(h!.scale!['t']).toEqual({ factor: 0.9375, personalisable: true })
    expect(orderHints(list(['t', 'emboss'], ['s', 'resize']))[0]!.scale!['t']!.personalisable).toBe(false)
  })
  it('ignores steps that are off and steps from other plugins', () => {
    expect(orderHints(list(['t', 'emboss'], ['d', 'decimate', { enabled: false }]))).toEqual([])
  })
})

describe('order hints for the hollow step', () => {
  const mixed = (...ops: Array<[string, string, string]>): StepList => ops.reduce((l, [id, plugin, op]) => addStep(l, makeStep({ id, plugin: { id: plugin, version: '1.0.0' }, op })), emptyStepList())
  it('says nothing when the hollow step comes after the shape, texture and text steps', () => {
    expect(orderHints(mixed(['s', CORE_PLUGIN_ID, 'resize'], ['x', TEXTURE_PLUGIN_ID, 'texture'], ['t', CORE_PLUGIN_ID, 'emboss'], ['h', HOLLOW_PLUGIN_ID, 'hollow']))).toEqual([])
  })
  it('a text, a texture or a pattern after the hollow step: the hollow step moves below them', () => {
    const l = mixed(['h', HOLLOW_PLUGIN_ID, 'hollow'], ['t', CORE_PLUGIN_ID, 'emboss'], ['x', TEXTURE_PLUGIN_ID, 'texture'], ['p', VORONOI_PLUGIN_ID, 'voronoi'])
    const [h] = orderHints(l).filter(x => x.step === 'h')
    expect(h).toMatchObject({ step: 'h', code: 'hollow_last', texts: ['t', 'x', 'p'], fix: { id: 'h', to: 3 } })
    expect(moveStep(l, h!.fix.id, h!.fix.to).steps.map(s => s.id)).toEqual(['t', 'x', 'p', 'h'])
  })
  it('a Voronoi shell above the hollow step: the hollow step moves above it', () => {
    const l = mixed(['a', CORE_PLUGIN_ID, 'resize'], ['v', VORONOI_PLUGIN_ID, 'voronoi_shell'], ['h', HOLLOW_PLUGIN_ID, 'hollow'])
    const hints = orderHints(l).filter(x => x.step === 'h')
    expect(hints.map(x => [x.code, x.fix.to])).toEqual([['hollow_before_shell', 1]])
    expect(orderHints(mixed(['h', HOLLOW_PLUGIN_ID, 'hollow'], ['v', VORONOI_PLUGIN_ID, 'voronoi_shell']))).toEqual([])
  })
  it('ignores a hollow step that is off, and a twist or a smoothing step after it', () => {
    expect(orderHints(mixed(['h', HOLLOW_PLUGIN_ID, 'hollow'], ['t', CORE_PLUGIN_ID, 'emboss'])).length).toBe(1)
    const off = addStep(addStep(emptyStepList(), makeStep({ id: 'h', plugin: { id: HOLLOW_PLUGIN_ID, version: '1.0.0' }, op: 'hollow', enabled: false })), makeStep({ id: 't', plugin: { id: CORE_PLUGIN_ID, version: '1.0.0' }, op: 'emboss' }))
    expect(orderHints(off)).toEqual([])
  })
})

describe('order hints: cut hole', () => {
  const mk = (...steps: Array<[string, string, string]>): StepList => steps.reduce((l, [id, plugin, op]) => addStep(l, makeStep({ id, plugin: { id: plugin, version: '1.0.0' }, op })), emptyStepList())
  const HOLES = 'org.ateliermesh.holes', DEFORM = 'org.ateliermesh.deform'
  it('a hole above text, a texture or a twist should move below them', () => {
    const l = mk(['h', HOLES, 'cut_hole'], ['t', CORE_PLUGIN_ID, 'emboss'], ['x', TEXTURE_PLUGIN_ID, 'texture'])
    const hints = orderHints(l)
    const mine = hints.filter(h => h.step === 'h')
    expect(mine.map(h => [h.step, h.code, h.fix.to])).toEqual([['h', 'holes_last', 2]])
    expect(mine[0]!.texts).toEqual(['t', 'x'])
    expect(moveStep(l, 'h', 2).steps.map(s => s.id)).toEqual(['t', 'x', 'h'])
  })
  it('a smoothing step above the hole should go below it', () => {
    const l = mk(['s', DEFORM, 'smooth'], ['h', HOLES, 'cut_hole'])
    expect(orderHints(l).map(h => [h.step, h.code, h.fix.to])).toEqual([['h', 'holes_before_smooth', 0]])
  })
  it('says nothing when the hole comes after the steps that make the surface', () => {
    expect(orderHints(mk(['t', CORE_PLUGIN_ID, 'emboss'], ['h', HOLES, 'cut_hole']))).toEqual([])
  })
})
