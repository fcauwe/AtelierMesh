import { describe, expect, it } from 'vitest'
import { Registry, addStep, emptyStepList, loadProject, makeStep, saveProject } from '@ateliermesh/core'
import { CORE_PLUGIN_ID, CORE_PLUGIN_VERSION, corePlugin } from '../src'

const p = { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }
const emboss = (id: string, font: string) => makeStep({ id, plugin: p, op: 'emboss', params: { text: 'A', font, size: 5, height: 0.5, mode: 'raised', placement: { anchor: { point: [0, 0, 0], normal: [0, 0, 1] }, direction: 0, up_ref: 'z' } } })
const project = (assets: Array<{ id: string; bytes: Uint8Array }> = []) => {
  let list = addStep(emptyStepList(), emboss('s1', 'roboto-regular'))
  list = addStep(list, emboss('s2', 'font:Quicksand'))
  return saveProject({ name: 'p', base: null, list, rollback: null, assets })
}
const registry = new Registry().register(corePlugin())

describe('a project says which steps use which asset and font', () => {
  it('lists the fonts the host does not know, per step', async () => {
    const r = await loadProject(project(), { registry, fonts: { known: ['font:Roboto', 'font:Quicksand'] } })
    expect(r.missingFonts).toEqual([{ id: 'roboto-regular', inProject: false, used: [{ step: 's1', param: 'font' }] }])
    expect(r.assetUse.map(a => a.id).sort()).toEqual(['font:Quicksand', 'roboto-regular'])
  })
  it('a mapping hook turns the standalone id into the host id, and the steps are rewritten', async () => {
    const r = await loadProject(project(), { registry, fonts: { known: id => id.startsWith('font:'), alias: id => (id === 'roboto-regular' ? 'font:Roboto' : undefined) } })
    expect(r.missingFonts).toEqual([])
    expect(r.list.steps[0]?.params['font']).toBe('font:Roboto')
  })
  it('an asset the project carries is reported as such, and a font it carries is not missing', async () => {
    const r = await loadProject(project([{ id: 'font:Quicksand', bytes: Uint8Array.from([1, 2, 3]) }]), { registry, fonts: { known: [] } })
    expect(r.assetUse.find(a => a.id === 'font:Quicksand')).toEqual({ id: 'font:Quicksand', inProject: true, used: [{ step: 's2', param: 'font' }] })
    expect(r.missingFonts.map(f => f.id)).toEqual(['roboto-regular'])
  })
  it('an asset no step uses is not listed', async () => {
    const r = await loadProject(project([{ id: 'image:x', bytes: Uint8Array.from([1]) }]), { registry })
    expect(r.assetUse.some(a => a.id === 'image:x')).toBe(false)
    expect(r.missingFonts).toEqual([])
  })
})
