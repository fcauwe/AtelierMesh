import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import { Registry, addStep, emptyStepList, makeStep, measureMesh, runWorkflow } from '@ateliermesh/core'
import type { PluginModule } from '@ateliermesh/core'
import { lBracketMesh } from '@ateliermesh/core/testing'
import { readPluginPackage, sandboxPage, allowedOrigins } from '../src'

const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/amplugin.mjs')
const run = (cwd: string, ...args: string[]): string => execFileSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' })

describe('the amplugin command line tool', () => {
  it('keygen, pack a TypeScript plugin with an asset, sign it, and inspect it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'am-cli-'))
    const src = path.join(dir, 'myplugin')
    mkdirSync(path.join(src, 'assets'), { recursive: true })
    writeFileSync(path.join(src, 'manifest.json'), JSON.stringify({ manifest_version: 1, id: 'ext.cli', name: 'CLI plugin', version: '0.2.0', license: 'MIT', description: 'A plugin made by the command line test.', operations: [{ id: 'noop', kind: 'modifier', params: [] }] }))
    writeFileSync(path.join(src, 'main.ts'), `const helper = (n: number): number => n * 2\nexport default { async run(_op: string, ctx: { mesh?: unknown }) { void helper(1); return { mesh: ctx.mesh } } }\n`)
    writeFileSync(path.join(src, 'assets', 'notes.txt'), 'hello')
    run(dir, 'keygen', 'me')
    run(dir, 'pack', 'myplugin', '--key', 'me.key', '--out', 'out/ext.cli.amplugin')
    const bytes = new Uint8Array(readFileSync(path.join(dir, 'out/ext.cli.amplugin')))
    const pub = readFileSync(path.join(dir, 'me.pub'), 'utf8').trim()
    const pkg = await readPluginPackage(bytes, { trustedKeys: [{ name: 'me', publicKey: pub }] })
    expect(pkg.signed).toBe(true); expect(pkg.signer).toBe('me')
    expect(pkg.main).toContain('export')                 // the TypeScript was compiled to a plain module
    expect(pkg.main).not.toContain(': number')
    expect(new TextDecoder().decode(pkg.files.get('assets/notes.txt'))).toBe('hello')
    const info = JSON.parse(run(dir, 'inspect', 'out/ext.cli.amplugin', '--trust', 'me.pub')) as { id: string; signed: boolean; signer: string }
    expect(info).toMatchObject({ id: 'ext.cli', signed: true, signer: 'me' })
    // inspecting without trusting the key refuses the package
    expect(() => run(dir, 'inspect', 'out/ext.cli.amplugin')).toThrow()
  })
  it('pack puts locales/ into the package and refuses texts outside the plugin\'s namespace', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'am-cli-loc-'))
    const src = path.join(dir, 'p')
    mkdirSync(path.join(src, 'locales'), { recursive: true })
    writeFileSync(path.join(src, 'manifest.json'), JSON.stringify({ manifest_version: 1, id: 'ext.words', name: 'Words', version: '1.0.0', license: 'MIT', description: 'A plugin with texts, made by the command line test.', operations: [{ id: 'noop', kind: 'modifier', params: [] }] }))
    writeFileSync(path.join(src, 'main.js'), 'export default { async run(_op, ctx) { return { mesh: ctx.mesh } } }\n')
    writeFileSync(path.join(src, 'locales', 'nl.json'), JSON.stringify({ ops: { noop: { title: 'Niets' } } }))
    run(dir, 'pack', 'p', '--out', 'a.amplugin')
    const pkg = await readPluginPackage(new Uint8Array(readFileSync(path.join(dir, 'a.amplugin'))))
    expect(pkg.locales.texts['nl']).toEqual({ 'ops.noop.title': 'Niets' })
    writeFileSync(path.join(src, 'locales', 'en.json'), JSON.stringify({ panel: { save: 'Hacked' } }))
    expect(() => execFileSync(process.execPath, [bin, 'pack', 'p', '--out', 'b.amplugin'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' })).toThrow(/outside_namespace/)
  })
  it('prints usage and a non-zero exit for a bad call', () => {
    expect(() => run(tmpdir(), 'pack', '/nonexistent')).toThrow()
  })
})

describe('the example plugin in examples/plugins/mirror', () => {
  it('packs with the tool, loads, and mirrors a mesh without changing its volume or turning it inside out', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
    const dir = mkdtempSync(path.join(tmpdir(), 'am-mirror-'))
    run(dir, 'pack', path.join(root, 'examples/plugins/mirror'), '--out', 'mirror.amplugin')
    const pkg = await readPluginPackage(new Uint8Array(readFileSync(path.join(dir, 'mirror.amplugin'))))
    const mod = (await import(`data:text/javascript;base64,${Buffer.from(pkg.main).toString('base64')}`)) as { default: PluginModule }
    const entry = { manifest: pkg.manifest, load: () => mod.default }
    const src = lBracketMesh()
    const list = addStep(emptyStepList(), makeStep({ id: 'm', plugin: { id: pkg.manifest.id, version: pkg.manifest.version }, op: 'mirror', params: { axis: 'x' } }))
    const r = await runWorkflow(list, { registry: new Registry().register(entry), source: src })
    expect(r.ok, JSON.stringify(r.results[0]!.error)).toBe(true)
    const a = measureMesh(src), b = measureMesh(r.mesh!)
    expect(b.volume).toBeCloseTo(a.volume, 6); expect(b.watertight).toBe(true)
    expect(b.bbox.min[0]).toBeCloseTo(a.bbox.min[0], 9)     // the plane runs through the middle: the box stays where it was
    // the L's notch was at the right (x 20 to 40, y 10 to 20); mirrored it is at the left, so a corner appears at (40, 20) that was not there
    const has = (m: { positions: Float64Array }, x: number, y: number): boolean => { for (let i = 0; i < m.positions.length; i += 3) if (Math.abs(m.positions[i]! - x) < 1e-9 && Math.abs(m.positions[i + 1]! - y) < 1e-9) return true; return false }
    expect(has(src, 40, 20)).toBe(false)
    expect(has(r.mesh!, 40, 20)).toBe(true)
    expect(Array.from(src.positions)).toEqual(Array.from(lBracketMesh().positions))   // the input was not changed
  })
})

describe('the sandbox page policy', () => {
  it('allows no network by default and only the origins the user approved', () => {
    expect(sandboxPage('n', [])).toContain("connect-src 'none'")
    expect(sandboxPage('n', ['wasm'])).toContain("connect-src 'none'")
    expect(sandboxPage('n', ['network:https://api.example.org'])).toContain('connect-src https://api.example.org"')
    expect(allowedOrigins(['network:https://a.org', 'network:javascript:alert(1)', 'network:*', 'wasm', 'network:https://b.org:8443'])).toEqual(['https://a.org', 'https://b.org:8443'])
    expect(sandboxPage('abc', [])).toContain("script-src 'nonce-abc' blob: 'wasm-unsafe-eval'")
    expect(sandboxPage('abc', [])).toContain("worker-src blob:")
  })

  it('check fails a text outside the plugin\'s namespace and says where it belongs', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'am-cli-'))
    run(dir, 'new', 'blocks-test')
    const loc = path.join(dir, 'blocks-test', 'locales', 'en.json')
    const j = JSON.parse(readFileSync(loc, 'utf8')) as { ops: Record<string, unknown>; work?: Record<string, string>; mesh?: Record<string, unknown> }
    j.work = { build_blocks: 'Building the blocks…' }
    ;(j as Record<string, unknown>)['shift'] = { too_big: 'Too big.' }
    writeFileSync(loc, JSON.stringify(j, null, 2))
    let out = ''
    try { run(dir, 'check', 'blocks-test'); out = 'passed' } catch (e) { out = String((e as { stdout?: string }).stdout ?? e) }
    expect(out).toContain('work.build_blocks')
    expect(out).toContain('Move it to ops.shift.stage.build_blocks')
    expect(out).toContain('Move it to mesh.shift.too_big')
  })
})
