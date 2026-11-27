import { describe, expect, it } from 'vitest'
import { PluginTexts, writeZip } from '@ateliermesh/core'
import { buildPluginPackage, readPluginPackage, inOwnNamespace } from '../src'

const manifest = { manifest_version: 1 as const, id: 'com.example.lithophane', name: 'Lithophane', version: '1.0.0', license: 'MIT', description: 'A demo plugin that turns a picture into a lithophane.', operations: [{ id: 'litho', kind: 'modifier' as const, params: [] }] }
const MAIN = 'export default { async run(op, ctx) { return { mesh: ctx.mesh } } }'
const enc = new TextEncoder()
const json = (o: unknown): Uint8Array => enc.encode(JSON.stringify(o))
const pack = (assets: Record<string, Uint8Array>) => buildPluginPackage({ manifest, main: MAIN, assets })

describe('the texts of a package (locales/<lang>.json)', () => {
  it('reads language files, flattens them, and keeps only the plugin\'s own namespace', async () => {
    const pkg = await readPluginPackage(await pack({
      'locales/en.json': json({ ops: { litho: { title: 'Lithophane', params: { depth: { label: 'Depth' } } } }, step: { op: { litho: 'Lithophane' } }, mesh: { litho: { thin: 'Too thin: {{mm}} mm' }, lithophane: { _any: 'Something about the lithophane' } } }),
      'locales/nl-BE.json': json({ ops: { litho: { title: 'Lithofaan' } } }),
      'locales/README.txt': enc.encode('not a language file'),
    }))
    expect(pkg.locales.texts['en']).toEqual({ 'ops.litho.title': 'Lithophane', 'ops.litho.params.depth.label': 'Depth', 'step.op.litho': 'Lithophane', 'mesh.litho.thin': 'Too thin: {{mm}} mm', 'mesh.lithophane._any': 'Something about the lithophane' })
    expect(pkg.locales.texts['nl-BE']).toEqual({ 'ops.litho.title': 'Lithofaan' })
    expect(pkg.locales.ignored).toEqual([{ item: 'locales/README.txt', reason: 'not_a_language_file' }])
  })

  it('leaves out everything outside its namespace: the app, other plugins, other codes, odd keys', async () => {
    const pkg = await readPluginPackage(await pack({
      'locales/en.json': json({
        panel: { save: 'Give me your money' }, mesh: { emboss: { text_small: 'Hacked' }, plugin: { crashed: 'Hacked' }, litho: { ok: 'fine' } },
        ops: { emboss: { title: 'Hacked' }, litho: { title: 'ok' } }, step: { op: { emboss: 'Hacked', litho: { deeper: 'no' } } }, 'a b': { c: 'd' },
      }),
    }))
    expect(pkg.locales.texts['en']).toEqual({ 'mesh.litho.ok': 'fine', 'ops.litho.title': 'ok' })
    const ignored = pkg.locales.ignored.map(i => i.item).sort()
    expect(ignored).toEqual(['en:a b.c', 'en:mesh.emboss.text_small', 'en:mesh.plugin.crashed', 'en:ops.emboss.title', 'en:panel.save', 'en:step.op.emboss', 'en:step.op.litho.deeper'].sort())
    expect(pkg.locales.ignored.find(i => i.item === 'en:a b.c')?.reason).toBe('bad_key')
  })

  it('is the namespace rule: ops.<own op>, step.op.<own op> and mesh.<own op or last part of the plugin id>', () => {
    const m = manifest
    for (const k of ['ops.litho.title', 'ops.litho.params.x.help', 'step.op.litho', 'mesh.litho.empty', 'mesh.lithophane.thin_image']) expect(inOwnNamespace(m, k), k).toBe(true)
    for (const k of ['ops.litho', 'ops.other.title', 'step.op.other', 'step.op', 'step.x.litho', 'mesh.other.x', 'mesh.litho', 'mesh', 'plugin.name', 'fix.makeSmaller']) expect(inOwnNamespace(m, k), k).toBe(false)
  })

  it('refuses a package whose texts break a limit', async () => {
    const reason = async (assets: Record<string, Uint8Array>): Promise<unknown> => readPluginPackage(await pack(assets)).then(() => 'loaded', (e: { params?: { reason?: string } }) => e.params?.reason)
    expect(await reason({ 'locales/en.json': enc.encode('{"ops":') })).toBe('locale_not_json')
    expect(await reason({ 'locales/en.json': json(['a']) })).toBe('locale_not_an_object')
    expect(await reason({ 'locales/en.json': json({ ops: { litho: { title: 5 } } }) })).toBe('locale_not_text')
    expect(await reason({ 'locales/en.json': json({ ops: { litho: { title: ['x'] } } }) })).toBe('locale_not_text')
    expect(await reason({ 'locales/en.json': json({ ops: { litho: { title: 'x'.repeat(1001) } } }) })).toBe('locale_text_too_long')
    expect(await reason({ 'locales/en.json': json({ ops: { litho: { title: 'x'.repeat(66000) } } }) })).toBe('locale_too_large')
    expect(await reason({ 'locales/en.json': json({ a: { b: { c: { d: { e: { f: 'ok' } } } } } }) })).toBe('loaded')   // six levels
    expect(await reason({ 'locales/en.json': json({ a: { b: { c: { d: { e: { f: { g: 'x' } } } } } } }) })).toBe('locale_too_deep')
    const many: Record<string, string> = {}
    for (let i = 0; i < 2001; i++) many[`k${i}`] = 'x'
    expect(await reason({ 'locales/en.json': json({ ops: { litho: many } }) })).toBe('locale_too_many_texts')
    const nine: Record<string, Uint8Array> = {}
    for (const l of ['en', 'nl', 'fr', 'de', 'es', 'it', 'pt', 'sv']) nine[`locales/${l}.json`] = json({})
    expect(await reason(nine)).toBe('loaded')   // eight files are fine
    nine['locales/da.json'] = json({})
    expect(await reason(nine)).toBe('locale_too_many_files')
  })

  it('the texts are part of the hashed files: changing one changes the package identity, and a tampered one breaks the listing', async () => {
    const a = await readPluginPackage(await pack({ 'locales/en.json': json({ ops: { litho: { title: 'A' } } }) }))
    const b = await readPluginPackage(await pack({ 'locales/en.json': json({ ops: { litho: { title: 'B' } } }) }))
    expect(a.hash).not.toBe(b.hash)
    const bytes = await pack({ 'locales/en.json': json({ ops: { litho: { title: 'A' } } }) })
    const { readZip } = await import('@ateliermesh/core')
    const entries = (await readZip(bytes)).map(e => (e.name === 'locales/en.json' ? { name: e.name, data: json({ ops: { litho: { title: 'Tampered' } } }) } : { name: e.name, data: e.data }))
    await expect(readPluginPackage(writeZip(entries))).rejects.toMatchObject({ params: { reason: 'hash_mismatch', path: 'locales/en.json' } })
  })

  it('a package without texts has an empty set', async () => {
    const pkg = await readPluginPackage(await pack({}))
    expect(pkg.locales).toEqual({ texts: {}, ignored: [] })
  })
})

describe('PluginTexts (what a host merges)', () => {
  it('serves a plugin\'s texts per language, drops them on remove, and lets the first plugin keep a namespace', () => {
    const s = new PluginTexts()
    expect(s.set('a', { en: { 'ops.litho.title': 'Lithophane' }, nl: { 'ops.litho.title': 'Lithofaan' } })).toEqual([])
    expect(s.get('nl', 'ops.litho.title')).toBe('Lithofaan')
    expect(s.get('fr', 'ops.litho.title')).toBeUndefined()
    // a second plugin with the same op id gets nothing for that root
    expect(s.set('b', { en: { 'ops.litho.title': 'Mine now', 'ops.other.title': 'Other' } })).toEqual(['en:ops.litho.title'])
    expect(s.get('en', 'ops.litho.title')).toBe('Lithophane')
    expect(s.get('en', 'ops.other.title')).toBe('Other')
    s.remove('a')
    expect(s.get('nl', 'ops.litho.title')).toBeUndefined()
    // `step.op.<op>` roots are per operation, so two plugins do not clash on `step.op`
    s.set('c', { en: { 'step.op.x': 'X' } }); s.set('d', { en: { 'step.op.y': 'Y' } })
    expect([s.get('en', 'step.op.x'), s.get('en', 'step.op.y')]).toEqual(['X', 'Y'])
    const v = s.version; s.remove('nobody'); expect(s.version).toBe(v)
  })
})

describe('suggestKey: where a rejected text belongs', () => {
  const one = { manifest_version: 1, id: 'com.example.blocks', name: 'B', version: '1.0.0', license: 'MIT', description: 'Makes blocks for a test of the hints.', operations: [{ id: 'blocks', title: 'Blocks', kind: 'generator', params: [] }] } as never
  const two = { ...(one as object), operations: [{ id: 'a', title: 'A', kind: 'generator', params: [] }, { id: 'b', title: 'B', kind: 'generator', params: [] }] } as never
  it('progress texts go under ops.<op>.stage.<stage>', async () => {
    const { suggestKey } = await import('../src/locales')
    expect(suggestKey(one, 'work.build_blocks')).toBe('ops.blocks.stage.build_blocks')
    expect(suggestKey(one, 'progress.build_blocks')).toBe('ops.blocks.stage.build_blocks')
    expect(suggestKey(two, 'stages.cut')).toBe('ops.<operation id>.stage.cut')
  })
  it('error texts go under mesh.<prefix>.<code>', async () => {
    const { suggestKey } = await import('../src/locales')
    expect(suggestKey(one, 'blocks.diorama_too_big')).toBe('mesh.blocks.diorama_too_big')
    expect(suggestKey(one, 'errors.diorama_too_big')).toBe('mesh.blocks.diorama_too_big')
    expect(suggestKey(one, 'mesh.other.diorama_too_big')).toBe('mesh.blocks.diorama_too_big')
    expect(suggestKey(one, 'something.else')).toBeNull()
  })
  it('a stage text under ops.<op>.stage.<stage> is accepted as the plugin\'s own', async () => {
    const { inOwnNamespace } = await import('../src/locales')
    expect(inOwnNamespace(one, 'ops.blocks.stage.build_blocks')).toBe(true)
  })
})
