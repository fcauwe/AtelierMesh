import { describe, expect, it } from 'vitest'
import { Registry, emptyStepList, makeStep, segmentNamesWritten, uniqueOutputSegments } from '../src'
import type { Manifest, PluginEntry } from '../src'

const manifest: Manifest = {
  manifest_version: 1, id: 'com.example.label', name: 'Label', version: '1.0.0', license: 'MIT', description: 'Makes a labelled segment.',
  operations: [{ id: 'label', title: 'Label', kind: 'modifier', category: 'text', outputs: { mesh: true, segments: [{ param: 'segment' }, { param: 'walls_segment' }, 'fixed'] }, params: [
    { name: 'segment', type: 'string', default: 'text' }, { name: 'walls_segment', type: 'string', default: 'text_walls' },
  ] }],
} as unknown as Manifest
const entry = { manifest, run: () => ({}) } as unknown as PluginEntry

const registry = new Registry(); registry.register(entry)
const op = registry.operation('com.example.label', 'label')!.op
const step = (id: string, params: Record<string, unknown>) => makeStep({ id, plugin: { id: manifest.id, version: '1.0.0' }, op: 'label', params })

describe('the segment names of a new step', () => {
  it('stay as they are when no earlier step writes them', () => {
    expect(uniqueOutputSegments(emptyStepList(), registry, op, { segment: 'text', walls_segment: 'text_walls' })).toEqual({})
  })
  it('get a number when an earlier step writes the same name, all names of the step with the same number', () => {
    const list = { ...emptyStepList(), steps: [step('s1', { segment: 'text', walls_segment: 'text_walls' })] }
    expect(segmentNamesWritten(list, registry)).toEqual(new Set(['text', 'text_walls']))
    expect(uniqueOutputSegments(list, registry, op, { segment: 'text', walls_segment: 'text_walls' })).toEqual({ segment: 'text_2', walls_segment: 'text_walls_2' })
    const three = { ...list, steps: [...list.steps, step('s2', { segment: 'text_2', walls_segment: 'text_walls_2' })] }
    expect(uniqueOutputSegments(three, registry, op, { segment: 'text', walls_segment: 'text_walls' })).toEqual({ segment: 'text_3', walls_segment: 'text_walls_3' })
  })
  it('leave an empty name alone (that step writes no segment)', () => {
    const list = { ...emptyStepList(), steps: [step('s1', { segment: 'text', walls_segment: '' })] }
    expect(uniqueOutputSegments(list, registry, op, { segment: 'other', walls_segment: '' })).toEqual({})
  })
})
