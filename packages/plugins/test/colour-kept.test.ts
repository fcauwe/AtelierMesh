import { describe, it } from 'vitest'
import { colouredParts, expectColoursKept, runOp } from './colour'
import { corePlugin, deformPlugin, holesPlugin, hollowPlugin, lowpolyPlugin, partsPlugin, repairPlugin, texturePlugin } from '../src'

// "Every part of a mesh, a segment or a group, can carry a colour (#rrggbb)": the operations that rebuild a mesh keep the colours of the parts they keep.
describe('colours of parts survive the operations of every plugin family', { timeout: 60000 }, () => {
  it('parts: delete one body, keep one body', async () => {
    expectColoursKept(await runOp(partsPlugin(), 'delete_part', { part: 'Lid' }, colouredParts()), { bodies: ['Base'] })
    expectColoursKept(await runOp(partsPlugin(), 'keep_part', { part: 'Base' }, colouredParts()), { bodies: ['Base'] })
  })
  it('core: resize, rotate, reduce triangles', async () => {
    expectColoursKept(await runOp(corePlugin(), 'resize', { mode: 'percent', percent: 150 }, colouredParts()))
    expectColoursKept(await runOp(corePlugin(), 'rotate', { angles: [0, 0, 30] }, colouredParts()))
    expectColoursKept(await runOp(corePlugin(), 'decimate', { mode: 'target', target_triangles: 150 }, colouredParts()), { segment: false })
  })
  it('deform: twist and smooth', async () => {
    expectColoursKept(await runOp(deformPlugin(), 'twist', {}, colouredParts()))
    expectColoursKept(await runOp(deformPlugin(), 'smooth', {}, colouredParts()))
  })
  it('repair', async () => { expectColoursKept(await runOp(repairPlugin(), 'repair_mesh', {}, colouredParts())) })
  it('low poly', async () => { expectColoursKept(await runOp(lowpolyPlugin(), 'low_poly', {}, colouredParts()), { segment: false }) })
  it('hollow', async () => { expectColoursKept(await runOp(hollowPlugin(), 'hollow', {}, colouredParts()), { segment: false }) })
  it('holes', async () => {
    // the hole plugin works on one body: the single body keeps its colour
    const one = colouredParts(); one.groups = [{ ...one.groups![0]! }]; one.indices = one.indices.slice(0, one.groups[0]!.count * 3); one.segments = undefined
    expectColoursKept(await runOp(holesPlugin(), 'cut_hole', { diameter: 4, placement: { anchor: { point: [0, 0, 10], normal: [0, 0, 1] }, direction: 0, up_ref: 'z' } }, one), { bodies: ['Lid'], segment: false })
  })
  it('texture', async () => { expectColoursKept(await runOp(texturePlugin(), 'texture', { region: 'Lid' }, colouredParts()), { segment: false }) })
})
