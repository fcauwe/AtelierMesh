import { describe, expect, it } from 'vitest'
import { validateManifest } from '../src'

const manifest = (op: Record<string, unknown>): unknown => ({
  manifest_version: 1, id: 'org.example.h', name: 'H', version: '1.0.0',
  operations: [{ id: 'op', kind: 'modifier', params: [{ name: 'a', type: 'float', default: 1, min: 0, max: 10 }], ...op }],
})
const withParam = (param: Record<string, unknown>): unknown => manifest({ params: [{ name: 'a', type: 'float', default: 1, min: 0, max: 10, ...param }] })
const reasons = (r: ReturnType<typeof validateManifest>): string[] => r.errors.map(e => String((e.params as { reason?: string } | undefined)?.reason))

describe('manifest presentation hints', () => {
  it('are all optional: a manifest without them is still valid', () => {
    expect(validateManifest(manifest({})).ok).toBe(true)
  })
  it('accepts a valid widget for the type of the parameter', () => {
    expect(validateManifest(withParam({ widget: 'slider' })).ok).toBe(true)
    expect(validateManifest(withParam({ widget: 'stepper' })).ok).toBe(true)
    expect(validateManifest(manifest({ params: [{ name: 'm', type: 'enum', default: 'a', options: ['a', 'b'], widget: 'segmented' }] })).ok).toBe(true)
    expect(validateManifest(manifest({ params: [{ name: 'm', type: 'enum', default: 'a', options: ['a', 'b'], widget: 'cards' }] })).ok).toBe(true)
    expect(validateManifest(manifest({ params: [{ name: 'v', type: 'vector', size: 3, default: [0, 0, 0], widget: 'axes' }] })).ok).toBe(true)
    expect(validateManifest(manifest({ params: [{ name: 'f', type: 'asset', default: null, widget: 'font' }] })).ok).toBe(true)
  })
  it('refuses a widget that does not fit the type', () => {
    expect(reasons(validateManifest(withParam({ widget: 'segmented' })))).toContain('bad_widget')
    expect(reasons(validateManifest(manifest({ params: [{ name: 'm', type: 'enum', default: 'a', options: ['a'], widget: 'slider' }] })))).toContain('bad_widget')
    expect(reasons(validateManifest(withParam({ widget: 'nonsense' })))).toContain('bad_widget')
    expect(reasons(validateManifest(withParam({ widget: 5 })))).toContain('bad_widget')
  })
  it('wants a range for a slider', () => {
    expect(reasons(validateManifest(manifest({ params: [{ name: 'a', type: 'float', default: 1, widget: 'slider' }] })))).toContain('slider_needs_range')
  })
  it('checks importance, icon names and help', () => {
    expect(validateManifest(withParam({ importance: 'main', icon: 'ruler', help: 'text' })).ok).toBe(true)
    for (const v of ['main', 'normal', 'advanced']) expect(validateManifest(withParam({ importance: v })).ok).toBe(true)
    expect(reasons(validateManifest(withParam({ importance: 'huge' })))).toContain('bad_importance')
    expect(reasons(validateManifest(withParam({ icon: 'Not An Icon' })))).toContain('bad_icon')
    expect(reasons(validateManifest(withParam({ icon: 3 })))).toContain('bad_icon')
    expect(reasons(validateManifest(withParam({ help: 3 })))).toContain('bad_help')
  })
  it('accepts an icon on an enum option and refuses a bad one', () => {
    const e = (icon: unknown): unknown => manifest({ params: [{ name: 'm', type: 'enum', default: 'a', options: [{ value: 'a', label: 'A', icon }, 'b'] }] })
    expect(validateManifest(e('arrow-up')).ok).toBe(true)
    expect(reasons(validateManifest(e('Bad Name')))).toContain('bad_icon')
  })
  it('accepts a shape (path data) on an enum option and refuses anything else', () => {
    const e = (shape: unknown, n = 2): unknown => manifest({ params: [{ name: 'm', type: 'enum', default: 'a', options: Array.from({ length: n }, (_, i) => ({ value: i === 0 ? 'a' : `o${i}`, label: 'A', shape })) }] })
    expect(validateManifest(e('M8 7h8a5 5 0 0 1 0 10H8A5 5 0 0 1 8 7z')).ok).toBe(true)
    for (const bad of ['<svg/>', 'M0 0 L1 1 <script>', 'url(#x)', 'x', '', 3, `M${'1 '.repeat(600)}`, 'M0 0;alert(1)']) expect(reasons(validateManifest(e(bad)))).toContain('bad_shape')
    expect(validateManifest(e('M0 0h1', 64)).ok).toBe(true)
    expect(reasons(validateManifest(e('M0 0h1', 65)))).toContain('bad_shape')
  })
  it('checks the shape_style of an enum', () => {
    const e = (v: unknown, type = 'enum'): unknown => manifest({ params: [{ name: 'm', type, default: type === 'enum' ? 'a' : 1, ...(type === 'enum' ? { options: ['a', 'b'] } : {}), shape_style: v }] })
    expect(validateManifest(e('fill')).ok).toBe(true)
    expect(validateManifest(e('line')).ok).toBe(true)
    expect(reasons(validateManifest(e('solid')))).toContain('bad_shape_style')
    expect(reasons(validateManifest(e('fill', 'int')))).toContain('bad_shape_style')
  })
  it('checks the icon and the summary of an operation', () => {
    expect(validateManifest(manifest({ icon: 'twist', summary: '{{a}}°' })).ok).toBe(true)
    expect(reasons(validateManifest(manifest({ icon: 'No Good' })))).toContain('bad_icon')
    expect(reasons(validateManifest(manifest({ summary: '{{nope}} mm' })))).toContain('summary_unknown_param')
    expect(reasons(validateManifest(manifest({ summary: 5 })))).toContain('bad_summary')
    expect(reasons(validateManifest(manifest({ summary: 'x'.repeat(121) })))).toContain('bad_summary')
  })
})
