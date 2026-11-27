// Builds every package (JavaScript with esbuild, type declarations with tsc), stages a publishable copy of each (exports point at dist,
// workspace versions become exact) and runs `npm pack` on it. Nothing is published. Output: build/tarballs/*.tgz
/* global process */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// ATELIERMESH_PACK_OUT: build somewhere else (the plugin kit does, so it does not wipe build/)
const out = process.env['ATELIERMESH_PACK_OUT'] ? path.resolve(process.env['ATELIERMESH_PACK_OUT']) : path.join(root, 'build')
rmSync(out, { recursive: true, force: true })
mkdirSync(path.join(out, 'tarballs'), { recursive: true })

const PACKAGES = [
  { dir: 'core', entries: { index: 'src/index.ts', testing: 'src/testing/index.ts' }, exports: { '.': 'index', './testing': 'testing' } },
  { dir: 'plugins', entries: { index: 'src/index.ts' }, exports: { '.': 'index' }, splitting: true },
  { dir: 'ui', entries: { index: 'src/index.ts' }, exports: { '.': 'index' } },
  { dir: 'react', entries: { index: 'src/index.ts' }, exports: { '.': 'index' }, jsx: true, files: { './overlay.css': 'src/overlay.css', './editor.css': 'src/editor.css', './theme.css': 'src/theme.css' } },
]
const versions = Object.fromEntries(PACKAGES.map(p => [JSON.parse(readFileSync(path.join(root, 'packages', p.dir, 'package.json'), 'utf8')).name, JSON.parse(readFileSync(path.join(root, 'packages', p.dir, 'package.json'), 'utf8')).version]))

for (const p of PACKAGES) {
  const src = path.join(root, 'packages', p.dir)
  const pkg = JSON.parse(readFileSync(path.join(src, 'package.json'), 'utf8'))
  const stage = path.join(out, 'stage', p.dir)
  mkdirSync(path.join(stage, 'dist'), { recursive: true })
  const external = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {}), 'three']
  await build({
    entryPoints: Object.fromEntries(Object.entries(p.entries).map(([k, v]) => [k, path.join(src, v)])),
    bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', outdir: path.join(stage, 'dist'), splitting: Boolean(p.splitting), chunkNames: 'chunk-[name]-[hash]', logLevel: 'warning',
    external, ...(p.jsx ? { jsx: 'automatic' } : {}), mainFields: ['module', 'main'], conditions: ['import'], sourcemap: false, legalComments: 'none',
  })
  execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(src, 'tsconfig.build.json'), '--outDir', path.join(stage, 'dist')], { stdio: 'inherit' })
  // tsc keeps the folder of a source file: src/testing/index.ts becomes dist/testing/index.d.ts
  const typesOf = v => (p.entries[v].includes('/index.ts') && p.entries[v] !== 'src/index.ts' ? `./dist/${path.dirname(p.entries[v]).replace(/^src\//, '')}/index.d.ts` : `./dist/${v}.d.ts`)
  const exp = Object.fromEntries(Object.entries(p.exports).map(([k, v]) => [k, { types: typesOf(v), import: `./dist/${v}.js` }]))
  for (const [k, f] of Object.entries(p.files ?? {})) { cpSync(path.join(src, f), path.join(stage, 'dist', path.basename(f))); exp[k] = `./dist/${path.basename(f)}` }
  const staged = {
    name: pkg.name, version: pkg.version, description: pkg.description, type: 'module', license: 'AGPL-3.0-or-later', sideEffects: ['**/*.css'],
    exports: exp, types: './dist/index.d.ts', files: ['dist', 'README.md', 'LICENSE', 'LICENSING.md'],
    dependencies: Object.fromEntries(Object.entries(pkg.dependencies ?? {}).map(([k, v]) => [k, versions[k] ?? v])),
    ...(pkg.peerDependencies ? { peerDependencies: pkg.peerDependencies } : {}),
  }
  writeFileSync(path.join(stage, 'package.json'), JSON.stringify(staged, null, 2) + '\n')
  writeFileSync(path.join(stage, 'README.md'), `# ${pkg.name}\n\n${pkg.description}\n\nSee INTEGRATION.md in the repository for how to use it. Not published to npm.\n`)
  // the licence travels with every package: AGPL-3.0-or-later (with the plugin permission in LICENSING.md)
  for (const f of ['LICENSE', 'LICENSING.md']) cpSync(path.join(root, f), path.join(stage, f))
  execFileSync('npm', ['pack', '--pack-destination', path.join(out, 'tarballs'), '--silent'], { cwd: stage, stdio: ['ignore', 'ignore', 'inherit'] })
}
process.stdout.write(`tarballs in ${path.join(out, 'tarballs')}\n`)
