import { describe, expect, it } from 'vitest'
import Ajv from 'ajv/dist/2020'
import { ERROR_CODES, httpsUrlProblem, imageBytesProblem, manifestDocumentSchema, sniffImage, validateManifest } from '../src'

const base = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  manifest_version: 1, id: 'org.example.meta', name: 'Meta', version: '1.0.0', operations: [{ id: 'op', kind: 'modifier', params: [] }], ...extra,
})
const good = { license: 'MIT', description: 'Does one small thing to a model.' }
const codes = (m: unknown, require = true): string[] => validateManifest(m, { requireMetadata: require }).errors.map(e => e.code)
const first = (m: unknown): { code: string; params?: Record<string, unknown>; path?: string } | undefined => validateManifest(m, { requireMetadata: true }).errors[0]

describe('plugin metadata: licence, description, contact, package address', () => {
  it('accepts a manifest with everything', () => {
    const m = base({ ...good, contact: { url: 'https://example.org/plugins', email: 'maker@example.org', name: 'A. Maker' }, package_url: 'https://example.org/p/meta-1.0.0.amplugin' })
    expect(validateManifest(m, { requireMetadata: true }).ok).toBe(true)
  })
  it('asks for licence and description only when told to (external packages and built-in plugins)', () => {
    expect(validateManifest(base()).ok).toBe(true)
    expect(codes(base())).toEqual(['manifest.missing_license', 'manifest.missing_description'])
    expect(codes(base({ license: 'MIT' }))).toEqual(['manifest.missing_description'])
    expect(codes(base({ description: good.description }))).toEqual(['manifest.missing_license'])
    expect(codes(base({ license: '  ', description: '   ' }))).toEqual(['manifest.missing_license', 'manifest.missing_description'])
  })
  it('checks the licence: an SPDX-like identifier, 1 to 64 characters', () => {
    for (const ok of ['MIT', 'Apache-2.0', 'GPL-3.0-only', 'Proprietary', 'LGPL-2.1+', 'MIT OR Apache-2.0', 'CC-BY-4.0']) expect(codes(base({ ...good, license: ok }))).toEqual([])
    expect(first(base({ ...good, license: 'MIT<script>' }))).toMatchObject({ code: 'manifest.bad_license', params: { reason: 'bad_characters' }, path: 'license' })
    expect(first(base({ ...good, license: 'x'.repeat(65) }))).toMatchObject({ code: 'manifest.bad_license', params: { reason: 'too_long' } })
    expect(first(base({ ...good, license: 5 }))).toMatchObject({ code: 'manifest.bad_license', params: { reason: 'not_text' } })
  })
  it('checks the description: plain text of 10 to 300 characters', () => {
    expect(first(base({ ...good, description: 'too short' }))).toMatchObject({ code: 'manifest.bad_description', params: { reason: 'too_short' } })
    expect(first(base({ ...good, description: 'x'.repeat(301) }))).toMatchObject({ code: 'manifest.bad_description', params: { reason: 'too_long' } })
    expect(first(base({ ...good, description: 'line one\nline two of the text' }))).toMatchObject({ code: 'manifest.bad_description', params: { reason: 'bad_characters' } })
    expect(first(base({ ...good, description: 12 }))).toMatchObject({ code: 'manifest.bad_description', params: { reason: 'not_text' } })
    expect(codes(base({ ...good, description: 'x'.repeat(300) }))).toEqual([])
  })
  it('text that looks like markup is only text: it is not refused (the screens show it as text), and nothing is stripped', () => {
    const m = base({ license: 'MIT', description: '<img src=x onerror=alert(1)> makes a thing', contact: { name: '<b>Me</b>' } })
    const v = validateManifest(m, { requireMetadata: true })
    expect(v.ok).toBe(true)
    expect(v.value?.description).toBe('<img src=x onerror=alert(1)> makes a thing')
    expect(v.value?.contact?.name).toBe('<b>Me</b>')
  })
  it('checks the contact: https address, an email, a name, nothing else', () => {
    const c = (contact: unknown): ReturnType<typeof first> => first(base({ ...good, contact }))
    expect(c('me')).toMatchObject({ code: 'manifest.bad_contact', params: { field: 'contact', reason: 'not_an_object' } })
    expect(c({ url: 'http://example.org' })).toMatchObject({ code: 'manifest.bad_contact', params: { field: 'url', reason: 'not_https' } })
    expect(c({ url: 'javascript:alert(1)' })).toMatchObject({ params: { field: 'url', reason: 'not_https' } })
    expect(c({ url: 'https://user:pw@example.org' })).toMatchObject({ params: { field: 'url', reason: 'has_credentials' } })
    expect(c({ url: 'https://localhost/x' })).toMatchObject({ params: { field: 'url', reason: 'bad_host' } })
    expect(c({ url: 'https://example.org/' + 'a'.repeat(200) })).toMatchObject({ params: { field: 'url', reason: 'too_long' } })
    expect(c({ url: 'https://exa mple.org' })).toMatchObject({ params: { field: 'url' } })
    expect(c({ email: 'not an email' })).toMatchObject({ params: { field: 'email', reason: 'not_an_email' } })
    expect(c({ email: 'a@b' })).toMatchObject({ params: { field: 'email', reason: 'not_an_email' } })
    expect(c({ email: '"x"<a@b.org>' })).toMatchObject({ params: { field: 'email' } })
    expect(c({ name: '' })).toMatchObject({ params: { field: 'name', reason: 'empty' } })
    expect(c({ name: 'x'.repeat(81) })).toMatchObject({ params: { field: 'name', reason: 'too_long' } })
    expect(c({ phone: '123' })).toMatchObject({ params: { field: 'phone', reason: 'unknown_field' } })
    expect(codes(base({ ...good, contact: {} }))).toEqual([])        // every field is optional
  })
  it('checks the package address like a contact address (https only, no credentials, 300 characters)', () => {
    const p = (v: unknown): ReturnType<typeof first> => first(base({ ...good, package_url: v }))
    expect(p('https://example.org/a.amplugin')).toBeUndefined()
    expect(p('http://example.org/a.amplugin')).toMatchObject({ code: 'manifest.bad_package_url', params: { reason: 'not_https' } })
    expect(p('https://me:secret@example.org/a.amplugin')).toMatchObject({ params: { reason: 'has_credentials' } })
    expect(p('https://example.org/' + 'a'.repeat(300))).toMatchObject({ params: { reason: 'too_long' } })
    expect(p(7)).toMatchObject({ params: { reason: 'not_text' } })
    expect(httpsUrlProblem('https://example.org/x', 300)).toBeNull()
    expect(codes(base({ ...good }))).toEqual([])                     // optional
  })
  it('the new codes are in the list of error codes', () => {
    for (const c of ['manifest.missing_license', 'manifest.missing_description', 'manifest.bad_license', 'manifest.bad_description', 'manifest.bad_contact', 'manifest.bad_package_url']) expect(ERROR_CODES).toContain(c)
  })
  it('the JSON schema says the same: required fields, limits and the https rule', () => {
    const check = new Ajv({ strict: false, validateFormats: false }).compile(manifestDocumentSchema())
    expect(check(base({ ...good, contact: { url: 'https://example.org', email: 'a@b.org', name: 'Me' }, package_url: 'https://example.org/p.amplugin' }))).toBe(true)
    expect(check(base())).toBe(false)
    expect(check(base({ ...good, description: 'short' }))).toBe(false)
    expect(check(base({ ...good, license: 'bad<>' }))).toBe(false)
    expect(check(base({ ...good, contact: { url: 'http://example.org' } }))).toBe(false)
    expect(check(base({ ...good, contact: { phone: '1' } }))).toBe(false)
    expect(check(base({ ...good, package_url: 'http://example.org/p' }))).toBe(false)
    const loose = new Ajv({ strict: false, validateFormats: false }).compile(manifestDocumentSchema({ requireMetadata: false }))
    expect(loose(base())).toBe(true)
  })
  it('checks the example picture: a file path inside the package and an alt text of 5 to 160 characters', () => {
    const im = (v: unknown): ReturnType<typeof first> => first(base({ ...good, image: v }))
    expect(im({ file: 'assets/example.png', alt: 'A name tag with raised text' })).toBeUndefined()
    expect(im('x.png')).toMatchObject({ code: 'manifest.bad_image', params: { reason: 'not_an_object' } })
    for (const bad of ['../x.png', '/etc/x.png', 'a b.png', '', 'a//b.png', './x.png']) expect(im({ file: bad, alt: 'A fine description' })).toMatchObject({ code: 'manifest.bad_image', path: 'image.file' })
    expect(im({ file: 'x.png', alt: 'abc' })).toMatchObject({ params: { reason: 'too_short' } })
    expect(im({ file: 'x.png', alt: 'a'.repeat(161) })).toMatchObject({ params: { reason: 'too_long' } })
    expect(im({ file: 'x.png' })).toMatchObject({ params: { field: 'alt', reason: 'not_text' } })
    expect(im({ file: 'x.png', alt: 'A fine description', extra: 1 })).toMatchObject({ params: { reason: 'unknown_field' } })
    expect(ERROR_CODES).toContain('manifest.bad_image')
  })
  it('recognises PNG, JPEG and WebP by their first bytes and refuses the rest', () => {
    const png = (w: number, h: number): Uint8Array => { const b = new Uint8Array(33); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]); new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h); return b }
    expect(sniffImage(png(640, 420))).toEqual({ mime: 'image/png', width: 640, height: 420 })
    expect(imageBytesProblem(png(640, 420))).toBeNull()
    expect(imageBytesProblem(png(100, 80))?.code).toBe('package.image_dimensions')
    expect(imageBytesProblem(png(2000, 400))?.code).toBe('package.image_dimensions')
    const big = new Uint8Array(301 * 1024); big.set(png(640, 420)); expect(imageBytesProblem(big)?.code).toBe('package.image_too_big')
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 1, 164, 2, 128, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])
    expect(sniffImage(jpeg)).toEqual({ mime: 'image/jpeg', width: 640, height: 420 })
    const webp = new Uint8Array(30); webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]); webp.set([127, 2, 0, 163, 1, 0], 24)
    expect(sniffImage(webp)).toEqual({ mime: 'image/webp', width: 640, height: 420 })
    expect(imageBytesProblem(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))?.code).toBe('package.image_type')
    expect(imageBytesProblem(new Uint8Array(0))?.code).toBe('package.image_type')
  })
  it('the JSON schema knows the image field', () => {
    const check = new Ajv({ strict: false, validateFormats: false }).compile(manifestDocumentSchema())
    expect(check(base({ ...good, image: { file: 'assets/a.png', alt: 'What it shows' } }))).toBe(true)
    expect(check(base({ ...good, image: { file: '../a.png', alt: 'What it shows' } }))).toBe(false)
    expect(check(base({ ...good, image: { file: 'a.png' } }))).toBe(false)
  })
})
