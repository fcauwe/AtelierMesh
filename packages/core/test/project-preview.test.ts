import { describe, expect, it } from 'vitest'
import { PREVIEW_MAX_BYTES, addStep, emptyStepList, loadProject, makeStep, previewProblem, readZip, saveProject, writeZip } from '../src'
import { boxMesh, TEST_PLUGIN_ID } from '../src/testing'

/** The smallest thing that looks like a PNG to `previewProblem`: the signature and an IHDR chunk. */
const png = (w = 480, h = 320, extra = 0): Uint8Array => {
  const b = new Uint8Array(33 + extra), dv = new DataView(b.buffer)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); dv.setUint32(8, 13); b.set([0x49, 0x48, 0x44, 0x52], 12); dv.setUint32(16, w); dv.setUint32(20, h)
  return b
}
const state = (preview?: Uint8Array) => ({ name: 'x', base: boxMesh(1, 1, 1), list: addStep(emptyStepList(), makeStep({ id: 'a', plugin: { id: TEST_PLUGIN_ID, version: '1.0.0' }, op: 'scale', params: { factor: 2 } })), rollback: null, assets: [], ...(preview ? { preview } : {}) })

describe('project preview picture', () => {
  it('is stored as preview.png and comes back with the project', async () => {
    const p = png()
    const bytes = saveProject(state(p))
    expect((await readZip(bytes)).map(e => e.name)).toContain('preview.png')
    expect(Array.from((await loadProject(bytes)).preview!)).toEqual(Array.from(p))
  })
  it('is optional: a project without one (and an older file) still opens', async () => {
    const bytes = saveProject(state())
    expect((await readZip(bytes)).map(e => e.name)).not.toContain('preview.png')
    const back = await loadProject(bytes)
    expect(back.preview).toBeUndefined()
    expect(back.list.steps.length).toBe(1)
  })
  it('refuses to save bytes that are not an acceptable picture', () => {
    for (const [bytes, reason] of [[new Uint8Array(40), 'not_a_png'], [png(2000, 100), 'bad_size'], [png(480, 320, PREVIEW_MAX_BYTES), 'too_large'], [new TextEncoder().encode('<svg onload="x()"></svg>' + ' '.repeat(40)), 'not_a_png']] as const) {
      expect(previewProblem(bytes)).toBe(reason)
      expect(() => saveProject(state(bytes))).toThrowError(expect.objectContaining({ code: 'export.invalid_preview', params: { reason } }))
    }
  })
  it('leaves out a bad picture in a file instead of failing to open it', async () => {
    const files = (await readZip(saveProject(state(png())))).map(e => (e.name === 'preview.png' ? { name: e.name, data: new TextEncoder().encode('<html>'.repeat(10)) } : e))
    const back = await loadProject(await writeZip(files))
    expect(back.preview).toBeUndefined()
    expect(back.list.steps.length).toBe(1)
  })
  it('reads the older name thumbnail.png too', async () => {
    const files = (await readZip(saveProject(state(png())))).map(e => (e.name === 'preview.png' ? { ...e, name: 'thumbnail.png' } : e))
    expect((await loadProject(await writeZip(files))).preview).toBeDefined()
  })
})
