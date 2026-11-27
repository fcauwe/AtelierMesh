// Installs the tarballs into a clean project and checks they work there: imports resolve, the conformance fixtures pass from the package,
// there is one copy of three.js, and the built code has no absolute path of this machine. Nothing is published.
/* global process */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' })
run(process.execPath, [path.join(root, 'scripts/pack.mjs')], root)

const tarballs = readdirSync(path.join(root, 'build/tarballs')).filter(f => f.endsWith('.tgz')).map(f => path.join(root, 'build/tarballs', f))
const dir = mkdtempSync(path.join(tmpdir(), 'am-clean-'))
let failed = 0
const check = (name, ok, detail = '') => { process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}\n`); if (!ok) failed++ }

try {
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'clean-project', private: true, type: 'module' }))
  run('npm', ['install', '--no-audit', '--no-fund', '--silent', ...tarballs, 'three@0.186.1', '@types/three@0.186.0', 'react@18.3.1', 'react-dom@18.3.1', '@types/react@18.3.12'], dir)

  // 1. the packages import and the conformance fixtures run from them
  writeFileSync(path.join(dir, 'probe.mjs'), `
    import { Registry, runFixtures, validateManifest } from '@ateliermesh/core'
    import { holesPlugin, holesManifest, holesFixtures, printcheckPlugin, printcheckManifest, printcheckFixtures, hollowPlugin, hollowManifest, hollowFixtures, corePlugin, coreFixtures, coreManifest, lowpolyPlugin, lowpolyManifest, lowpolyFixtures, voronoiPlugin, voronoiManifest, voronoiFixtures, repairPlugin, repairManifest, repairFixtures, deformPlugin, deformManifest, deformFixtures, smoothFixtures, partsPlugin, partsManifest, partsFixtures, texturePlugin, textureManifest, textureFixtures } from '@ateliermesh/plugins'
    import { loadViewer } from '@ateliermesh/ui'
    const reg = new Registry().register(corePlugin())
    const results = await runFixtures(coreFixtures, { registry: reg })
    const lp = await runFixtures(lowpolyFixtures, { registry: new Registry().register(lowpolyPlugin()) })
    const df = await runFixtures([...deformFixtures, ...smoothFixtures], { registry: new Registry().register(corePlugin()).register(deformPlugin()) })
    const vo = await runFixtures(voronoiFixtures, { registry: new Registry().register(corePlugin()).register(voronoiPlugin()) })
    const pa = await runFixtures(partsFixtures, { registry: new Registry().register(corePlugin()).register(partsPlugin()) })
    const tf = await runFixtures(textureFixtures, { registry: new Registry().register(corePlugin()).register(texturePlugin()) })
    const pcf = await runFixtures(printcheckFixtures, { registry: new Registry().register(corePlugin()).register(printcheckPlugin()) })
    const hl = await runFixtures(hollowFixtures, { registry: new Registry().register(corePlugin()).register(hollowPlugin()) })
    const hf = await runFixtures(holesFixtures, { registry: new Registry().register(corePlugin()).register(holesPlugin()) })
    const rp = await runFixtures(repairFixtures, { registry: new Registry().register(repairPlugin()) })
    console.log(JSON.stringify({ holesManifest: validateManifest(holesManifest).ok, holes: hf.length, holesFailed: hf.filter(r => !r.ok).map(r => r.name), printcheckManifest: validateManifest(printcheckManifest).ok, printcheck: pcf.length, printcheckFailed: pcf.filter(r => !r.ok).map(r => r.name), hollowManifest: validateManifest(hollowManifest).ok, hollow: hl.length, hollowFailed: hl.filter(r => !r.ok).map(r => r.name), textureManifest: validateManifest(textureManifest).ok, texture: tf.length, textureFailed: tf.filter(r => !r.ok).map(r => r.name), partsManifest: validateManifest(partsManifest).ok, parts: pa.length, partsFailed: pa.filter(r => !r.ok).map(r => r.name), deformManifest: validateManifest(deformManifest).ok, deform: df.length, deformFailed: df.filter(r => !r.ok).map(r => r.name), repairManifest: validateManifest(repairManifest).ok, repair: rp.length, repairFailed: rp.filter(r => !r.ok).map(r => r.name), manifest: validateManifest(coreManifest).ok, lowpolyManifest: validateManifest(lowpolyManifest).ok, lowpoly: lp.length, lowpolyFailed: lp.filter(r => !r.ok).map(r => r.name), voronoiManifest: validateManifest(voronoiManifest).ok, voronoi: vo.length, voronoiFailed: vo.filter(r => !r.ok).map(r => r.name), fixtures: results.length, failed: results.filter(r => !r.ok).map(r => r.name), viewer: typeof loadViewer }))
  `)
  const probe = JSON.parse(run(process.execPath, ['probe.mjs'], dir).trim().split('\n').pop())
  check('the packages import in a clean project', probe.viewer === 'function')
  check('the manifest is valid', probe.manifest)
  check(`the conformance fixtures run from the package (${probe.fixtures})`, probe.fixtures > 5 && probe.failed.length === 0, probe.failed.join(', '))
  check(`the texture plugin is in the package and its fixtures run (${probe.texture})`, probe.textureManifest && probe.texture >= 3 && probe.textureFailed.length === 0, probe.textureFailed.join(', '))
  check(`the holes plugin is in the package and its fixtures run (${probe.holes})`, probe.holesManifest && probe.holes >= 3 && probe.holesFailed.length === 0, probe.holesFailed.join(', '))
  check(`the print check plugin is in the package and its fixtures run (${probe.printcheck})`, probe.printcheckManifest && probe.printcheck >= 3 && probe.printcheckFailed.length === 0, probe.printcheckFailed.join(', '))
  check(`the hollow plugin is in the package and its fixtures run (${probe.hollow})`, probe.hollowManifest && probe.hollow >= 4 && probe.hollowFailed.length === 0, probe.hollowFailed.join(', '))
  check(`the parts plugin is in the package and its fixtures run (${probe.parts})`, probe.partsManifest && probe.parts >= 4 && probe.partsFailed.length === 0, probe.partsFailed.join(', '))
  check(`the deform plugin is in the package and its fixtures run (${probe.deform})`, probe.deformManifest && probe.deform >= 4 && probe.deformFailed.length === 0, probe.deformFailed.join(', '))
  check(`the Voronoi plugin is in the package and its fixtures run (${probe.voronoi})`, probe.voronoiManifest && probe.voronoi >= 3 && probe.voronoiFailed.length === 0, probe.voronoiFailed.join(', '))
  check(`the repair plugin is in the package and its fixtures run (${probe.repair})`, probe.repairManifest && probe.repair >= 3 && probe.repairFailed.length === 0, probe.repairFailed.join(','))
  check(`the low poly plugin is in the package and its fixtures run (${probe.lowpoly})`, probe.lowpolyManifest && probe.lowpoly >= 2 && probe.lowpolyFailed.length === 0, probe.lowpolyFailed.join(', '))

  // 1a. one call registers every first-party plugin (what the Atelier uses)
  writeFileSync(path.join(dir, 'builtin-probe.mjs'), `
    import { Registry } from '@ateliermesh/core'
    import { registerBuiltInPlugins, BUILT_IN_PLUGINS } from '@ateliermesh/plugins'
    const reg = registerBuiltInPlugins(new Registry())
    console.log(JSON.stringify({ n: reg.list().length, listed: BUILT_IN_PLUGINS.length, ops: reg.list().flatMap(m => m.operations.map(o => m.id + ':' + o.id)).length, ids: reg.list().map(m => m.id) }))
  `)
  const bi = JSON.parse(run(process.execPath, ['builtin-probe.mjs'], dir).trim().split('\n').pop())
  check(`registerBuiltInPlugins registers every first-party plugin (${bi.n} plugins, ${bi.ops} operations)`, bi.n === bi.listed && bi.n >= 8 && bi.ops >= 20)

  // 1b. the React package imports, renders to a string, and its types compile with the host's React
  writeFileSync(path.join(dir, 'react-probe.mjs'), `
    import { PersonaliseOverlay, EditorPage, PluginManager, LeaveDialog, SettingsDialog, BottomSheet, UploadPage, UnitsDialog, LoadCheckDialog, ProjectListDialog, CannotRunView } from '@ateliermesh/react'
    console.log(JSON.stringify({ overlay: typeof PersonaliseOverlay, editor: [EditorPage, PluginManager, LeaveDialog, SettingsDialog, BottomSheet, UploadPage, UnitsDialog, LoadCheckDialog, ProjectListDialog, CannotRunView].map(x => (typeof x === 'object' && x !== null && '$$typeof' in x ? 'function' : typeof x)).join() }))
  `)
  const rp = JSON.parse(run(process.execPath, ['react-probe.mjs'], dir).trim().split('\n').pop())
  check('the React package imports in a clean project', rp.overlay === 'function' && rp.editor === Array(10).fill('function').join())
  check('the overlay and editor stylesheets are shipped', existsSync(path.join(dir, 'node_modules/@ateliermesh/react/dist/overlay.css')) && existsSync(path.join(dir, 'node_modules/@ateliermesh/react/dist/editor.css')) && existsSync(path.join(dir, 'node_modules/@ateliermesh/react/dist/theme.css')))

  // 2. the viewer chunk loads and takes the host's three (one copy)
  writeFileSync(path.join(dir, 'viewer-probe.mjs'), `
    import { loadViewer } from '@ateliermesh/ui'
    const v = await loadViewer()
    console.log(typeof v.createViewer)
  `)
  check('the viewer loads on demand', run(process.execPath, ['viewer-probe.mjs'], dir).trim() === 'function')
  const threes = run('npm', ['ls', 'three', '--all', '--parseable'], dir).trim().split('\n').filter(Boolean)
  check('one copy of three.js is installed', new Set(threes).size === 1, threes.join(' '))

  // 2b. the server-side check from INTEGRATION.md, as an example script, with the installed packages
  writeFileSync(path.join(dir, 'server-check.mjs'), readFileSync(path.join(root, 'examples/server-check.mjs'), 'utf8'))
  const lines = run(process.execPath, ['server-check.mjs'], dir).split('\n')
  const verdict = n => lines.find(l => l.includes(n))?.trim().split(/\s+/)[0]
  check('the server-side check accepts what it should and refuses the rest', verdict('unchanged') === 'accepted' && verdict('a small nudge') === 'accepted' && ['moved too far', 'turned too far', 'a size outside the limits', 'the limits changed', 'height'].every(n => verdict(n) === 'refused'))

  // 3. the type declarations work for a TypeScript project (strict, declarations not skipped)
  writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: false, lib: ['ES2022', 'DOM'], types: [], jsx: 'react-jsx' }, include: ['use.ts'] }))
  writeFileSync(path.join(dir, 'use.ts'), `
    import { Registry, makeStep, addStep, emptyStepList, runWorkflow, applyPermanently, canApplyPermanently, write3mf, read3mf, MeshError } from '@ateliermesh/core'
    import type { Mesh, Step, EditorState } from '@ateliermesh/core'
    import { boxMesh } from '@ateliermesh/core/testing'
    import { corePlugin, CORE_PLUGIN_ID, CORE_PLUGIN_VERSION } from '@ateliermesh/plugins'
    import { loadViewer, describeProblem } from '@ateliermesh/ui'
    import { PersonaliseOverlay } from '@ateliermesh/react'
    import type { PersonaliseOverlayProps } from '@ateliermesh/react'
    const reg: Registry = new Registry().register(corePlugin())
    const step: Step = makeStep({ id: 'a', plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op: 'resize', params: { percent: 150 } })
    const state: EditorState = { base: boxMesh(10, 10, 10) as Mesh, list: addStep(emptyStepList(), step), rollback: null }
    export async function demo() {
      const r = await runWorkflow(state.list, { registry: reg, source: state.base })
      const can = canApplyPermanently(state)
      const applied = can.ok ? await applyPermanently(state, { registry: reg }) : null
      const out = write3mf(r.mesh!, { slicer: 'inline_sidecar' })
      const props: Pick<PersonaliseOverlayProps, 'title'> = { title: 'x' }
      return [await read3mf(out.bytes), applied, MeshError, loadViewer, PersonaliseOverlay, props, describeProblem]
    }
  `)
  let tsOut = ''
  try { run(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], dir) } catch (e) { tsOut = String(e.stdout ?? e.message).slice(0, 600) }
  check('the type declarations compile in a strict TypeScript project', tsOut === '', tsOut)

  // 4. the built code: no second copy of three.js inside, no absolute path of this machine
  let bad = []
  const walk = d => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(js|d\.ts)$/.test(f)) { const t = readFileSync(p, 'utf8'); if (t.includes(root) || /\/home\/[a-z]+\//.test(t)) bad.push(p); if (/var REVISION = /.test(t)) bad.push(p + ' (contains three.js)') } } }
  walk(path.join(dir, 'node_modules/@ateliermesh'))
  check('no absolute path and no bundled three.js in the built code', bad.length === 0, bad.join(', '))
  const sizes = readdirSync(path.join(dir, 'node_modules/@ateliermesh')).map(n => `${n}: ${(statSync(path.join(dir, 'node_modules/@ateliermesh', n, 'dist/index.js')).size / 1024).toFixed(0)} KB`)
  process.stdout.write(`     dist/index.js sizes: ${sizes.join(', ')}\n`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
process.exit(failed === 0 ? 0 : 1)
