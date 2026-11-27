import { describe, expect, it } from 'vitest'
import { Registry, emptyStepList, makeStep, uniqueOutputSegments } from '@ateliermesh/core'
import { corePlugin } from '../src'

// Text on the surface twice: each step must write its own segments, or both texts are one part with one colour.
describe('two Text on the surface steps', () => {
  it('start with different segment names, so each can have its own colour', () => {
    const p = corePlugin(), registry = new Registry(); registry.register(p)
    const found = registry.operation(p.manifest.id, 'emboss')!
    const defaults = Object.fromEntries(found.op.params.filter(x => x.default !== undefined).map(x => [x.name, x.default]))
    let list = emptyStepList()
    const added: Array<Record<string, unknown>> = []
    for (let i = 1; i <= 3; i++) {
      const params = { ...defaults }
      Object.assign(params, uniqueOutputSegments(list, registry, found.op, params))
      added.push({ segment: params['segment'], walls: params['walls_segment'] })
      list = { ...list, steps: [...list.steps, makeStep({ id: `s${i}`, plugin: { id: p.manifest.id, version: p.manifest.version }, op: 'emboss', params })] }
    }
    expect(added).toEqual([{ segment: 'text', walls: 'text_walls' }, { segment: 'text_2', walls: 'text_walls_2' }, { segment: 'text_3', walls: 'text_walls_3' }])
  })
})
