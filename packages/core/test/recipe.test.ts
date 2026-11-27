import { describe, expect, it } from 'vitest'
import { Registry, addStep, applyRecipe, emptyStepList, makeRecipe, makeStep, parseRecipe, recipeProblems, serializeRecipe } from '../src'
import type { Manifest, Operation, Recipe, StepList } from '../src'

const mf = (id: string, version: string, ops: string[]): Manifest => ({ manifest_version: 1, id, name: id, version, operations: ops.map(o => ({ id: o, kind: 'modifier', params: [] }) as unknown as Operation) })
const registry = (): Registry => new Registry().register({ manifest: mf('org.example.a', '1.0.0', ['one', 'two']), load: () => ({ run: () => ({}) }) } as never)
const step = (id: string, op: string, extra: object = {}, plugin = 'org.example.a'): ReturnType<typeof makeStep> => makeStep({ id, plugin: { id: plugin, version: '1.0.0' }, op, params: { n: id }, ...extra })
const list = (...ops: Array<[string, string]>): StepList => ops.reduce((l, [id, op]) => addStep(l, step(id, op)), emptyStepList())
const fixed = '2026-11-09T10:00:00.000Z'

describe('a recipe is the current steps, in order', () => {
  it('keeps the order, names, parameters, personalisable flags and limits through a round trip', () => {
    const l = addStep(addStep(addStep(emptyStepList(),
      step('a', 'two', { name: 'Second op first' })),
      step('b', 'one', { personalisable_params: ['n'], personalisable_limits: { n: { max_lines: 2 } } })),
      step('c', 'two'))
    const back = parseRecipe(serializeRecipe(makeRecipe({ name: 'Mine', list: l, created: fixed })))
    expect(back.ok).toBe(true)
    const rec = back.recipe as Recipe
    expect(rec.name).toBe('Mine')
    expect(rec.steps.steps.map(s => s.id)).toEqual(['a', 'b', 'c'])
    expect(rec.steps.steps[0]!.name).toBe('Second op first')
    expect(rec.steps.steps[1]!.personalisable).toBe(true)
    expect(rec.steps.steps[1]!.personalisable_limits).toEqual({ n: { max_lines: 2 } })
    expect(rec.plugins).toEqual([{ id: 'org.example.a', version: '1.0.0' }])
    expect(rec.assets).toBeUndefined()       // nothing extra when no step refers to an asset
  })
  it('serialises the same recipe to the same text, whatever order the keys were made in', () => {
    const r1 = makeRecipe({ name: 'x', list: list(['a', 'one'], ['b', 'two']), created: fixed })
    const r2 = JSON.parse(JSON.stringify(r1)) as Recipe
    const shuffled = { plugins: r2.plugins, steps: r2.steps, created: r2.created, name: r2.name, version: 1, format: r2.format }
    expect(serializeRecipe(shuffled as Recipe)).toBe(serializeRecipe(r1))
  })
  it('keeps the assets a step refers to, and only those given', () => {
    const svg = btoa('<svg xmlns="http://www.w3.org/2000/svg"/>')
    const r = makeRecipe({ name: 'x', list: list(['a', 'one']), created: fixed, assets: [{ id: 'logo', name: 'logo.svg', mime: 'image/svg+xml', base64: svg }] })
    const p = parseRecipe(serializeRecipe(r))
    expect(p.ok && p.recipe.assets?.map(a => a.id)).toEqual(['logo'])
  })
})

describe('applying a recipe', () => {
  const r = (): Recipe => makeRecipe({ name: 'r', list: list(['s1', 'one'], ['s2', 'two'], ['s3', 'one']), created: fixed })
  it('appends the steps after the target steps, in the recipe order, with new ids', () => {
    const target = list(['s1', 'two'], ['s5', 'one'])
    const out = applyRecipe(target, r())
    expect(out.list.steps.map(s => `${s.id}:${s.op}`)).toEqual(['s1:two', 's5:one', 's6:one', 's7:two', 's8:one'])
    expect(out.added).toEqual(['s6', 's7', 's8'])
    expect(target.steps.length).toBe(2)   // the target is not changed
  })
  it('on an empty list the ids start at s1', () => {
    expect(applyRecipe(emptyStepList(), r()).list.steps.map(s => `${s.id}:${s.op}`)).toEqual(['s1:one', 's2:two', 's3:one'])
  })
  it('keeps names and personalisable settings, and leaves part references as written', () => {
    const l = addStep(emptyStepList(), makeStep({ id: 'a', plugin: { id: 'org.example.a', version: '1.0.0' }, op: 'one', name: 'Lid text', personalisable_params: ['part'], params: { part: 'Lid' } }))
    const s = applyRecipe(emptyStepList(), makeRecipe({ name: 'x', list: l })).list.steps[0]!
    expect([s.name, s.params['part'], s.personalisable_params]).toEqual(['Lid text', 'Lid', ['part']])
  })
  it('names the plugins that are missing and the ones in another version, and can skip what cannot run', () => {
    const l = addStep(addStep(addStep(emptyStepList(), step('a', 'one')), step('b', 'one', {}, 'org.example.gone')), step('c', 'nothing'))
    const rec = makeRecipe({ name: 'x', list: l, created: fixed })
    const p = recipeProblems(rec, registry())
    expect(p.missingPlugins).toEqual([{ id: 'org.example.gone', version: '1.0.0' }])
    expect(p.unknownOps).toEqual([{ stepId: 'c', plugin: 'org.example.a', op: 'nothing' }])
    const newer = new Registry().register({ manifest: mf('org.example.a', '1.2.0', ['one']), load: () => ({ run: () => ({}) }) } as never)
    expect(recipeProblems(rec, newer).versionDiffers).toEqual([{ id: 'org.example.a', recipe: '1.0.0', installed: '1.2.0' }])
    const out = applyRecipe(emptyStepList(), rec, { skipMissing: true, registry: registry() })
    expect(out.list.steps.map(s => s.op)).toEqual(['one'])
    expect(out.skipped.map(s => s.reason)).toEqual(['plugin_missing', 'operation_unknown'])
    expect(applyRecipe(emptyStepList(), rec).list.steps.length).toBe(3)   // without skipMissing everything is added
  })
})

describe('reading a recipe is strict', () => {
  const good = (): Record<string, unknown> => JSON.parse(serializeRecipe(makeRecipe({ name: 'ok', list: list(['a', 'one']), created: fixed }))) as Record<string, unknown>
  const code = (o: unknown): string | undefined => parseRecipe(typeof o === 'string' ? o : JSON.stringify(o)).errors[0]?.code
  it('refuses text that is not a recipe', () => {
    expect(code('{ nope')).toBe('recipe.not_json')
    expect(code({ hello: 1 })).toBe('recipe.not_a_recipe')
    expect(code([])).toBe('recipe.not_a_recipe')
    expect(code({ ...good(), format: 'other' })).toBe('recipe.not_a_recipe')
  })
  it('refuses a newer version', () => { expect(code({ ...good(), version: 2 })).toBe('recipe.version_newer') })
  it('checks the fields', () => {
    expect(code({ ...good(), name: '' })).toBe('recipe.field')
    expect(code({ ...good(), name: 'x'.repeat(121) })).toBe('recipe.field')
    expect(code({ ...good(), created: 'yesterday' })).toBe('recipe.field')
    expect(code({ ...good(), steps: { schema_version: 1, steps: [{ id: 'a' }] } })).toBe('recipe.steps_invalid')
  })
  it('refuses more than 100 steps and oversized text', () => {
    const many = { ...good(), steps: { schema_version: 1, steps: Array.from({ length: 101 }, (_, i) => step(`s${i}`, 'one')) } }
    expect(code(many)).toBe('recipe.too_many_steps')
    expect(code(JSON.stringify(good()).padEnd(5_000_000, ' '))).toBe('recipe.too_large')
    expect(code(JSON.stringify(good()).padEnd(1_100_000, ' '))).toBe('recipe.too_large')   // whitespace counts as text
  })
  it('refuses keys that could pollute an object, at any depth', () => {
    expect(code(JSON.stringify(good()).replace('"n":"a"', '"n":{"__proto__":{"x":1}}'))).toBe('recipe.unsafe_key')
    expect(code('{"format":"ateliermesh-recipe","version":1,"constructor":1}')).toBe('recipe.unsafe_key')
    expect(({} as Record<string, unknown>)['x']).toBeUndefined()
  })
  it('checks the assets (no fonts, valid base64, not too large)', () => {
    const svg = btoa('<svg xmlns="http://www.w3.org/2000/svg"/>')
    expect(code({ ...good(), assets: [{ id: 'f', name: 'f.ttf', mime: 'font/ttf', base64: svg }] })).toBe('recipe.bad_asset')          // fonts are never embedded
    expect(code({ ...good(), assets: [{ id: 'x', name: 'x', mime: 'image/png', base64: '!!!!' }] })).toBe('recipe.bad_asset')
    expect(code({ ...good(), assets: [{ id: 'big', name: 'big.png', mime: 'image/png', base64: 'A'.repeat(3_000_000) }] })).toBe('recipe.assets_too_large')
  })
  it('works out the plugin list from the steps itself, ignoring what the file claims', () => {
    const r = good(); (r as { plugins: unknown }).plugins = [{ id: 'evil.plugin', version: '9.9.9' }]
    const p = parseRecipe(JSON.stringify(r))
    expect(p.ok && p.recipe.plugins).toEqual([{ id: 'org.example.a', version: '1.0.0' }])
  })
})
