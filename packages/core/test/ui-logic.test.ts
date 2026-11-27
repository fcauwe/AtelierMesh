import { describe, expect, it } from 'vitest'
import { clampParam, createTranslator, evalExpr, exprIdentifiers, optionKey, paramKey, parseExpr, validateManifest } from '../src'
import { testManifest } from '../src/testing'

describe('conditions (visible_if, enabled_if)', () => {
  const v = { projection: 'planar', use_mask: false, size: 5, name: '' }
  it('evaluates comparison and boolean operators', () => {
    expect(evalExpr("projection == 'planar' || use_mask", v)).toBe(true)
    expect(evalExpr("projection != 'planar' && use_mask", v)).toBe(false)
    expect(evalExpr('!use_mask', v)).toBe(true)
    expect(evalExpr('size > 3 && size <= 5', v)).toBe(true)
    expect(evalExpr('(size < 3 || use_mask) == false', v)).toBe(true)
    expect(evalExpr('name', v)).toBe(false)             // an empty string is false
    expect(evalExpr('missing', v)).toBe(false)          // a missing value is false, not an error
    expect(evalExpr("size > 'a'", v)).toBe(false)       // ordering is for numbers only
    expect([...exprIdentifiers(parseExpr("a == 1 && (b || !c)"))].sort()).toEqual(['a', 'b', 'c'])
  })
  it('refuses code, calls, properties, long and deep input', () => {
    for (const bad of ['', 'a.b', 'a()', 'a = 1', 'alert(1)', 'a ? b : c', '1 +', '(a', 'a b', "a == 'x", '`x`', 'a[0]', '{}']) {
      expect(() => parseExpr(bad), bad).toThrowError(expect.objectContaining({ code: 'expr.invalid' }))
    }
    expect(() => parseExpr('a'.repeat(400))).toThrow()
    expect(() => parseExpr('('.repeat(40) + 'a' + ')'.repeat(40))).toThrow()
    expect(() => parseExpr('!'.repeat(40) + 'a')).toThrow()
  })
  it('the manifest check rejects broken conditions and unknown parameter names', () => {
    const m = JSON.parse(JSON.stringify(testManifest())) as ReturnType<typeof testManifest>
    const p = m.operations[0]!.params
    p[1]!.visible_if = "factor > 2 && label != ''"
    expect(validateManifest(m).ok).toBe(true)
    p[1]!.visible_if = 'nope == 1'
    expect(validateManifest(m).errors[0]).toMatchObject({ params: { reason: 'condition_unknown_param', names: ['nope'] } })
    p[1]!.visible_if = 'factor >'
    expect(validateManifest(m).errors[0]).toMatchObject({ params: { reason: 'bad_condition' } })
  })
})

describe('translations', () => {
  const plugin = {
    en: { [paramKey('resize', 'factor', 'label')]: 'Scale factor', [paramKey('resize', 'factor', 'help')]: 'How much bigger' },
    nl: { [paramKey('resize', 'factor', 'label')]: 'Schaalfactor' },
  }
  it('walks host override, plugin text, language prefix, fallback language, manifest text, name', () => {
    const k = paramKey('resize', 'factor', 'label')
    const nl = createTranslator({ lang: 'nl-BE', plugin })
    expect(nl(k)).toBe('Schaalfactor')
    expect(nl(paramKey('resize', 'factor', 'help'))).toBe('How much bigger')          // falls back to en
    expect(createTranslator({ lang: 'nl', plugin, overrides: { nl: { [k]: 'Vergroting' } } })(k)).toBe('Vergroting')
    expect(createTranslator({ lang: 'fr', plugin })(k)).toBe('Scale factor')           // fr missing: en
    expect(createTranslator({ lang: 'fr', plugin: {} })(k, 'Factor from manifest')).toBe('Factor from manifest')
    expect(createTranslator({ lang: 'fr', plugin: {} })(optionKey('op', 'mode', 'xy'))).toBe('xy')
  })
})

describe('clamping typed values', () => {
  it('limits, rounds and snaps', () => {
    const f = { name: 'f', type: 'float', default: 1, min: 0.1, max: 10 } as const
    expect(clampParam(f, 5000)).toBe(10); expect(clampParam(f, -3)).toBe(0.1); expect(clampParam(f, NaN)).toBe(1); expect(clampParam(f, '7')).toBe(1)
    const i = { name: 'i', type: 'int', default: 3, min: 0, max: 10, step: 2 } as const
    expect(clampParam(i, 4.6)).toBe(6); expect(clampParam(i, 99)).toBe(10)
    expect(clampParam({ name: 'a', type: 'angle', default: 0, min: 0, wrap: true }, -90)).toBe(270)
    expect(clampParam({ name: 'v', type: 'vector', size: 2, default: [0, 0], min: 0, max: 5 }, [9, -1])).toEqual([5, 0])
    expect(clampParam({ name: 's', type: 'string', default: '', max_length: 3 }, 'abcdef')).toBe('abc')
  })
})
