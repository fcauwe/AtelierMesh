import { describe, expect, it } from 'vitest'
import { Registry, addStep, emptyStepList, makeStep, runWorkflow, validateManifest } from '../src'
import { boxMesh, createTestPlugin, TEST_PLUGIN_ID } from '../src/testing'

const withUses = (uses: unknown) => {
  const t = createTestPlugin()
  const manifest = { ...t.entry.manifest, uses } as never
  return { ...t.entry, manifest }
}
const step = () => addStep(emptyStepList(), makeStep({ id: 'o', plugin: { id: TEST_PLUGIN_ID, version: '1.0.0' }, op: 'font_outline', params: {} }))
const fonts = async () => ({ contours: [], fillRule: 'nonzero' as const, bbox: [0, 0, 0, 0] as [number, number, number, number], lines: 1, size: 10, fitScale: 1 })

describe('manifest "uses" and the fonts service', () => {
  it('accepts "fonts" and refuses anything else', () => {
    expect(validateManifest(withUses(['fonts']).manifest).ok).toBe(true)
    const bad = validateManifest(withUses(['network']).manifest)
    expect(bad.ok).toBe(false)
    expect(bad.errors.map(e => e.code)).toContain('manifest.bad_uses')
    expect(validateManifest(withUses('fonts').manifest).errors.map(e => e.code)).toContain('manifest.bad_uses')
  })
  it('a plugin that uses fonts is refused up front when the host has no font service', async () => {
    const r = await runWorkflow(step(), { registry: new Registry().register(withUses(['fonts'])), source: boxMesh(1, 1, 1) })
    expect(r.results[0]!.error?.code).toBe('plugin.needs_fonts')
  })
  it('runs in the same thread when the host passes a font service', async () => {
    const r = await runWorkflow(step(), { registry: new Registry().register(withUses(['fonts'])), source: boxMesh(1, 1, 1), fonts })
    expect(r.ok).toBe(true)
    expect(r.results[0]!.report).toMatchObject({ fillRule: 'nonzero' })
  })
})
