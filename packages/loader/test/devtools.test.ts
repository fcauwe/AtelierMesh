import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { scanSource } from '../src/devtools'

const here = path.dirname(fileURLToPath(import.meta.url))
const bin = path.resolve(here, '../bin/amplugin.mjs')
const plain = path.resolve(here, '../../../examples/plugins/mirror-plain')
const cli = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' })

describe('amplugin new, check and run (no npm)', () => {
  it('new writes a template that passes check', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'am-dev-'))
    expect(cli(dir, 'new', 'my-shift').status).toBe(0)
    for (const f of ['manifest.json', 'main.js', 'fixtures.json', 'locales/nl.json']) expect(existsSync(path.join(dir, 'my-shift', f))).toBe(true)
    const r = cli(dir, 'check', 'my-shift')
    expect(r.status).toBe(0); expect(r.stdout).toMatch(/0 failed/)
    expect(cli(dir, 'new', 'my-shift').status).not.toBe(0)             // not over an existing folder
    expect(cli(dir, 'new', 'Bad Name').status).not.toBe(0)
  })
  it('check passes on the plain Mirror example, fixtures included', () => {
    const r = cli(tmpdir(), 'check', plain)
    expect(r.status).toBe(0); expect(r.stdout).toMatch(/fixture: flip a 10 x 20 x 30 box/); expect(r.stdout).toMatch(/0 failed/)
  })
  it('drawings and stored items: check passes on the shape-fit example; run takes a drawing in and a stored drawing with --payload', () => {
    const shape = path.resolve(here, '../../../examples/plugins/shape-fit-plain')
    const c = cli(tmpdir(), 'check', shape)
    expect(c.status, c.stdout).toBe(0); expect(c.stdout).toMatch(/fixture: a 10 mm cube fitted to a stored 40 x 20 drawing/); expect(c.stdout).toMatch(/0 failed/)
    const block = cli(tmpdir(), 'run', shape, '--op', 'block_from_drawing', '--input', 'drawing:square:40,20', '--params', '{"height":4}')
    expect(block.status, block.stderr).toBe(0); expect(block.stdout).toMatch(/size 40 x 20 x 4 mm/)
    const fit = cli(tmpdir(), 'run', shape, '--op', 'fit_to_shape', '--input', 'generator:box:10,10,10', '--payload', 'shape=drawing:square:40,20')
    expect(fit.status, fit.stderr).toBe(0); expect(fit.stdout).toMatch(/volume 8000 mm3/); expect(fit.stdout).toMatch(/"scale":2/)
    const missing = cli(tmpdir(), 'run', shape, '--op', 'fit_to_shape', '--input', 'generator:box:10,10,10')
    expect(missing.status).toBe(1); expect(missing.stderr).toMatch(/takes a stored item/)
    expect(cli(tmpdir(), 'run', shape, '--op', 'fit_to_shape', '--input', 'generator:box:10,10,10', '--payload', 'shape=drawing:square', '--payload', 'nope=drawing:square').status).toBe(1)   // a setting the operation does not have
    expect(cli(tmpdir(), 'run', shape, '--op', 'block_from_drawing', '--input', 'generator:box:10,10,10').status).toBe(1)   // a model where a drawing is needed
  })
  it('the plain Mirror keeps the colours of parts (body colour and segment colour, on the copy too)', async () => {
    const mod = (await import(pathToFileURL(path.join(plain, 'main.js')).href)).default as { run: (op: string, ctx: unknown) => Promise<{ mesh: { groups: Array<{ name: string; color?: string }>; segments: { table: Array<{ color?: string }> } } }> }
    const p = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]
    const mesh = { positions: Float64Array.from(p), indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]), groups: [{ start: 0, count: 4, role: 'solid', name: 'shell', color: '#e5484d' }], segments: { labels: new Uint16Array([1, 0, 0, 0]), table: [{ id: 0, name: 'body' }, { id: 1, name: 'lid', color: '#ffd400' }] } }
    const r = await mod.run('mirror', { mesh, params: { axis: 'x', mode: 'copy', gap: 1 }, signal: new AbortController().signal, progress: () => {} })
    expect(r.mesh.groups.map(g => [g.name, g.color])).toEqual([['shell', '#e5484d'], ['shell_mirror', '#e5484d']])
    expect(r.mesh.segments.table[1]!.color).toBe('#ffd400')
  })
  it.each([
    ['Math.random', (s: string) => s.replace('const nv =', 'const j = Math.random(); const nv ='), /\(random\)/],
    ['an import', (s: string) => `import x from 'y'\n${s}`, /\(imports\)/],
    ['fetch', (s: string) => s.replace('const nv =', 'fetch("x"); const nv ='), /\(network\)/],
    ['not cancelling with the right code', (s: string) => s.replace("throw problem('run.cancelled')", "throw new Error('stop')"), /run\.cancelled/],
  ])('check fails on %s', (_n, edit, pattern) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'am-dev-')); cpSync(plain, dir, { recursive: true })
    writeFileSync(path.join(dir, 'main.js'), edit(readFileSync(path.join(dir, 'main.js'), 'utf8')))
    const r = cli(tmpdir(), 'check', dir)
    expect(r.status).toBe(1); expect(r.stdout).toMatch(pattern)
  })
  it('check does not take a property called `importance` (a bundled manifest has them) for an import', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'am-dev-')); cpSync(plain, dir, { recursive: true })
    writeFileSync(path.join(dir, 'main.js'), `const manifest = {\n  importance: "low",\n  important: true,\n}\n${readFileSync(path.join(dir, 'main.js'), 'utf8')}`)
    const r = cli(tmpdir(), 'check', dir)
    expect(r.stdout).not.toMatch(/\(imports\)/)
  })
  it('check fails on a bad manifest and on a missing fixture result', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'am-dev-')); cpSync(plain, dir, { recursive: true })
    writeFileSync(path.join(dir, 'manifest.json'), readFileSync(path.join(dir, 'manifest.json'), 'utf8').replace('"manifest_version": 1', '"manifest_version": 7'))
    expect(cli(tmpdir(), 'check', dir).status).toBe(1)
    const d2 = mkdtempSync(path.join(tmpdir(), 'am-dev-')); cpSync(plain, d2, { recursive: true })
    writeFileSync(path.join(d2, 'fixtures.json'), JSON.stringify([{ name: 'wrong volume', operation: 'mirror', input: { generator: 'box' }, expect: { volume: { value: 5, tol: 0.1 } } }]))
    const r = cli(tmpdir(), 'check', d2)
    expect(r.status).toBe(1); expect(r.stdout).toMatch(/FAIL\s+fixture: wrong volume/)
  })
  it('run writes STL and 3MF, reads them back, and refuses bad input and settings', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'am-dev-'))
    let r = cli(dir, 'run', plain, '--input', 'generator:box:10,20,30', '--params', '{"mode":"copy","gap":2}', '--out', 'a.stl')
    expect(r.status).toBe(0); expect(r.stdout).toMatch(/triangles 24, size 22 x 20 x 30/); expect(r.stdout).toMatch(/closed solid: yes/)
    r = cli(dir, 'run', plain, '--input', 'a.stl', '--out', 'b.3mf'); expect(r.status).toBe(0); expect(existsSync(path.join(dir, 'b.3mf'))).toBe(true)
    r = cli(dir, 'run', plain, '--input', 'b.3mf'); expect(r.status).toBe(0)
    r = cli(dir, 'run', plain, '--input', 'generator:box', '--params', '{"gap":999,"mode":"copy"}'); expect(r.status).toBe(1); expect(r.stderr).toMatch(/param\.out_of_range/)
    r = cli(dir, 'run', plain, '--input', 'nothing.obj'); expect(r.status).not.toBe(0)
    r = cli(dir, 'run', plain, '--input', 'generator:box', '--params', 'nope'); expect(r.status).toBe(2)
  })
  it('the source rules ignore comments and name the line', () => {
    expect(scanSource('// no Math.random here\n/* fetch( */\nconst a = 1')).toEqual([])
    const f = scanSource('const a = 1\nconst b = Date.now()')
    expect(f).toHaveLength(1); expect(f[0]?.line).toBe(2); expect(f[0]?.code).toBe('clock')
  })
})
