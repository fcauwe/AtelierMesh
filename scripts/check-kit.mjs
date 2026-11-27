// Proves the plugin developer kit works for someone OUTSIDE the repository: it builds the kit zip (or takes one), unpacks ONLY that zip into a scratch folder
// outside the repository, and from there installs the packed packages, runs the Mirror example's type check and tests, packs and inspects it, signs and verifies,
// packs a plain-JavaScript plugin with no esbuild around, checks that a TypeScript plugin without esbuild gets a clear message, checks that every link in the kit's
// documents resolves inside the kit, and finally loads the packed plugin into the built standalone app (headless Chromium) and runs it on a sample.
// Needs the network once (npm install of TypeScript, vitest and esbuild). Usage: node scripts/check-kit.mjs [--zip file.zip] [--tarballs folder] [--no-app] [--keep]
/* global process, console, window, document */
import { execFileSync, spawnSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, cpSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, def = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def }
let failed = 0
const ok = (msg) => console.log(`ok   ${msg}`)
const bad = (msg, extra = '') => { failed++; console.log(`FAIL ${msg}${extra ? `\n${String(extra).split('\n').slice(0, 12).join('\n')}` : ''}`) }
const check = (cond, msg, extra) => (cond ? ok(msg) : bad(msg, extra))

// 1. the kit
let zip = arg('zip') ? path.resolve(arg('zip')) : ''
if (!zip) {
  const out = path.join(os.tmpdir(), `ateliermesh-kit-check-${process.pid}.zip`)
  const args = ['scripts/make-plugin-kit.mjs', '--out', out, ...(arg('tarballs') ? ['--tarballs', arg('tarballs')] : [])]
  execFileSync(process.execPath, args, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] })
  zip = out
}
const work = mkdtempSync(path.join(os.tmpdir(), 'ateliermesh-kit-test-'))   // outside the repository, on purpose
execFileSync('unzip', ['-q', zip, '-d', work])
const kit = path.join(work, readdirSync(work).find(f => f.startsWith('ateliermesh-plugin-kit-')))
const sh = (cmd, args, cwd, env = {}) => spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
const npm = (args, cwd) => sh('npm', args, cwd)
console.log(`kit: ${path.relative(os.tmpdir(), kit)} (from ${path.basename(zip)}, ${(statSync(zip).size / 1024).toFixed(0)} KB)`)

// 2. what must be in it
for (const f of ['README-START-HERE.md', 'VERSION.json', 'tools/amplugin.mjs', 'tools/amplugin_pack.py', 'tools/amplugin_check.py', 'docs/NO-NPM.md', 'docs/CONTRACT-CHEATSHEET.md', 'examples/plugins/mirror-plain/main.js', 'examples/plugins/mirror-plain/manifest.json', 'examples/plugins/mirror-plain/fixtures.json', 'examples/plugins/shape-fit-plain/main.js', 'examples/plugins/shape-fit-plain/manifest.json', 'examples/plugins/shape-fit-plain/fixtures.json', 'docs/plugin-guide.md', 'docs/prompt-make-a-plugin.md', 'docs/plugin-authoring.md', 'docs/external-plugins.md', 'spec/SPEC-plugins.md',
  'examples/plugins/mirror-full/main.ts', 'examples/plugins/mirror-full/src/mirror.ts', 'examples/plugins/mirror-full/package.json', 'examples/plugins/mirror-full/tsconfig.json', 'examples/plugins/mirror-full/test/mirror.test.ts',
  'examples/plugins/mirror-full/locales/en.json', 'examples/plugins/mirror-full/locales/nl.json', 'examples/plugins/mirror-full/locales/fr.json', 'types/core/index.d.ts', 'types/plugins/index.d.ts']) check(existsSync(path.join(kit, f)), `the kit has ${f}`)
check(readdirSync(path.join(kit, 'packages')).some(f => /^ateliermesh-core-.*\.tgz$/.test(f)), 'the kit has the packed core package')
check(/NOT ours/.test(readFileSync(path.join(kit, 'README-START-HERE.md'), 'utf8')), 'the start page says the npm package "amplugin" is not ours')

// 3. every markdown link in the kit resolves inside the kit
{
  const missing = []
  const walk = d => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) { if (f !== 'node_modules' && f !== 'types' && f !== 'packages') walk(p) } else if (f.endsWith('.md')) { checkFile(p) } } }
  const checkFile = p => {
    const text = readFileSync(p, 'utf8').replace(/```[\s\S]*?```/g, '')
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const t = m[1]
      if (/^(https?:|mailto:|#)/.test(t)) continue
      const target = path.resolve(path.dirname(p), t.split('#')[0])
      if (!existsSync(target)) missing.push(`${path.relative(kit, p)} -> ${t}`)
    }
  }
  walk(kit)
  check(missing.length === 0, 'every link in the kit documents points to a file inside the kit', missing.join('\n'))
}


// 3b. NO NPM: tier A with only node on the PATH (no npm, no npx, no esbuild, no node_modules), tier B with python3, tier C by hand
const lean = path.join(work, 'lean-bin'); mkdirSync(lean)
symlinkSync(process.execPath, path.join(lean, 'node'))
const noNpm = (args, cwd, input) => spawnSync(path.join(lean, 'node'), args, { cwd, encoding: 'utf8', env: { PATH: lean, HOME: work }, ...(input ? { input } : {}) })
const toolJs = path.join(kit, 'tools/amplugin.mjs')
const nn = path.join(work, 'no-npm'); mkdirSync(nn)
check(spawnSync('npm', ['--version'], { env: { PATH: lean }, encoding: 'utf8' }).error !== undefined, 'tier A setup: npm and npx are not on the PATH (only node)')
let r = noNpm([toolJs, 'new', 'my-shift'], nn); check(r.status === 0 && existsSync(path.join(nn, 'my-shift/main.js')), 'tier A: amplugin new writes a plain JavaScript plugin', r.stdout + r.stderr)
r = noNpm([toolJs, 'check', 'my-shift'], nn); check(r.status === 0 && /0 failed/.test(r.stdout), 'tier A: amplugin check passes on the new plugin', r.stdout + r.stderr)
const mp = path.join(kit, 'examples/plugins/mirror-plain')
r = noNpm([toolJs, 'check', mp], nn); check(r.status === 0 && /0 failed/.test(r.stdout) && /fixture: a copy beside it/.test(r.stdout), 'tier A: amplugin check passes on examples/plugins/mirror-plain, fixtures included', r.stdout + r.stderr)
r = noNpm([toolJs, 'run', mp, '--input', 'generator:box:10,20,30', '--params', '{"axis":"x","mode":"copy","gap":2}', '--out', path.join(nn, 'result.stl')], nn)
check(r.status === 0 && /triangles 24, size 22 x 20 x 30/.test(r.stdout) && existsSync(path.join(nn, 'result.stl')), 'tier A: amplugin run mirrors a generated box and writes an STL', r.stdout + r.stderr)
r = noNpm([toolJs, 'run', mp, '--input', path.join(nn, 'result.stl'), '--out', path.join(nn, 'again.3mf')], nn); check(r.status === 0 && existsSync(path.join(nn, 'again.3mf')), 'tier A: amplugin run reads an STL and writes a 3MF', r.stdout + r.stderr)
r = noNpm([toolJs, 'pack', mp, '--out', path.join(nn, 'plain.amplugin')], nn); check(r.status === 0 && existsSync(path.join(nn, 'plain.amplugin')), 'tier A: amplugin pack packs mirror-plain', r.stdout + r.stderr)
r = noNpm([toolJs, 'inspect', path.join(nn, 'plain.amplugin')], nn); check(r.status === 0 && /com\.example\.mirror_plain/.test(r.stdout), 'tier A: amplugin inspect accepts the package', r.stdout + r.stderr)
// drawings and stored items: the example that uses them, checked, run with a drawing in and with a stored drawing, and packed
const sp = path.join(kit, 'examples/plugins/shape-fit-plain')
r = noNpm([toolJs, 'check', sp], nn); check(r.status === 0 && /0 failed/.test(r.stdout) && /fixture: a 10 mm cube fitted to a stored 40 x 20 drawing/.test(r.stdout), 'tier A: amplugin check passes on examples/plugins/shape-fit-plain (a drawing in, a stored drawing as a setting)', r.stdout + r.stderr)
r = noNpm([toolJs, 'run', sp, '--op', 'block_from_drawing', '--input', 'drawing:square:40,20', '--params', '{"height":4}', '--out', path.join(nn, 'block.stl')], nn)
check(r.status === 0 && /size 40 x 20 x 4 mm/.test(r.stdout) && existsSync(path.join(nn, 'block.stl')), 'tier A: amplugin run takes a drawing as input (drawing:square) and writes an STL', r.stdout + r.stderr)
r = noNpm([toolJs, 'run', sp, '--op', 'fit_to_shape', '--input', 'generator:box:10,10,10', '--payload', 'shape=drawing:square:40,20'], nn)
check(r.status === 0 && /volume 8000 mm3/.test(r.stdout), 'tier A: amplugin run fills a stored-item setting with --payload', r.stdout + r.stderr)
r = noNpm([toolJs, 'run', sp, '--op', 'fit_to_shape', '--input', 'generator:box:10,10,10'], nn)
check(r.status === 1 && /takes a stored item/.test(r.stderr), 'tier A: amplugin run says what is missing when a stored-item setting has no --payload', r.stdout + r.stderr)
r = noNpm([toolJs, 'pack', sp, '--out', path.join(nn, 'shape-fit.amplugin')], nn); check(r.status === 0 && existsSync(path.join(nn, 'shape-fit.amplugin')), 'tier A: amplugin pack packs shape-fit-plain', r.stdout + r.stderr)
// the failing cases: check must say FAIL and exit 1
const broken = (name, edit) => {
  const d = path.join(nn, name); cpSync(mp, d, { recursive: true }); edit(d); return noNpm([toolJs, 'check', d], nn)
}
const patch = (d, f, from, to) => writeFileSync(path.join(d, f), readFileSync(path.join(d, f), 'utf8').replace(from, to))
r = broken('bad-random', d => patch(d, 'main.js', 'const nv =', 'const jitter = Math.random(); const nv ='))
check(r.status === 1 && /FAIL.*\(random\)/.test(r.stdout), 'tier A: check fails on Math.random and names the line', r.stdout)
r = broken('bad-manifest', d => patch(d, 'manifest.json', '"manifest_version": 1', '"manifest_version": 2'))
check(r.status === 1 && /FAIL\s+manifest/.test(r.stdout), 'tier A: check fails on a wrong manifest with a readable error', r.stdout)
r = broken('no-license', d => patch(d, 'manifest.json', '"license": "MIT",', ''))
check(r.status === 1 && /FAIL\s+manifest: manifest\.json has no "license"\. Add one, for example "license": "MIT"/.test(r.stdout), 'tier A: check fails on a manifest without a licence, with a readable message', r.stdout)
r = broken('no-description', d => patch(d, 'manifest.json', /"description": "[^"]*",/, ''))
check(r.status === 1 && /has no "description"/.test(r.stdout), 'tier A: check fails on a manifest without a description, with a readable message', r.stdout)
r = broken('bad-package-url', d => patch(d, 'manifest.json', '"license": "MIT",', '"license": "MIT", "package_url": "http://example.org/p.amplugin",'))
check(r.status === 1 && /"package_url" is not usable/.test(r.stdout), 'tier A: check fails on a package_url that is not https', r.stdout)
r = noNpm([toolJs, 'pack', path.join(nn, 'no-license'), '--out', path.join(nn, 'nolic.amplugin')], nn)
check(r.status === 1 && !existsSync(path.join(nn, 'nolic.amplugin')) && /no "license"/.test(r.stderr), 'tier A: pack refuses a manifest without a licence', r.stdout + r.stderr)
// the example picture: a usable one is packed and accepted; a missing, wrong-type or oversized one is refused
const pngHeader = (w, h, extra = 0) => { const b = Buffer.alloc(33 + extra); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b }
const withImage = (name, bytes) => broken(name, d => { patch(d, 'manifest.json', '"license": "MIT",', '"license": "MIT", "image": { "file": "assets/example.png", "alt": "A box with a copy beside it" },'); if (bytes) { mkdirSync(path.join(d, 'assets'), { recursive: true }); writeFileSync(path.join(d, 'assets/example.png'), bytes) } })
r = withImage('img-ok', pngHeader(640, 420)); check(r.status === 0 && /example picture assets\/example\.png is a usable/.test(r.stdout), 'tier A: check accepts a usable example picture', r.stdout)
r = withImage('img-missing', null); check(r.status === 1 && /example picture assets\/example\.png exists/.test(r.stdout), 'tier A: check fails on an example picture that is not in the folder', r.stdout)
r = withImage('img-svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')); check(r.status === 1 && /must be a PNG, JPEG or WebP/.test(r.stdout), 'tier A: check fails on an example picture that is not PNG, JPEG or WebP', r.stdout)
r = withImage('img-big', pngHeader(640, 420, 310 * 1024)); check(r.status === 1 && /the most allowed is 307200/.test(r.stdout), 'tier A: check fails on an example picture over 300 KB', r.stdout)
r = noNpm([toolJs, 'pack', path.join(nn, 'img-ok'), '--out', path.join(nn, 'img-ok.amplugin')], nn); check(r.status === 0, 'tier A: pack packs a plugin with an example picture', r.stdout + r.stderr)
r = noNpm([toolJs, 'pack', path.join(nn, 'img-svg'), '--out', path.join(nn, 'img-svg.amplugin')], nn); check(r.status === 1 && !existsSync(path.join(nn, 'img-svg.amplugin')) && /PNG, JPEG or WebP/.test(r.stderr), 'tier A: pack refuses an example picture that is not a picture', r.stdout + r.stderr)
r = broken('bad-clock', d => patch(d, 'main.js', "ctx.progress('mirror', 1)", "ctx.progress('mirror', 1); out.positions[0] += (globalThis.__n = (globalThis.__n ?? 0) + 1) * 1e-6"))
check(r.status === 1 && /FAIL.*same input gives the same result/.test(r.stdout), 'tier A: check fails on a non-deterministic plugin', r.stdout)
r = broken('bad-open', d => patch(d, 'main.js', 'indices[io + 3 * t + 2] = mesh.indices[3 * t + 1] + base * nv', 'indices[io + 3 * t + 2] = mesh.indices[3 * t + 1] + base * nv; if (t === 0) indices[io] = indices[io + 1]'))
check(r.status === 1 && /FAIL/.test(r.stdout), 'tier A: check fails when a closed solid comes out open (or invalid)', r.stdout)
r = broken('bad-throw', d => patch(d, 'main.js', "throw problem('mirror.empty')", "throw new Error('empty')"))
check(r.status === 0 || r.status === 1, 'tier A: check runs on a plugin that throws an Error (no crash of the tool)', r.stdout + r.stderr)
// the new package loads in the standalone harness below
const plainPacked = path.join(nn, 'plain.amplugin')
// tier B
const py = spawnSync('python3', ['--version'], { encoding: 'utf8' })
if (py.status === 0) {
  const pyPack = path.join(kit, 'tools/amplugin_pack.py'), pyCheck = path.join(kit, 'tools/amplugin_check.py')
  r = sh('python3', ['-I', pyCheck, sp], nn); check(r.status === 0 && /0 failed/.test(r.stdout), 'tier B: amplugin_check.py accepts a manifest with a payload setting and a drawing operation', r.stdout + r.stderr)
  r = sh('python3', ['-I', pyCheck, mp], nn); check(r.status === 0 && /0 failed/.test(r.stdout) && /does not run the plugin/.test(r.stdout), 'tier B: amplugin_check.py passes on mirror-plain and says it cannot run it', r.stdout + r.stderr)
  r = sh('python3', ['-I', pyPack, mp, '--out', path.join(nn, 'py.amplugin')], nn); check(r.status === 0 && /unsigned/.test(r.stdout), 'tier B: amplugin_pack.py packs mirror-plain (and says it is unsigned)', r.stdout + r.stderr)
  const entries = f => { const l = spawnSync('unzip', ['-Z1', f], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort(); return l }
  const content = (f, n) => spawnSync('unzip', ['-p', f, n], { encoding: 'buffer' }).stdout
  const same = entries(plainPacked).join() === entries(path.join(nn, 'py.amplugin')).join() && ['manifest.json', 'main.js', 'manifest.sha256'].every(n => content(plainPacked, n).equals(content(path.join(nn, 'py.amplugin'), n)))
  check(same, 'tier B: the Python package has the same entries, manifest.json, main.js and manifest.sha256 as the Node package')
  r = noNpm([toolJs, 'inspect', path.join(nn, 'py.amplugin')], nn); check(r.status === 0 && /com\.example\.mirror_plain/.test(r.stdout), 'tier B: the Node tool inspects (accepts) the Python package', r.stdout + r.stderr)
  r = sh('python3', ['-I', pyCheck, path.join(nn, 'py.amplugin')], nn); check(r.status === 0 && /manifest\.sha256 lists every file/.test(r.stdout), 'tier B: amplugin_check.py verifies the package listing', r.stdout + r.stderr)
  const pb = path.join(nn, 'py-bad'); cpSync(mp, pb, { recursive: true }); patch(pb, 'main.js', 'const nv =', 'const j = Math.random(); const nv =')
  r = sh('python3', ['-I', pyPack, pb, '--out', path.join(nn, 'pybad.amplugin')], nn); check(r.status !== 0 && !existsSync(path.join(nn, 'pybad.amplugin')), 'tier B: amplugin_pack.py refuses a plugin that uses Math.random', r.stdout + r.stderr)
  r = sh('python3', ['-I', pyCheck, path.join(nn, 'no-license')], nn); check(r.status === 1 && /has no "license"/.test(r.stdout), 'tier B: amplugin_check.py fails on a manifest without a licence, with a readable message', r.stdout + r.stderr)
  r = sh('python3', ['-I', pyPack, path.join(nn, 'no-license'), '--out', path.join(nn, 'pynolic.amplugin')], nn); check(r.status !== 0 && !existsSync(path.join(nn, 'pynolic.amplugin')), 'tier B: amplugin_pack.py refuses a manifest without a licence', r.stdout + r.stderr)
  r = sh('python3', ['-I', pyCheck, path.join(nn, 'img-ok')], nn); check(r.status === 0 && /example picture is a usable/.test(r.stdout), 'tier B: amplugin_check.py accepts a usable example picture', r.stdout)
  r = sh('python3', ['-I', pyCheck, path.join(nn, 'img-big')], nn); check(r.status === 1 && /is 31\d{4} bytes|the most allowed/.test(r.stdout), 'tier B: amplugin_check.py fails on an example picture over 300 KB', r.stdout)
  r = sh('python3', ['-I', pyPack, path.join(nn, 'img-svg'), '--out', path.join(nn, 'pyimg.amplugin')], nn); check(r.status !== 0 && !existsSync(path.join(nn, 'pyimg.amplugin')), 'tier B: amplugin_pack.py refuses an example picture that is not a picture', r.stdout + r.stderr)
  r = sh('python3', ['-I', pyPack, path.join(nn, 'img-ok'), '--out', path.join(nn, 'pyimg-ok.amplugin')], nn); check(r.status === 0, 'tier B: amplugin_pack.py packs a plugin with an example picture', r.stdout + r.stderr)
  r = sh('python3', ['-I', pyCheck, path.join(nn, 'pyimg-ok.amplugin')], nn); check(r.status === 0 && /example picture is a usable/.test(r.stdout), 'tier B: amplugin_check.py verifies the picture inside the package', r.stdout)
} else console.log('skip tier B: python3 is not installed here (the Python tools were not run)')
// tier C: the manual recipe from docs/NO-NPM.md, with sha256sum and zip
if (spawnSync('sh', ['-c', 'command -v sha256sum && command -v zip'], { encoding: 'utf8' }).status === 0) {
  const man = path.join(nn, 'manual'); cpSync(mp, man, { recursive: true })
  r = sh('sh', ['-c', 'sha256sum manifest.json main.js $(find assets -type f 2>/dev/null) | LC_ALL=C sort -k2 > manifest.sha256 && zip -q -X -D ../manual.amplugin manifest.json main.js manifest.sha256 $(find assets -type f 2>/dev/null)'], man)
  check(r.status === 0 && existsSync(path.join(nn, 'manual.amplugin')), 'tier C: the sha256sum + zip recipe makes a package', r.stdout + r.stderr)
  r = noNpm([toolJs, 'inspect', path.join(nn, 'manual.amplugin')], nn); check(r.status === 0 && /com\.example\.mirror_plain/.test(r.stdout), 'tier C: the Node tool accepts the hand-made package', r.stdout + r.stderr)
} else console.log('skip tier C: sha256sum or zip is missing')
const docNoNpm = readFileSync(path.join(kit, 'docs/NO-NPM.md'), 'utf8')
check(/sha256sum/.test(docNoNpm) && /Tier A/.test(docNoNpm) && /Tier B/.test(docNoNpm) && /Tier C/.test(docNoNpm), 'docs/NO-NPM.md describes the three tiers')
check(!/customer/i.test(readFileSync(path.join(kit, 'docs/prompt-make-a-plugin.md'), 'utf8').split('The full prompt without npm')[1] ?? 'customer'), 'the no-npm prompts have no customer-settings questions')

// 4. the example, from the zip only
const ex = path.join(kit, 'examples/plugins/mirror-full')
r = npm(['install', '--no-audit', '--no-fund', '--loglevel=error'], ex)
check(r.status === 0, 'npm install in examples/plugins/mirror-full (packed core package, TypeScript, vitest, esbuild)', r.stderr)
if (r.status === 0) {
  r = npm(['run', 'typecheck', '--silent'], ex); check(r.status === 0, 'npm run typecheck', r.stdout + r.stderr)
  r = npm(['test', '--silent'], ex); check(r.status === 0 && /passed/.test(r.stdout + r.stderr), 'npm test (the plugin runs in the real engine, with fixtures)', r.stdout + r.stderr)
  r = npm(['run', 'pack', '--silent'], ex)
  const packed = path.join(ex, 'dist/com.example.mirror-1.0.0.amplugin')
  check(r.status === 0 && existsSync(packed), 'npm run pack makes dist/com.example.mirror-1.0.0.amplugin', r.stdout + r.stderr)
  r = npm(['run', 'inspect', '--silent'], ex)
  check(r.status === 0 && /"id": "com.example.mirror"/.test(r.stdout), 'npm run inspect names the plugin', r.stdout + r.stderr)

  // signing and verifying
  const tool = path.join(kit, 'tools/amplugin.mjs')
  const keys = path.join(work, 'keys'); mkdirSync(keys)
  r = sh(process.execPath, [tool, 'keygen', path.join(keys, 'me')], ex); check(r.status === 0 && existsSync(path.join(keys, 'me.key')), 'amplugin keygen', r.stderr)
  r = sh(process.execPath, [tool, 'sign', '.', '--key', path.join(keys, 'me.key'), '--out', path.join(work, 'signed.amplugin')], ex); check(r.status === 0, 'amplugin sign', r.stderr)
  r = sh(process.execPath, [tool, 'verify', path.join(work, 'signed.amplugin'), '--trust', path.join(keys, 'me.pub')], ex); check(r.status === 0 && /"signed": true/.test(r.stdout), 'amplugin verify with the right key', r.stdout + r.stderr)
  r = sh(process.execPath, [tool, 'verify', packed, '--trust', path.join(keys, 'me.pub')], ex); check(r.status !== 0, 'amplugin verify fails for an unsigned package')

  // plain JavaScript packs with no esbuild anywhere (the scratch folder and the kit have no node_modules at their root)
  const js = path.join(work, 'js-plugin'); mkdirSync(js)
  const unz = path.join(work, 'unz'); mkdirSync(unz)
  execFileSync('unzip', ['-q', packed, '-d', unz])
  cpSync(path.join(unz, 'manifest.json'), path.join(js, 'manifest.json')); cpSync(path.join(unz, 'main.js'), path.join(js, 'main.js'))
  r = sh(process.execPath, [tool, 'pack', js, '--out', path.join(work, 'js.amplugin')], work)
  check(r.status === 0 && existsSync(path.join(work, 'js.amplugin')), 'a plugin written in plain JavaScript packs with nothing installed', r.stdout + r.stderr)
  // TypeScript without esbuild: a clear message
  const ts = path.join(work, 'ts-plugin'); mkdirSync(ts)
  cpSync(path.join(kit, 'examples/plugins/mirror/main.ts'), path.join(ts, 'main.ts')); cpSync(path.join(kit, 'examples/plugins/mirror/manifest.json'), path.join(ts, 'manifest.json'))
  r = sh(process.execPath, [tool, 'pack', ts, '--out', path.join(work, 'ts.amplugin')], work)
  check(r.status !== 0 && /esbuild/.test(r.stderr), 'a TypeScript plugin without esbuild is told to npm install -D esbuild', r.stdout + r.stderr)

  // 5. into the app
  if (!process.argv.includes('--no-app') && packed) {
    const dist = path.join(root, 'apps/standalone/dist')
    if (!existsSync(path.join(dist, 'index.html'))) execFileSync('npm', ['run', 'build:standalone', '--silent'], { cwd: root, stdio: 'ignore' })
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.zip': 'application/zip' }
    const server = createServer((req, res) => {
      let p = path.join(dist, decodeURIComponent((req.url ?? '/').split('?')[0]))
      if (statSync(dist) && (p.endsWith('/') || (existsSync(p) && statSync(p).isDirectory()))) p = path.join(p, 'index.html')
      if (!p.startsWith(dist) || !existsSync(p)) { res.statusCode = 404; res.end('no'); return }
      res.setHeader('content-type', types[path.extname(p)] ?? 'application/octet-stream'); createReadStream(p).pipe(res)
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}/`
    const { chromium } = await import('playwright-core')
    let browser
    try {
      browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
      const errors = []
      page.on('pageerror', e => errors.push(String(e)))
      page.on('dialog', d => { void d.accept() })
      await page.goto(`${base}?intro=0&welcome=0`)
      await page.getByRole('button', { name: /^Plate 60/ }).click()
      await page.waitForFunction(() => document.body.textContent.includes('Closed solid'), null, { timeout: 90000 })
      await page.getByRole('button', { name: 'Add a step' }).click()
      await page.getByRole('menuitem', { name: 'Plugins…' }).click()
      const dlg = page.getByRole('dialog')
      await dlg.getByRole('button', { name: 'Add plugin' }).click()   // the file field is on the add screen
      await dlg.locator('.am-filebtn input[type=file]').setInputFiles(packed)
      await page.getByRole('button', { name: 'Add', exact: true }).click()
      await dlg.getByRole('button', { name: 'Back to the plugins' }).click()
      await dlg.getByText(/Mirror/).first().waitFor({ timeout: 30000 })
      ok('the packed example loads into the standalone app from a file and appears in the plugin manager')
      await page.getByRole('button', { name: 'Close' }).click()
      await page.getByRole('button', { name: 'Add a step' }).click()
      await page.getByRole('menuitem', { name: /^Mirror/ }).click()
      await page.waitForFunction(() => { const r = window.__am?.result; return !!r && r.ok === true }, null, { timeout: 30000 })
      const res = await page.evaluate(() => window.__am.result)
      check(res.ok && res.triangles > 0, 'the Mirror step is in the Add a step menu and runs on a model', JSON.stringify(res))
      // the plain JavaScript package (made by the Node tool with no npm) loads and runs too
      await page.getByRole('button', { name: 'Add a step' }).click()
      await page.getByRole('menuitem', { name: 'Plugins…' }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Add plugin' }).click()
      await page.getByRole('dialog').locator('.am-filebtn input[type=file]').setInputFiles(plainPacked)
      await page.getByRole('button', { name: 'Add', exact: true }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Back to the plugins' }).click()
      await page.getByRole('dialog').getByText(/plain JavaScript/).first().waitFor({ timeout: 30000 })
      ok('the plain JavaScript package loads into the standalone app')
      await page.getByRole('button', { name: 'Close' }).click()
      await page.getByRole('button', { name: 'Add a step' }).click()
      await page.getByRole('menuitem', { name: /^Mirror\b/ }).last().click()   // two Mirror plugins are loaded now (the packed example and the plain one): the plain one was loaded last
      await page.waitForFunction(() => { const r = window.__am?.result; return !!r && r.ok === true }, null, { timeout: 30000 })
      ok('the plain JavaScript Mirror step runs on a model in the app')
      check(errors.length === 0, 'no page errors while loading and running it', errors.join('\n'))
    } catch (e) { bad('loading the packed plugin into the standalone app', e instanceof Error ? e.message : String(e)) }
    finally { await browser?.close(); server.close() }
  }
}

if (!process.argv.includes('--keep')) { rmSync(work, { recursive: true, force: true }); if (!arg('zip')) rmSync(zip, { force: true }) } else console.log(`kept: ${work}`)
console.log(failed === 0 ? '\nthe plugin kit works from the zip alone' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
