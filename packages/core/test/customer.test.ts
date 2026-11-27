import { describe, expect, it } from 'vitest'
import { Registry, addStep, emptyStepList, makeStep, mergeCustomerList, type MergeNote, type PlacementValue, type Step, type StepList } from '../src'
import { TEST_PLUGIN_ID, createTestPlugin } from '../src/testing'

const P = { id: TEST_PLUGIN_ID, version: '1.0.0' }
const step = (id: string, extra: Partial<Step> = {}): Step => makeStep({ id, plugin: P, op: 'scale', params: { factor: 2, mode: 'uniform', label: 'Lotte' }, personalisable_params: ['factor', 'label'], personalisable_limits: { label: { max_lines: 1, max_line_length: 5 } }, ...extra })
const list = (...s: Step[]): StepList => s.reduce((l, x) => addStep(l, x), emptyStepList())
const registry = new Registry().register(createTestPlugin().entry)

describe('mergeCustomerList', () => {
  const designer = list(step('a'), step('b', { personalisable_params: [] }))

  it('without a customer list it is the designer\'s list', () => {
    expect(mergeCustomerList(designer, undefined)).toBe(designer)
    expect(mergeCustomerList(designer, null)).toBe(designer)
  })

  it('takes the values of open parameters only', () => {
    const customer = list(step('a', { params: { factor: 3, mode: 'xy', label: 'Ann' } }), step('b', { params: { factor: 9, mode: 'xy', label: 'x' }, personalisable_params: ['factor'] }))
    const notes: MergeNote[] = []
    const m = mergeCustomerList(designer, customer, { notes })
    expect(m.steps[0]!.params).toEqual({ factor: 3, mode: 'uniform', label: 'Ann' })   // mode is closed: the designer's
    expect(m.steps[1]!.params).toEqual(designer.steps[1]!.params)                      // the customer's claim that step b is open counts for nothing
    expect(m.steps[1]!.personalisable_params).toEqual([])
    expect(notes).toContainEqual({ step: 'a', reason: 'param_closed', param: 'mode' })
  })

  it('the structure is the designer\'s: removed steps do not come back, new ones are not added, another operation is refused', () => {
    const other = makeStep({ id: 'a', plugin: P, op: 'box', params: { width: 99 }, personalisable_params: ['width'] })
    const customer = list(step('gone', { params: { factor: 5 } }), other)
    const notes: MergeNote[] = []
    const m = mergeCustomerList(designer, customer, { notes })
    expect(m.steps.map(s => s.id)).toEqual(['a', 'b'])
    expect(m.steps[0]).toBe(designer.steps[0])
    expect(notes.filter(n => n.reason === 'step_unknown').map(n => n.step).sort()).toEqual(['a', 'gone'])
  })

  it('cuts a text to the designer\'s limits and says so', () => {
    const notes: MergeNote[] = []
    const m = mergeCustomerList(designer, list(step('a', { params: { factor: 2, mode: 'uniform', label: 'Annabel\nSecond' } })), { notes })
    expect(m.steps[0]!.params['label']).toBe('Annab')
    expect(notes).toContainEqual({ step: 'a', reason: 'text_cut', param: 'label' })
  })

  it('with a registry, a number is brought into the range the parameter has now', () => {
    const m = mergeCustomerList(designer, list(step('a', { params: { factor: 500, mode: 'uniform', label: 'A' } })), { registry })
    expect(m.steps[0]!.params['factor']).toBe(10)             // max is 10
    expect(mergeCustomerList(designer, list(step('a', { params: { factor: 500, mode: 'uniform', label: 'A' } }))).steps[0]!.params['factor']).toBe(500)   // without one, the step checks it when it runs
  })

  it('a placement stays inside the designer\'s limits, and its limits are the designer\'s', () => {
    const pl = (x: number, dir: number, limits?: PlacementValue['limits']): PlacementValue => ({ anchor: { point: [x, 0, 0], normal: [0, 0, 1] }, direction: dir, ...(limits ? { limits } : {}) })
    const d = list(makeStep({ id: 'p', plugin: P, op: 'scale', params: { at: pl(0, 0, { max_distance: 3, direction: [-45, 45] }) }, personalisable_params: ['at'] }))
    const c = list(makeStep({ id: 'p', plugin: P, op: 'scale', params: { at: pl(50, 170, { max_distance: 1000 }) }, personalisable_params: ['at'] }))
    const at = mergeCustomerList(d, c).steps[0]!.params['at'] as PlacementValue
    expect(at.limits).toEqual({ max_distance: 3, direction: [-45, 45] })
    expect(at.anchor.point[0]).toBeCloseTo(3)
    expect(at.direction).toBe(45)
  })

  it('a placement opened for its direction only keeps the designer\'s position', () => {
    const pl = (x: number, dir: number): PlacementValue => ({ anchor: { point: [x, 0, 0], normal: [0, 0, 1] }, direction: dir })
    const d = list(makeStep({ id: 'p', plugin: P, op: 'scale', params: { at: pl(0, 0) }, personalisable_params: ['at.direction'] }))
    const c = list(makeStep({ id: 'p', plugin: P, op: 'scale', params: { at: pl(40, 30) }, personalisable_params: ['at.direction'] }))
    const at = mergeCustomerList(d, c).steps[0]!.params['at'] as PlacementValue
    expect(at.anchor.point).toEqual([0, 0, 0]); expect(at.direction).toBe(30)
  })

  it('does not change its inputs', () => {
    const before = JSON.stringify(designer)
    const customer = list(step('a', { params: { factor: 4, mode: 'xy', label: 'Z' } }))
    const cBefore = JSON.stringify(customer)
    mergeCustomerList(designer, customer)
    expect(JSON.stringify(designer)).toBe(before); expect(JSON.stringify(customer)).toBe(cBefore)
  })
})
