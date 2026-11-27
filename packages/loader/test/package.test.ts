import { describe, expect, it } from 'vitest'
import { Registry, readZip, sha256Hex, writeZip } from '@ateliermesh/core'
import { createTestPlugin } from '@ateliermesh/core/testing'
import { buildPluginPackage, fetchPluginBytes, generateKeyPair, parsePluginUrl, readPluginPackage } from '../src'

const manifest = { manifest_version: 1 as const, id: 'ext.demo', name: 'Demo', version: '1.0.0', license: 'MIT', description: 'A demo plugin that does nothing at all.', permissions: ['wasm'], operations: [{ id: 'noop', kind: 'modifier' as const, params: [] }] }
const MAIN = 'export default { async run(op, ctx) { return { mesh: ctx.mesh } } }'
const enc = new TextEncoder()

describe('reading a package', () => {
  it('an unsigned package with hashes loads and is labelled unsigned', async () => {
    const pkg = await readPluginPackage(await buildPluginPackage({ manifest, main: MAIN, assets: { 'assets/data.bin': new Uint8Array([1, 2, 3]) } }))
    expect(pkg.manifest.id).toBe('ext.demo')
    expect(pkg.signed).toBe(false)
    expect(pkg.permissions).toEqual(['wasm'])
    expect(pkg.main).toBe(MAIN)
    expect(pkg.files.get('assets/data.bin')).toEqual(new Uint8Array([1, 2, 3]))
    expect(pkg.hash).toMatch(/^[0-9a-f]{64}$/)
    // the same files give the same identity
    expect((await readPluginPackage(await buildPluginPackage({ manifest, main: MAIN, assets: { 'assets/data.bin': new Uint8Array([1, 2, 3]) } }))).hash).toBe(pkg.hash)
  })

  it('a package without any hash file also loads (labelled unsigned)', async () => {
    const pkg = await readPluginPackage(await buildPluginPackage({ manifest, main: MAIN, hashes: false }))
    expect(pkg.signed).toBe(false)
  })

  it('a signed package verifies against a trusted key and names the signer', async () => {
    const keys = await generateKeyPair()
    const bytes = await buildPluginPackage({ manifest, main: MAIN, privateKey: keys.privateKey })
    const pkg = await readPluginPackage(bytes, { trustedKeys: [{ name: 'Anna', publicKey: keys.publicKey }] })
    expect(pkg.signed).toBe(true)
    expect(pkg.signer).toBe('Anna')
  })

  it('a signature from a key the user does not trust is refused, not shown as unsigned', async () => {
    const mine = await generateKeyPair(), theirs = await generateKeyPair()
    const bytes = await buildPluginPackage({ manifest, main: MAIN, privateKey: theirs.privateKey })
    await expect(readPluginPackage(bytes, { trustedKeys: [{ name: 'me', publicKey: mine.publicKey }] })).rejects.toMatchObject({ params: { reason: 'signature_not_trusted' } })
    await expect(readPluginPackage(bytes)).rejects.toMatchObject({ params: { reason: 'signature_not_trusted' } })
  })

  const rebuild = async (bytes: Uint8Array, mutate: (f: Array<{ name: string; data: Uint8Array }>) => void): Promise<Uint8Array> => {
    const f = (await readZip(bytes)).map(e => ({ name: e.name, data: e.data.slice() })); mutate(f); return writeZip(f)
  }

  it('a tampered file, an extra file and a removed file are refused', async () => {
    const good = await buildPluginPackage({ manifest, main: MAIN, assets: { 'assets/a.bin': new Uint8Array([9]) } })
    await expect(readPluginPackage(await rebuild(good, f => { f.find(e => e.name === 'main.js')!.data = enc.encode(MAIN + ' // evil') }))).rejects.toMatchObject({ params: { reason: 'hash_mismatch', path: 'main.js' } })
    await expect(readPluginPackage(await rebuild(good, f => { f.push({ name: 'extra.js', data: enc.encode('x') }) }))).rejects.toMatchObject({ params: { reason: 'unlisted_file' } })
    await expect(readPluginPackage(await rebuild(good, f => { f.splice(f.findIndex(e => e.name === 'assets/a.bin'), 1) }))).rejects.toMatchObject({ params: { reason: 'listed_file_missing' } })
  })

  it('a signed package whose files were changed afterwards is refused even if the listing is edited to match', async () => {
    const keys = await generateKeyPair()
    const signed = await buildPluginPackage({ manifest, main: MAIN, privateKey: keys.privateKey })
    const evil = await rebuild(signed, f => {
      f.find(e => e.name === 'main.js')!.data = enc.encode('export default { run() { return {} } }')
      const l = f.find(e => e.name === 'manifest.sha256')!
      l.data = enc.encode(l.data.length ? new TextDecoder().decode(l.data).replace(/^[0-9a-f]{64}( {2}main\.js)$/m, `${sha256Hex(enc.encode('export default { run() { return {} } }'))}$1`) : '')
    })
    await expect(readPluginPackage(evil, { trustedKeys: [{ name: 'me', publicKey: keys.publicKey }] })).rejects.toMatchObject({ params: { reason: 'signature_not_trusted' } })
  })

  it('refuses broken manifests, a missing main, path traversal, duplicates and zip bombs', async () => {
    await expect(readPluginPackage(writeZip([{ name: 'main.js', data: enc.encode(MAIN) }]))).rejects.toMatchObject({ params: { reason: 'missing_manifest' } })
    await expect(readPluginPackage(writeZip([{ name: 'manifest.json', data: enc.encode('{nope') }, { name: 'main.js', data: enc.encode(MAIN) }]))).rejects.toMatchObject({ params: { reason: 'manifest_not_json' } })
    await expect(readPluginPackage(writeZip([{ name: 'manifest.json', data: enc.encode(JSON.stringify({ ...manifest, id: 'BAD ID' })) }, { name: 'main.js', data: enc.encode(MAIN) }]))).rejects.toMatchObject({ params: { reason: 'invalid_manifest' } })
    await expect(readPluginPackage(writeZip([{ name: 'manifest.json', data: enc.encode(JSON.stringify(manifest)) }]))).rejects.toMatchObject({ params: { reason: 'missing_main' } })
    await expect(readPluginPackage(writeZip([{ name: '../evil.js', data: enc.encode('x') }, { name: 'manifest.json', data: enc.encode(JSON.stringify(manifest)) }, { name: 'main.js', data: enc.encode(MAIN) }]))).rejects.toMatchObject({ params: { reason: 'bad_zip' } })
    await expect(readPluginPackage(writeZip([{ name: 'main.js', data: enc.encode('a') }, { name: 'main.js', data: enc.encode('b') }, { name: 'manifest.json', data: enc.encode(JSON.stringify(manifest)) }]))).rejects.toMatchObject({ params: { reason: 'bad_zip' } })
    const bomb = await buildPluginPackage({ manifest, main: MAIN, assets: { 'assets/zeros.bin': new Uint8Array(30_000_000) }, hashes: false })
    await expect(readPluginPackage(bomb, { limits: { maxExpandedBytes: 10_000_000, maxCompressedBytes: 100_000_000 } })).rejects.toMatchObject({ params: { reason: 'bad_zip' } })
    await expect(readPluginPackage(new Uint8Array(100), { limits: { maxCompressedBytes: 50 } })).rejects.toMatchObject({ params: { reason: 'too_large' } })
    await expect(readPluginPackage(new Uint8Array(100))).rejects.toMatchObject({ code: 'loader.invalid_package' })
  })

  it('refuses a package without a licence or a description, naming what is missing, and a bad contact or package address', async () => {
    const issues = async (m: Record<string, unknown>): Promise<string[]> => {
      try { await readPluginPackage(await buildPluginPackage({ manifest: m as typeof manifest, main: MAIN })) } catch (e) { return ((e as { params?: { issues?: Array<{ code: string }> } }).params?.issues ?? []).map(i => i.code) }
      return []
    }
    const { license: _l, description: _d, ...bare } = manifest
    expect(await issues(bare)).toEqual(['manifest.missing_license', 'manifest.missing_description'])
    expect(await issues({ ...bare, license: 'MIT' })).toEqual(['manifest.missing_description'])
    expect(await issues({ ...manifest, contact: { url: 'http://example.org' } })).toEqual(['manifest.bad_contact'])
    expect(await issues({ ...manifest, package_url: 'ftp://example.org/p.amplugin' })).toEqual(['manifest.bad_package_url'])
    const ok = await readPluginPackage(await buildPluginPackage({ manifest: { ...manifest, contact: { name: 'Me', url: 'https://example.org' }, package_url: 'https://example.org/p.amplugin' } as typeof manifest, main: MAIN }))
    expect(ok.manifest.contact?.name).toBe('Me'); expect(ok.manifest.package_url).toBe('https://example.org/p.amplugin')
  })

  it('refuses a name that clashes with a built-in plugin or an equal or newer loaded version, and accepts a newer one', async () => {
    const builtin = new Registry().register(createTestPlugin().entry)
    const clash = await buildPluginPackage({ manifest: { ...manifest, id: 'test.core' }, main: MAIN })
    await expect(readPluginPackage(clash, { registry: builtin })).rejects.toMatchObject({ params: { reason: 'clashes_with_builtin' } })
    const reg = new Registry().register({ manifest: { ...manifest }, load: () => ({ run: () => ({}) }), untrusted: true, source: { kind: 'package' } })
    await expect(readPluginPackage(await buildPluginPackage({ manifest, main: MAIN }), { registry: reg })).rejects.toMatchObject({ params: { reason: 'already_loaded' } })
    const newer = await readPluginPackage(await buildPluginPackage({ manifest: { ...manifest, version: '1.1.0' }, main: MAIN }), { registry: reg })
    expect(newer.manifest.version).toBe('1.1.0')
  })
})

describe('loading from a URL', () => {
  it('https only, http in development mode, no credentials, an optional hash pin', () => {
    expect(parsePluginUrl('https://example.org/p.amplugin').url).toBe('https://example.org/p.amplugin')
    expect(() => parsePluginUrl('http://example.org/p.amplugin')).toThrowError(expect.objectContaining({ code: 'loader.bad_url', params: expect.objectContaining({ reason: 'scheme_not_allowed' }) as unknown }))
    expect(parsePluginUrl('http://192.168.1.5:8080/p.amplugin', true).url).toBe('http://192.168.1.5:8080/p.amplugin')
    expect(() => parsePluginUrl('file:///etc/passwd', true)).toThrow()
    expect(() => parsePluginUrl('javascript:alert(1)', true)).toThrow()
    expect(() => parsePluginUrl('https://user:pw@example.org/p')).toThrowError(expect.objectContaining({ params: expect.objectContaining({ reason: 'credentials_in_url' }) as unknown }))
    expect(() => parsePluginUrl('not a url')).toThrow()
    const hash = 'a'.repeat(64)
    expect(parsePluginUrl(`https://example.org/p.amplugin#sha256=${hash}`)).toEqual({ url: 'https://example.org/p.amplugin', sha256: hash })
    expect(() => parsePluginUrl('https://example.org/p#sha256=zzz')).toThrowError(expect.objectContaining({ params: expect.objectContaining({ reason: 'bad_sha256_pin' }) as unknown }))
  })

  const response = (bytes: Uint8Array, init: { status?: number; url?: string; length?: number } = {}): Response => {
    const r = new Response(bytes as BlobPart, { status: init.status ?? 200, headers: init.length !== undefined ? { 'content-length': String(init.length) } : {} })
    Object.defineProperty(r, 'url', { value: init.url ?? 'https://example.org/p.amplugin' })
    return r
  }

  it('downloads once with no credentials, checks the pin, and caps the size while streaming', async () => {
    const body = enc.encode('hello package')
    let seen: RequestInit | undefined
    const f = (async (_u: string, init?: RequestInit) => { seen = init; return response(body) }) as unknown as typeof fetch
    const got = await fetchPluginBytes(`https://example.org/p.amplugin#sha256=${sha256Hex(body)}`, { fetch: f })
    expect(got.bytes).toEqual(body)
    expect(seen).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' })
    await expect(fetchPluginBytes(`https://example.org/p.amplugin#sha256=${'0'.repeat(64)}`, { fetch: f })).rejects.toMatchObject({ params: { reason: 'hash_pin_mismatch' } })
    await expect(fetchPluginBytes('https://example.org/p.amplugin', { fetch: (async () => response(new Uint8Array(100))) as unknown as typeof fetch, maxBytes: 50 })).rejects.toMatchObject({ params: { reason: 'too_large' } })
    await expect(fetchPluginBytes('https://example.org/p.amplugin', { fetch: (async () => response(new Uint8Array(10), { length: 99999999 })) as unknown as typeof fetch })).rejects.toMatchObject({ params: { reason: 'too_large' } })
    await expect(fetchPluginBytes('https://example.org/p.amplugin', { fetch: (async () => response(body, { status: 404 })) as unknown as typeof fetch })).rejects.toMatchObject({ params: { reason: 'http_error', status: 404 } })
    await expect(fetchPluginBytes('https://example.org/p.amplugin', { fetch: (async () => response(body, { url: 'http://evil.example/x' })) as unknown as typeof fetch })).rejects.toMatchObject({ params: { reason: 'redirect_to_disallowed_scheme' } })
    // a fetch that is never made: the scheme is refused before anything goes out
    let called = false
    await expect(fetchPluginBytes('http://example.org/p.amplugin', { fetch: (async () => { called = true; return response(body) }) as unknown as typeof fetch })).rejects.toBeTruthy()
    expect(called).toBe(false)
  })
})

describe('the example picture of a package', () => {
  const png = (w: number, h: number, extra = 0): Uint8Array => { const b = new Uint8Array(33 + extra); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]); new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h); return b }
  const withImage = { ...manifest, image: { file: 'assets/example.png', alt: 'What the plugin does to a box' } }
  const reason = async (p: Promise<unknown>): Promise<string | undefined> => p.then(() => undefined, (e: { params?: { reason?: string } }) => e.params?.reason)
  it('is handed to the host with its type and alt text', async () => {
    const pkg = await readPluginPackage(await buildPluginPackage({ manifest: withImage, main: MAIN, assets: { 'assets/example.png': png(640, 420) } }))
    expect(pkg.image).toMatchObject({ mime: 'image/png', alt: 'What the plugin does to a box' })
    expect(pkg.image?.bytes.length).toBe(33)
  })
  it('a package without an image has none', async () => {
    expect((await readPluginPackage(await buildPluginPackage({ manifest, main: MAIN }))).image).toBeUndefined()
  })
  it('refuses a missing file, a wrong type, a size that is too big and dimensions that are not allowed', async () => {
    expect(await reason(readPluginPackage(await buildPluginPackage({ manifest: withImage, main: MAIN })))).toBe('image_missing')
    expect(await reason(readPluginPackage(await buildPluginPackage({ manifest: withImage, main: MAIN, assets: { 'assets/example.png': enc.encode('<svg/>') } })))).toBe('image_type')
    expect(await reason(readPluginPackage(await buildPluginPackage({ manifest: withImage, main: MAIN, assets: { 'assets/example.png': png(640, 420, 310 * 1024) } })))).toBe('image_too_big')
    expect(await reason(readPluginPackage(await buildPluginPackage({ manifest: withImage, main: MAIN, assets: { 'assets/example.png': png(100, 100) } })))).toBe('image_dimensions')
  })
})

