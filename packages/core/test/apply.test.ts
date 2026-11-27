import { describe, expect, it } from 'vitest'
import { Registry, addStep, makeStep, emptyStepList, runWorkflow, canApplyPermanently, applyPermanently, measureMesh, type EditorState, type Step } from '../src'
import { boxMesh, createTestPlugin, TEST_PLUGIN_ID } from '../src/testing'

const P = { id: TEST_PLUGIN_ID, version: '1.0.0' }
const st = (id: string, op: string, params: Record<string, unknown> = {}, extra: Partial<Step> = {}): Step => makeStep({ id, plugin: P, op, params, ...extra })
const state = (steps: Step[], rollback: string | null = null): EditorState => ({ base: boxMesh(10, 10, 10), list: steps.reduce((l, s) => addStep(l, s), emptyStepList()), rollback })
const registry = (): Registry => new Registry().register(createTestPlugin().entry)

describe('apply permanently', () => {
  const s0 = state([st('a', 'scale', { factor: 2 }), st('b', 'scale', { factor: 3 }), st('c', 'scale', { factor: 0.5 })])

  it('all steps: the result is the old final output, the list is empty, the input is untouched', async () => {
    const reg = registry()
    const before = JSON.stringify(s0.list)
    const expected = (await runWorkflow(s0.list, { registry: reg, source: s0.base })).mesh!
    const events: unknown[] = []
    const { state: next, event } = await applyPermanently(s0, { registry: reg, onBaseReplaced: e => events.push(e) })
    expect(next.list.steps).toEqual([])
    expect(measureMesh(next.base!).volume).toBeCloseTo(measureMesh(expected).volume)
    expect(next.rollback).toBeNull()
    expect(event).toMatchObject({ type: 'base-replaced', applied: 3, stepIds: ['a', 'b', 'c'], clearHistory: true })
    expect(events).toHaveLength(1)
    expect(JSON.stringify(s0.list)).toBe(before)
  })

  it('up to a step: that step and the ones before it are baked, the rest runs on the new base to the same final result', async () => {
    const reg = registry()
    const final = (await runWorkflow(s0.list, { registry: reg, source: s0.base })).mesh!
    const { state: next, event } = await applyPermanently(s0, { registry: reg }, 'b')
    expect(next.list.steps.map(s => s.id)).toEqual(['c'])
    expect(event.applied).toBe(2)
    expect(measureMesh(next.base!).volume).toBeCloseTo(1000 * 216)
    const again = (await runWorkflow(next.list, { registry: reg, source: next.base })).mesh!
    expect(measureMesh(again).volume).toBeCloseTo(measureMesh(final).volume)
  })

  it('a disabled step in the range is dropped without effect', async () => {
    const s = state([st('a', 'scale', { factor: 2 }), st('b', 'scale', { factor: 5 }, { enabled: false })])
    const { state: next } = await applyPermanently(s, { registry: registry() })
    expect(measureMesh(next.base!).volume).toBeCloseTo(8000)
    expect(next.list.steps).toEqual([])
  })

  it('a failing step changes nothing and fires no event', async () => {
    const s = state([st('a', 'scale', { factor: 2 }), st('x', 'fail'), st('c', 'scale')])
    let fired = 0
    await expect(applyPermanently(s, { registry: registry(), onBaseReplaced: () => { fired++ } })).rejects.toMatchObject({ code: 'apply.step_failed', params: { step: 'x' } })
    expect(fired).toBe(0)
    // applying only the part before the failing step still works
    const ok = await applyPermanently(s, { registry: registry() }, 'a')
    expect(ok.state.list.steps.map(x => x.id)).toEqual(['x', 'c'])
  })

  it('canApplyPermanently: empty list, unknown step, after the marker', () => {
    expect(canApplyPermanently(state([]))).toMatchObject({ ok: false, code: 'apply.nothing_to_apply' })
    expect(canApplyPermanently(s0, 'zz')).toMatchObject({ ok: false, code: 'apply.unknown_step' })
    expect(canApplyPermanently(s0)).toEqual({ ok: true, count: 3 })
    const marked = { ...s0, rollback: 'b' }
    expect(canApplyPermanently(marked)).toMatchObject({ ok: false, code: 'apply.after_rollback' })
    expect(canApplyPermanently(marked, 'c')).toMatchObject({ ok: false, code: 'apply.after_rollback' })
    expect(canApplyPermanently(marked, 'a')).toEqual({ ok: true, count: 1 })
    expect(canApplyPermanently(marked, 'b')).toEqual({ ok: true, count: 2 })
  })

  it('marker: kept when it lies after the applied range, cleared when applied up to it', async () => {
    const marked = { ...s0, rollback: 'c' }
    const kept = await applyPermanently(marked, { registry: registry() }, 'a')
    expect(kept.state.rollback).toBe('c')
    const cleared = await applyPermanently({ ...s0, rollback: 'b' }, { registry: registry() }, 'b')
    expect(cleared.state.rollback).toBeNull()
    expect(cleared.state.list.steps.map(x => x.id)).toEqual(['c'])
    await expect(applyPermanently({ ...s0, rollback: 'b' }, { registry: registry() })).rejects.toMatchObject({ code: 'apply.after_rollback' })
  })

  it('the host can block it, for example while a step is personalisable', async () => {
    const s = state([st('a', 'scale', {}, { personalisable_params: ['factor'] }), st('b', 'scale')])
    const block = (steps: Step[]): string | undefined => (steps.some(x => x.personalisable) ? 'personalisable' : undefined)
    await expect(applyPermanently(s, { registry: registry(), block })).rejects.toMatchObject({ code: 'apply.blocked', params: { reason: 'personalisable' } })
    const ok = await applyPermanently(s, { registry: registry(), block }, undefined).catch(() => null)
    expect(ok).toBeNull()
  })

  it('works with a generator as the first step and no base mesh', async () => {
    const s: EditorState = { base: null, list: addStep(addStep(emptyStepList(), st('g', 'box', { width: 4, depth: 5, height: 6 })), st('s', 'scale', { factor: 2 })), rollback: null }
    const { state: next } = await applyPermanently(s, { registry: registry() }, 'g')
    expect(measureMesh(next.base!).volume).toBeCloseTo(120)
    expect(next.list.steps.map(x => x.id)).toEqual(['s'])
  })
})
