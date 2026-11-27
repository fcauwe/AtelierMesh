import { describe, expect, it } from 'vitest'
import { Registry, addStep, canPersonalise, hasPersonalisable, emptyStepList, makeStep, setPersonalisableLimits, validateParams } from '../src'
import type { Manifest, Operation, PlacementValue, StepList } from '../src'

const op: Operation = { id: 'e', kind: 'modifier', params: [
  { name: 'text', type: 'string', default: 'Hi', max_length: 100, multiline: true, personalisable: true },
  { name: 'size', type: 'float', default: 8, min: 1, max: 100, personalisable: true },
  { name: 'placement', type: 'placement', default: null, personalisable: true },
  { name: 'height', type: 'float', default: 1, min: 0.1, max: 5 },
] }
const base: PlacementValue = { anchor: { point: [0, 0, 10], normal: [0, 0, 1] }, direction: 0, offset: [0, 0], limits: { max_distance: 5, direction: [-45, 45] } }
const params = (over: Record<string, unknown>): Record<string, unknown> => ({ text: 'Hi', size: 8, placement: base, height: 1, ...over })
const ok = (over: Record<string, unknown>, personalisableParams: string[], textLimits?: Record<string, { max_lines?: number; max_line_length?: number }>): string[] =>
  validateParams(op, params(over), { role: 'customer', base: params({}), personalisableParams, ...(textLimits ? { textLimits } : {}) }).errors.map(e => e.code)

describe('opening only a part of a placement', () => {
  const turned = { ...base, direction: 30 }
  const moved = { ...base, anchor: { point: [3, 0, 10] as [number, number, number], normal: [0, 0, 1] as [number, number, number] } }
  const shifted = { ...base, offset: [2, 0] as [number, number] }
  it('direction alone: turning is fine, moving is not', () => {
    expect(ok({ placement: turned }, ['placement.direction'])).toEqual([])
    expect(ok({ placement: shifted }, ['placement.direction'])).toEqual(['param.not_editable'])
    expect(ok({ placement: moved }, ['placement.direction'])).toEqual(['param.not_editable'])
  })
  it('position alone: moving and shifting are fine, turning is not', () => {
    expect(ok({ placement: moved }, ['placement.position'])).toEqual([])
    expect(ok({ placement: shifted }, ['placement.position'])).toEqual([])
    expect(ok({ placement: turned }, ['placement.position'])).toEqual(['param.not_editable'])
  })
  it('the whole placement still opens both, and the designer\'s limits bind every way in', () => {
    expect(ok({ placement: { ...turned, anchor: moved.anchor } }, ['placement'])).toEqual([])
    expect(ok({ placement: { ...base, direction: 80 } }, ['placement.direction'])).toEqual(['placement.direction_out_of_range'])
    expect(ok({ placement: { ...base, anchor: { point: [9, 0, 10], normal: [0, 0, 1] } } }, ['placement.position'])).toEqual(['placement.too_far'])
    expect(ok({ placement: { ...turned, anchor: moved.anchor } }, ['placement.direction'])).toEqual(['param.not_editable'])
  })
  it('both parts together equal the whole', () => {
    expect(ok({ placement: { ...turned, anchor: moved.anchor } }, ['placement.direction', 'placement.position'])).toEqual([])
  })
  it('helpers read the list', () => {
    const s = makeStep({ id: 'a', plugin: { id: 'x.y', version: '1.0.0' }, op: 'e', personalisable_params: ['text', 'placement.direction'] })
    expect(canPersonalise(s, 'text')).toBe(true)
    expect(canPersonalise(s, 'placement', 'direction')).toBe(true)
    expect(canPersonalise(s, 'placement', 'position')).toBe(false)
    expect(canPersonalise(s, 'placement')).toBe(false)
    expect(hasPersonalisable(s, 'placement')).toBe(true)
    expect(hasPersonalisable(s, 'size')).toBe(false)
  })
})

describe('limits on the text the customer types', () => {
  it('lines and characters per line, counted in characters', () => {
    const lim = { text: { max_lines: 2, max_line_length: 5 } }
    expect(ok({ text: 'abc\ndef' }, ['text'], lim)).toEqual([])
    expect(ok({ text: 'a\nb\nc' }, ['text'], lim)).toEqual(['param.too_many_lines'])
    expect(ok({ text: 'abcdef' }, ['text'], lim)).toEqual(['param.line_too_long'])
    expect(ok({ text: '漢字漢字漢' }, ['text'], lim)).toEqual([])      // five characters, not bytes
    expect(ok({ text: 'abcdef\nb\nc' }, ['text'], lim).sort()).toEqual(['param.line_too_long', 'param.too_many_lines'])
  })
})

describe('the step list carries them', () => {
  const manifest: Manifest = { manifest_version: 1, id: 'x.y', name: 'X', version: '1.0.0', operations: [op] }
  const reg = new Registry().register({ manifest, load: () => ({ run: () => ({}) }) })
  const mk = (extra: Record<string, unknown>): StepList => addStep(emptyStepList(), makeStep({ id: 'a', plugin: { id: 'x.y', version: '1.0.0' }, op: 'e', params: params({}), personalisable_params: ['text', 'placement.direction'], ...extra }))
  it('accepts parts of a placement, refuses parts of anything else', () => {
    expect(reg.validateStepList(mk({})).ok).toBe(true)
    expect(reg.validateStepList(mk({ personalisable_params: ['size.direction'] })).errors[0]?.params).toMatchObject({ reason: 'only_a_placement_has_parts' })
    expect(reg.validateStepList(mk({ personalisable_params: ['height'] })).errors[0]?.code).toBe('step.not_personalisable')
  })
  it('the customer cannot change the designer\'s limits, and the limits are enforced on the list', () => {
    const designer = setPersonalisableLimits(mk({}), 'a', 'text', { max_lines: 1, max_line_length: 4 })
    expect(designer.steps[0]?.personalisable_limits).toEqual({ text: { max_lines: 1, max_line_length: 4 } })
    const typed = { ...designer, steps: [{ ...designer.steps[0]!, params: params({ text: 'too long' }) }] }
    expect(reg.validateStepList(typed, { role: 'customer', base: designer }).errors.map(e => e.code)).toContain('param.line_too_long')
    const loosened = setPersonalisableLimits(typed, 'a', 'text', { max_lines: 9 })
    expect(reg.validateStepList(loosened, { role: 'customer', base: designer }).errors.map(e => e.code)).toContain('step.invalid')
    expect(setPersonalisableLimits(designer, 'a', 'text', null).steps[0]?.personalisable_limits).toBeUndefined()
  })
})

describe('step lists saved before the rename', () => {
  it('still load: customer_params and customer_limits become personalisable_params and personalisable_limits', async () => {
    const { parseStepList } = await import('../src')
    const old = { schema_version: 1, steps: [{ id: 'a', plugin: { id: 'x.y', version: '1.0.0' }, op: 'e', enabled: true, params: {}, personalisable: true, customer_params: ['text'], customer_limits: { text: { max_lines: 2 } } }] }
    const r = parseStepList(old)
    expect(r.ok).toBe(true)
    expect(r.value!.steps[0]).toMatchObject({ personalisable_params: ['text'], personalisable_limits: { text: { max_lines: 2 } } })
    expect(Object.keys(r.value!.steps[0]!)).not.toContain('customer_params')
  })
})
