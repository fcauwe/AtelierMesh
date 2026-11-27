// The `ateliermesh` command: apply a recipe (.amrecipe, saved from the app) to a model without a browser.
//   ateliermesh recipe.amrecipe model.stl result.3mf
// Node only. Built into build/cli/ateliermesh.mjs by scripts/build-cli-ateliermesh.mjs.
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  Registry, applyRecipe, emptyStepList, measureMesh, parseRecipe, parseStl, read3mf, recipeProblems, runWorkflow, write3mfCompressed, writeStlBinary,
} from '@ateliermesh/core'
import type { Mesh, StructuredError } from '@ateliermesh/core'
import { createFontService, registerBuiltInPlugins } from '@ateliermesh/plugins'
import robotoUrl from '../../standalone/public/fonts/roboto-regular.woff2'

const USAGE = `ateliermesh <recipe.amrecipe> <model.stl|model.3mf> <result.stl|result.3mf> [options]
  Applies the steps of a recipe to a model and writes the result. The built-in plugins are included.

  --fonts <folder>       a folder with fonts for text steps: a fonts.json (as in the app's fonts folder) or font files named like the font
  --font <id>=<file>     one font file for the asset id a step uses (for example "font:Quicksand=Quicksand-Bold.ttf"); can be repeated
  --quality <q>          preview | export (default export: full detail)
  --json                 print the summary as JSON on the last line of the output
  --quiet                print nothing but problems
  -h, --help             this text
Exit code: 0 done, 1 a step failed or the files are not usable, 2 wrong command line.`

const fail = (code: number, msg: string): never => { process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n'); process.exit(code) }
const describe = (e: StructuredError): string => `${e.code}${e.params && Object.keys(e.params).length ? ' ' + JSON.stringify(e.params) : ''}`

interface Opts { recipe: string; input: string; output: string; fonts?: string; font: Map<string, string>; quality: 'preview' | 'export'; json: boolean; quiet: boolean }
function parseArgs(argv: string[]): Opts {
  const pos: string[] = []; const o: Opts = { recipe: '', input: '', output: '', font: new Map(), quality: 'export', json: false, quiet: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    const val = (): string => { const v = argv[++i]; if (v === undefined) fail(2, `${a} needs a value\n\n${USAGE}`); return v as string }
    if (a === '-h' || a === '--help') { process.stdout.write(USAGE + '\n'); process.exit(0) }
    else if (a === '--fonts') o.fonts = val()
    else if (a === '--font') { const v = val(); const k = v.indexOf('='); if (k < 1) fail(2, `--font wants <id>=<file>, got ${v}`); o.font.set(v.slice(0, k), v.slice(k + 1)) }
    else if (a === '--quality') { const v = val(); if (v !== 'preview' && v !== 'export') fail(2, '--quality is preview or export'); o.quality = v as Opts['quality'] }
    else if (a === '--json') o.json = true
    else if (a === '--quiet') o.quiet = true
    else if (a.startsWith('--')) fail(2, `unknown option ${a}\n\n${USAGE}`)
    else pos.push(a)
  }
  if (pos.length !== 3) fail(2, USAGE)
  ;[o.recipe, o.input, o.output] = pos as [string, string, string]
  return o
}

async function readModel(file: string): Promise<Mesh> {
  const bytes = new Uint8Array(fs.readFileSync(file))
  if (/\.stl$/i.test(file)) return parseStl(bytes).mesh
  if (/\.3mf$/i.test(file)) return (await read3mf(bytes)).mesh
  return fail(2, `the model is a .stl or .3mf file: ${file}`)
}

/** Fonts and pictures a step refers to: the recipe's own pictures, --font files, a --fonts folder, and Roboto. */
function makeAssets(o: Opts, embedded: Map<string, Uint8Array>): (id: string) => Promise<Uint8Array> {
  const folder = new Map<string, string>()
  if (o.fonts) {
    const list = path.join(o.fonts, 'fonts.json')
    if (fs.existsSync(list)) for (const f of JSON.parse(fs.readFileSync(list, 'utf8')) as Array<{ family: string; file: string }>) {
      const rel = f.file.replace(/^fonts\//, ''), cand = [path.join(o.fonts, f.file), path.join(o.fonts, rel), path.join(o.fonts, path.basename(f.file))].find(p => fs.existsSync(p))
      if (cand) folder.set(`font:${f.family}`, cand)
    }
    for (const f of fs.readdirSync(o.fonts)) if (/\.(ttf|otf|woff2?)$/i.test(f)) folder.set(`font:${f.replace(/\.[^.]+$/, '')}`, path.join(o.fonts, f))
  }
  const roboto = new Uint8Array(robotoUrl as unknown as Uint8Array)
  return async id => {
    const e = embedded.get(id); if (e) return e
    const f = o.font.get(id) ?? folder.get(id)
    if (f) return new Uint8Array(fs.readFileSync(f))
    if (id === 'roboto-regular' || id === 'font:Roboto') return roboto
    throw new Error(`asset ${id} is not available: give it with --font ${id}=<file> or --fonts <folder>`)
  }
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2))
  const say = (s: string): void => { if (!o.quiet) process.stderr.write(s + '\n') }
  for (const f of [o.recipe, o.input]) if (!fs.existsSync(f)) fail(1, `no such file: ${f}`)
  if (!/\.(stl|3mf)$/i.test(o.output)) fail(2, `the result is a .stl or .3mf file: ${o.output}`)

  const parsed = parseRecipe(fs.readFileSync(o.recipe, 'utf8'))
  if (!parsed.ok) return fail(1, `${o.recipe} is not a usable recipe: ${parsed.errors.map(describe).join('; ')}`)
  const recipe = parsed.recipe
  const registry = registerBuiltInPlugins(new Registry())
  const problems = recipeProblems(recipe, registry)
  if (problems.missingPlugins.length > 0) fail(1, `the recipe needs plugins this command does not have: ${problems.missingPlugins.map(p => `${p.id} ${p.version}`).join(', ')} (only the built-in plugins are included)`)
  if (problems.unknownOps.length > 0) fail(1, `the recipe uses operations the built-in plugins do not have: ${problems.unknownOps.map(p => `${p.plugin}/${p.op}`).join(', ')}`)
  for (const d of problems.versionDiffers) say(`note: ${d.id} is ${d.installed} here, the recipe was made with ${d.recipe}`)

  const embedded = new Map<string, Uint8Array>()
  for (const a of recipe.assets ?? []) embedded.set(a.id, new Uint8Array(Buffer.from(a.base64, 'base64')))

  const source = await readModel(o.input)
  const steps = applyRecipe(emptyStepList(), recipe).list
  say(`${recipe.name}: ${steps.steps.length} step${steps.steps.length === 1 ? '' : 's'} on ${path.basename(o.input)} (${source.indices.length / 3} triangles)`)
  const t0 = Date.now()
  const assets = makeAssets(o, embedded)
  const r = await runWorkflow(steps, { registry, source, quality: o.quality, assets, fonts: createFontService(assets) })
  r.results.forEach((x, i) => {
    const s = steps.steps[i]
    const label = `${i + 1}. ${s?.name ?? s?.op ?? ''}`.trim()
    if (x.error) process.stderr.write(`${label}: FAILED ${describe(x.error)}\n`)
    else say(`${label}: ${x.status ?? 'ok'}${x.warnings?.length ? ` (warnings: ${x.warnings.map(describe).join('; ')})` : ''}`)
  })
  if (!r.ok || !r.mesh) return fail(1, 'a step failed, nothing was written')

  fs.mkdirSync(path.dirname(path.resolve(o.output)), { recursive: true })
  if (/\.stl$/i.test(o.output)) fs.writeFileSync(o.output, writeStlBinary(r.mesh))
  else fs.writeFileSync(o.output, (await write3mfCompressed(r.mesh, { slicer: 'none', title: recipe.name })).bytes)
  const m = measureMesh(r.mesh)
  const summary = { output: o.output, triangles: m.triangles, size: m.size.map(x => Math.round(x * 100) / 100), watertight: m.watertight, seconds: Math.round((Date.now() - t0) / 100) / 10 }
  say(`wrote ${o.output}: ${summary.triangles} triangles, ${summary.size.join(' x ')} mm, ${m.watertight ? 'closed solid' : 'NOT closed'}, ${summary.seconds} s`)
  if (o.json) process.stdout.write(JSON.stringify(summary) + '\n')
}

main().catch(e => fail(1, e instanceof Error ? e.message : String(e)))
