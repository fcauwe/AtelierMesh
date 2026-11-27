import { describe, expect, it } from 'vitest'
import { Registry, runWorkflow } from '@ateliermesh/core'
import { SAMPLES, registerBuiltInPlugins, sampleSteps } from '../src'

const registry = registerBuiltInPlugins(new Registry())

describe('sample definitions as data', () => {
  it('every sample has steps the built-in plugins know, and a base that is data', () => {
    expect(SAMPLES.length).toBeGreaterThan(5)
    for (const s of SAMPLES) {
      expect(sampleSteps(registry, s).steps.length).toBe(s.steps.length)
      expect(JSON.parse(JSON.stringify(s.base))).toEqual(s.base)
    }
  })
  it('font ids can be replaced by the host', () => {
    const withText = SAMPLES.find(s => s.steps.some(st => st.op === 'emboss'))!
    const font = (withText.steps.find(st => st.op === 'emboss')!.params['font']) as string
    const list = sampleSteps(registry, withText, { fontIds: { [font]: 'host-font' } })
    expect(list.steps.find(st => st.op === 'emboss')?.params['font']).toBe('host-font')
  })
  it('a sample runs (a box one without text)', async () => {
    const s = SAMPLES.find(x => x.base.kind === 'box' && x.steps.every(st => st.op !== 'emboss' && st.op !== 'emboss_svg'))!
    const r = await runWorkflow(sampleSteps(registry, s), { registry, source: await s.mesh() })
    expect(r.ok).toBe(true)
  })
})
