import { describe, expect, it } from 'vitest'
import { addStep, emptyStepList, makeStep, parseStepList, serializeStepList, stepListHash } from '../src'

const plugin = { id: 'org.example.p', version: '1.0.0' }
const base = (name?: string) => addStep(emptyStepList(), makeStep({ id: 's1', plugin, op: 'x', params: {}, ...(name !== undefined ? { name } : {}) }))

describe('step names', () => {
  it('round-trips and is optional', () => {
    const r = parseStepList(JSON.parse(JSON.stringify(serializeStepList(base('Your name here')))))
    expect(r.ok && r.value?.steps[0]?.name).toBe('Your name here')
    const bare = parseStepList(JSON.parse(JSON.stringify(serializeStepList(base()))))
    expect(bare.ok && bare.value?.steps[0]?.name).toBeUndefined()
  })
  it('refuses a name that is not text or too long', () => {
    const j = JSON.parse(JSON.stringify(serializeStepList(base('a')))) as { steps: Array<Record<string, unknown>> }
    j.steps[0]!['name'] = 5
    expect(parseStepList(j).ok).toBe(false)
    j.steps[0]!['name'] = 'x'.repeat(81)
    expect(parseStepList(j).ok).toBe(false)
  })
  it('is not part of what a step computes (the cache key) but is part of the saved identity', () => {
    expect(stepListHash(base('A'), { ignoreIds: true })).toBe(stepListHash(base('B'), { ignoreIds: true }))
    expect(stepListHash(base('A'))).not.toBe(stepListHash(base('B')))
  })
})
