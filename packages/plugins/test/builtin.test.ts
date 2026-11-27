import { describe, expect, it } from 'vitest'
import { Registry } from '@ateliermesh/core'
import { BUILT_IN_PLUGINS, registerBuiltInPlugins, selectBuiltInPlugins } from '../src'

describe('registerBuiltInPlugins', () => {
  it('registers every first-party plugin with its id and version, and every operation can be found', () => {
    const registry = registerBuiltInPlugins(new Registry())
    const listed = registry.list()
    expect(listed.map(m => m.id).sort()).toEqual(BUILT_IN_PLUGINS.map(p => p.id).sort())
    for (const p of BUILT_IN_PLUGINS) {
      const m = listed.find(x => x.id === p.id)!
      expect(m.version).toBe(p.version)
      for (const op of m.operations) expect(registry.operation(p.id, op.id)?.op.id).toBe(op.id)
    }
  })
  it('lists the plugins the Atelier relies on', () => {
    const ids = BUILT_IN_PLUGINS.map(p => p.id)
    for (const id of ['org.ateliermesh.core', 'org.ateliermesh.lowpoly', 'org.ateliermesh.voronoi', 'org.ateliermesh.deform', 'org.ateliermesh.repair', 'org.ateliermesh.parts', 'org.ateliermesh.texture']) expect(ids).toContain(id)
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('can be called on a second registry (a worker has its own)', () => {
    expect(registerBuiltInPlugins(new Registry()).list().length).toBe(BUILT_IN_PLUGINS.length)
    expect(registerBuiltInPlugins(new Registry()).list().length).toBe(BUILT_IN_PLUGINS.length)
  })
  it('can leave plugins out (a host that does not want a heavy one yet), page and worker alike', () => {
    const ids = (o: Parameters<typeof registerBuiltInPlugins>[1]) => registerBuiltInPlugins(new Registry(), o).list().map(m => m.id).sort()
    expect(ids({ except: ['org.ateliermesh.texture', 'org.ateliermesh.voronoi'] })).toEqual(BUILT_IN_PLUGINS.map(p => p.id).filter(i => i !== 'org.ateliermesh.texture' && i !== 'org.ateliermesh.voronoi').sort())
    expect(ids({ only: ['org.ateliermesh.core'] })).toEqual(['org.ateliermesh.core'])
    expect(selectBuiltInPlugins({ only: ['nope'] })).toEqual([])
  })
})
