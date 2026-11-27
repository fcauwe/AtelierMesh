/* eslint-disable-next-line @typescript-eslint/triple-slash-reference -- the plugin sources need the declarations of fontkit, clipper-lib and cdt2d */
/// <reference path="../../plugins/src/emboss/modules.d.ts" />
// What a plugin author needs without npm: `amplugin check`, `run` and `new`. Node only, no dependencies (everything is bundled into bin/amplugin.mjs).
//   check <dir>   the plugin folder is checked the way the host would: manifest, source rules, loading, every operation on small test models,
//                 determinism, cancelling, closed in -> closed out, labels kept, and every fixture in fixtures.json
//   run <dir>     try the plugin on a model and write the result
//   new <name>    a plain JavaScript plugin folder to start from
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import {
  Registry, addStep, buildFixtureMesh, canonicalJson, decodeDrawing, drawingBounds, drawingPointCount, emptyStepList, encodeDrawing, isMesh, makeStep, measureMesh, operationPayload, parseStl, payloadKindOf, read3mf, runFixtures, runWorkflow,
  sha256Hex, validateManifest, imageBytesProblem, validateParams, write3mf, writeStlBinary,
} from '@ateliermesh/core'
import type { Drawing, Fixture, FixtureInput, Manifest, Mesh, Operation, Payload, PluginModule, ProjectStore, RunContext, StructuredError } from '@ateliermesh/core'
import { createFontService } from '../../plugins/src/emboss/outlines'
import { readPackageLocales, suggestKey } from './locales'
import { newPluginFiles } from './templates'

export interface Row { status: 'ok' | 'FAIL' | 'note'; text: string; detail?: string }
export interface Report { rows: Row[]; failed: number; notes: number; passed: number }

const dec = new TextDecoder()
const short = (e: unknown): string => (e instanceof Error ? e.message : typeof e === 'object' && e !== null ? JSON.stringify(e) : String(e))
/** A readable sentence for a problem of the manifest, saying what to write; other problems keep the code and the numbers. */
export function describeManifestIssue(e: StructuredError): string {
  const p = (e.params ?? {}) as Record<string, unknown>
  switch (e.code) {
    case 'manifest.missing_license': return 'manifest.json has no "license". Add one, for example "license": "MIT" (an SPDX identifier such as MIT, Apache-2.0 or GPL-3.0-only, or "Proprietary").'
    case 'manifest.missing_description': return 'manifest.json has no "description". Add one or two sentences (10 to 300 characters, plain text) that say what the plugin does.'
    case 'manifest.bad_license': return `"license" is not usable (${String(p['reason'])}): use an SPDX identifier such as MIT or Apache-2.0, or "Proprietary", at most 64 characters of letters, digits and . + - and spaces.`
    case 'manifest.bad_description': return `"description" is not usable (${String(p['reason'])}): plain text of 10 to 300 characters with no line breaks.`
    case 'manifest.bad_contact': return `"contact.${String(p['field'])}" is not usable (${String(p['reason'])}): url must be an https address, email an address like you@example.org, name plain text up to 80 characters; no other fields.`
    case 'manifest.bad_image': return `"image" is not usable (${String(p['field'])}: ${String(p['reason'])}): give {"file": "assets/example.png", "alt": "5 to 160 characters describing the picture"}; the file must be inside the package`
    case 'manifest.bad_package_url': return `"package_url" is not usable (${String(p['reason'])}): an https address of at most 300 characters, without a user name or password.`
    default: return describeError(e)
  }
}
const describeError = (e: StructuredError): string => `${e.code}${e.path ? ` at ${e.path}` : ''}${e.params && Object.keys(e.params).length ? ` ${JSON.stringify(e.params)}` : ''}`

// ---------------------------------------------------------------------------------------------------- the source rules

/** What a plugin must not do: the host runs it in a sandbox with no network and no clock, and the same input has to give the same output. */
const RULES: Array<{ re: RegExp; code: string; why: string }> = [
  { re: /\bMath\.random\b/, code: 'random', why: 'Math.random makes every run different. Use a small seeded generator (a function of an integer seed), see the guide, section 4.' },
  { re: /\bcrypto\.(getRandomValues|randomUUID)\b/, code: 'random', why: 'random numbers make every run different. Use a seeded generator.' },
  { re: /\bDate\.now\b|\bnew Date\b|\bDate\(\)|\bperformance\.now\b/, code: 'clock', why: 'the clock makes every run different. A plugin is a pure function of its input.' },
  { re: /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bimportScripts\b|\bsendBeacon\b|\bEventSource\b/, code: 'network', why: 'a plugin has no network. Everything it needs is in the mesh, the settings or its own package.' },
  { re: /\beval\s*\(|\bnew Function\b|(^|[^.\w])Function\s*\(/, code: 'dynamic_code', why: 'no eval and no new Function: the host refuses code that builds code.' },
  { re: /^\s*import\b\s*[\w{*'"]|\bimport\s*\(|\brequire\s*\(/m, code: 'imports', why: 'main.js must be ONE file with no imports. Put every helper in the same file (or bundle them).' },
  { re: /\b(localStorage|sessionStorage|indexedDB|document\.cookie|postMessage)\b/, code: 'storage', why: 'a plugin keeps no state outside its own run.' },
]

/** Comments are not code (they may say "no Math.random"). Strings are left alone, so a rule that matches inside a string is still reported. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:\\'"`])\/\/[^\n]*/g, (_, p: string) => p)
}

export function scanSource(src: string): Array<{ code: string; line: number; why: string; text: string }> {
  const lines = stripComments(src).split('\n')
  const out: Array<{ code: string; line: number; why: string; text: string }> = []
  lines.forEach((l, i) => { for (const r of RULES) if (r.re.test(l)) out.push({ code: r.code, line: i + 1, why: r.why, text: l.trim().slice(0, 100) }) })
  return out
}

// ---------------------------------------------------------------------------------------------------- loading a plugin folder

async function loadEsbuild(dir: string): Promise<{ build: (o: Record<string, unknown>) => Promise<{ outputFiles?: Array<{ text: string }> }> }> {
  const { createRequire } = await import('node:module')
  const tries = [() => createRequire(path.resolve(dir, 'package.json')).resolve('esbuild'), () => createRequire(import.meta.url).resolve('esbuild')]
  for (const t of tries) { try { return (await import(pathToFileURL(t()).href)) as never } catch { /* the next place */ } }
  throw new Error('This plugin is written in TypeScript, so esbuild is needed to read it. Run `npm install -D esbuild` in the plugin folder, or write main.js by hand: then nothing is needed.')
}

export interface Folder { dir: string; manifestText: string; manifest: unknown; mainSource: string; mainFile: string }

export async function readFolder(dir: string): Promise<Folder> {
  const mf = path.join(dir, 'manifest.json')
  if (!existsSync(mf)) throw new Error(`no manifest.json in ${dir}`)
  const manifestText = readFileSync(mf, 'utf8')
  let manifest: unknown
  try { manifest = JSON.parse(manifestText) } catch (e) { throw new Error(`manifest.json is not valid JSON: ${short(e)}`) }
  const ts = ['main.ts', 'src/main.ts'].map(f => path.join(dir, f)).find(existsSync)
  const js = path.join(dir, 'main.js')
  if (existsSync(js)) return { dir, manifestText, manifest, mainSource: readFileSync(js, 'utf8'), mainFile: 'main.js' }
  if (ts) {
    const esbuild = await loadEsbuild(dir)
    const r = await esbuild.build({ entryPoints: [ts], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, logLevel: 'warning' })
    return { dir, manifestText, manifest, mainSource: r.outputFiles?.[0]?.text ?? '', mainFile: path.basename(ts) }
  }
  throw new Error('no main.js (or main.ts) next to manifest.json')
}

export async function loadModule(source: string): Promise<PluginModule> {
  const m = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)) as { default?: PluginModule }
  if (!m.default || typeof m.default.run !== 'function') throw new Error('main.js must have a default export with a run(op, ctx) function: `export default { async run(op, ctx) { ... } }`')
  return m.default
}

// ---------------------------------------------------------------------------------------------------- test models

const box = (): Mesh => buildFixtureMesh({ kind: 'generator', name: 'box', params: { width: 10, depth: 20, height: 30 } }) as Mesh
const sphere = (): Mesh => buildFixtureMesh({ kind: 'generator', name: 'sphere', params: { radius: 5, subdivisions: 2 } }) as Mesh
const bracket = (): Mesh => buildFixtureMesh({ kind: 'generator', name: 'l_bracket' }) as Mesh

/** A box with two segments and two bodies, to see that a plugin keeps its labels. */
function labelled(): Mesh {
  const m = box()
  const nt = m.indices.length / 3
  return {
    ...m,
    segments: { labels: Uint16Array.from({ length: nt }, (_, i) => (i < 2 ? 1 : 0)), table: [{ id: 0, name: 'body' }, { id: 1, name: 'lid' }] },
    groups: [{ start: 0, count: nt / 2, role: 'solid', name: 'first' }, { start: nt / 2, count: nt / 2, role: 'solid', name: 'second' }],
  }
}

/** A flat rectangle, 20 x 10 mm: the drawing a check or a run uses where a plugin takes one and none was given. */
const squareDrawing = (w = 20, h = 10): Drawing => ({ kind: 'drawing', paths: [{ closed: true, points: [[0, 0], [w, 0], [w, h], [0, h]] }] })

/** What a plugin's `payload` settings get when nothing else was given: a drawing where a drawing is accepted, else a box. Named `sample_<setting>`. */
function samplePayloads(op: Operation): { params: Record<string, unknown>; store: ProjectStore } {
  const params: Record<string, unknown> = {}, store: ProjectStore = {}
  for (const p of op.params) if (p.type === 'payload') {
    const name = `sample_${p.name}`
    store[name] = { payload: p.accept.includes('drawing') || p.accept.includes('*') ? squareDrawing() : box() }
    params[p.name] = name
  }
  return { params, store }
}

/** The main input a check gives an operation: nothing for a generator, a drawing for a step that takes one, else the 10 x 20 x 30 box. */
const mainInput = (op: Operation): Payload | undefined => (op.kind === 'generator' ? undefined : operationPayload(op).in === 'drawing' ? squareDrawing() : box())
const inputLabel = (p: Payload | undefined): string => (p && !isMesh(p) ? 'a 20 x 10 mm rectangle drawing' : 'a 10 x 20 x 30 box')
const asContext = (p: Payload | undefined): { mesh?: Mesh; payload?: Payload } => (p ? (isMesh(p) ? { mesh: p, payload: p } : { payload: p }) : {})

function meshHash(m: Mesh): string {
  const a = new Uint8Array(m.positions.buffer, m.positions.byteOffset, m.positions.byteLength)
  const b = new Uint8Array(m.indices.buffer, m.indices.byteOffset, m.indices.byteLength)
  const all = new Uint8Array(a.length + b.length)
  all.set(a); all.set(b, a.length)
  return sha256Hex(all)
}

// ---------------------------------------------------------------------------------------------------- check

interface FixtureFile { name?: string; description?: string; operation?: string; params?: Record<string, unknown>; steps?: Array<{ operation: string; params?: Record<string, unknown> }>; input?: unknown; /** Items in the project store by name: a drawing, or a mesh like `input`. */ store?: Record<string, unknown>; expect?: Fixture['expect'] }

function toInput(x: unknown): FixtureInput {
  if (x === undefined || x === null) return null
  const o = x as { generator?: string; params?: Record<string, number>; positions?: number[]; indices?: number[]; kind?: string; name?: string }
  if (o.kind === 'generator' || o.kind === 'mesh' || o.kind === 'drawing') return x as FixtureInput
  if (typeof o.generator === 'string') return { kind: 'generator', name: o.generator as 'box', ...(o.params ? { params: o.params } : {}) }
  if (Array.isArray(o.positions) && Array.isArray(o.indices)) return { kind: 'mesh', positions: o.positions, indices: o.indices }
  throw new Error('a fixture input is { "generator": "box" | "sphere" | "cylinder" | "l_bracket", "params": {...} } or { "positions": [...], "indices": [...] }')
}

/** For a plugin that asks for fonts: every font id resolves to the one file given with `--font` (a TrueType or OpenType file), and `ctx.fonts.outline` works on it. */
function devFonts(fontFile: string | undefined): { assets: (id: string) => Promise<Uint8Array>; fonts: ReturnType<typeof createFontService> | undefined } {
  if (!fontFile) return { assets: id => Promise.reject(new Error(`no font for ${id}: give a font file with --font <file.ttf>`)), fonts: undefined }
  const bytes = new Uint8Array(readFileSync(fontFile))
  const assets = (): Promise<Uint8Array> => Promise.resolve(bytes)
  return { assets, fonts: createFontService(assets) }
}

export async function checkFolder(dir: string, opts: { font?: string } = {}): Promise<Report> {
  const dev = devFonts(opts.font)
  const rows: Row[] = []
  const add = (status: Row['status'], text: string, detail?: string): void => { rows.push({ status, text, ...(detail ? { detail } : {}) }) }
  let folder: Folder
  try { folder = await readFolder(dir) } catch (e) { add('FAIL', 'the plugin folder can be read', short(e)); return summary(rows) }
  add('ok', `the folder has manifest.json and ${folder.mainFile}`)

  // 1. the manifest, with the real validator
  const v = validateManifest(folder.manifest, { requireMetadata: true })
  if (!v.ok || !v.value) {
    for (const e of v.errors) add('FAIL', `manifest: ${describeManifestIssue(e)}`)
    return summary(rows)
  }
  const manifest: Manifest = v.value
  add('ok', `the manifest is valid (${manifest.id} ${manifest.version}, ${manifest.operations.length} operation${manifest.operations.length === 1 ? '' : 's'})`)
  add('ok', `the manifest says what it is: licence ${manifest.license}, description of ${(manifest.description ?? '').length} characters`)
  if (manifest.contact && (manifest.contact.url || manifest.contact.email)) add('ok', `contact details are given (${[manifest.contact.url ? 'web address' : '', manifest.contact.email ? 'email' : ''].filter(Boolean).join(' and ')})`)
  else add('note', 'no contact details (optional): add "contact": { "url": "https://...", "email": "you@example.org" } so users can reach you')
  if (manifest.image) {
    const ip = path.join(dir, manifest.image.file)
    if (!existsSync(ip)) add('FAIL', `the example picture ${manifest.image.file} exists in the folder`)
    else {
      const pr = imageBytesProblem(new Uint8Array(readFileSync(ip)))
      if (pr) add('FAIL', `example picture ${manifest.image.file}: ${describeImageProblem(pr.code, pr.params)}`)
      else add('ok', `the example picture ${manifest.image.file} is a usable PNG, JPEG or WebP`)
    }
  } else add('note', 'no "image" (optional): an example picture (assets/example.png, 640 x 420 px) shows in the plugin gallery')
  if (!manifest.package_url) add('note', 'no "package_url" (optional): add the https address where the packed .amplugin will be published, so users can check for updates')
  // the plugin's own texts: the same limits and namespace rule a host applies when it reads the package
  {
    const ld = path.join(dir, 'locales')
    if (!existsSync(ld)) add('note', 'no locales/ folder: add en.json, nl.json and fr.json with the plugin\'s texts (they show in the user\'s language)')
    else {
      const files = new Map<string, Uint8Array>(readdirSync(ld).filter(n => statSync(path.join(ld, n)).isFile()).map(n => [`locales/${n}`, new Uint8Array(readFileSync(path.join(ld, n)))]))
      try {
        const r = readPackageLocales(files, manifest)
        for (const g of r.ignored) add('FAIL', `locales: ${g.item} is left out by a host (${g.reason === 'outside_namespace' ? `outside the plugin's own namespace: ops.<operation id>.*, step.op.<operation id>, mesh.<operation id or last part of the plugin id>.*${(() => { const s = suggestKey(manifest, g.item.slice(g.item.indexOf(':') + 1)); return s ? `. Move it to ${s}` : '' })()}` : g.reason === 'bad_key' ? 'a key may only hold letters, digits, _ and -' : 'not a language file name like en.json'})`)
        if (r.ignored.length === 0) add('ok', `locales/ holds ${Object.keys(r.texts).length} language${Object.keys(r.texts).length === 1 ? '' : 's'} (${Object.keys(r.texts).sort().join(', ')}), all inside the plugin's own namespace`)
      } catch (e) { add('FAIL', `locales/ is not usable: ${short(e)}`) }
    }
  }

  // 2. the source rules
  const found = scanSource(folder.mainSource)
  if (found.length === 0) add('ok', 'main.js follows the rules: no random numbers, no clock, no network, no eval, no imports')
  else for (const f of found) add('FAIL', `${folder.mainFile} line ${f.line} (${f.code}): ${f.why}`, f.text)

  // 3. loading it
  let mod: PluginModule
  try { mod = await loadModule(folder.mainSource); add('ok', 'main.js loads as a module with a run function') } catch (e) { add('FAIL', 'main.js loads as a module with a run function', short(e)); return summary(rows) }
  const registry = new Registry().register({ manifest, load: () => mod, untrusted: true })   // untrusted: every mesh it returns is checked, as the host does

  // 4. the settings of every operation
  for (const op of manifest.operations) {
    const d = validateParams(op, {})
    if (d.ok) add('ok', `${op.id}: the default settings are valid`)
    else add('note', `${op.id}: the default settings are not a valid step by themselves (${d.errors.map(describeError).join('; ')}): the checks below that need a default run are skipped; put explicit settings in fixtures.json`)
    const flagged = op.params.filter(p => (p as { personalisable?: boolean }).personalisable === true)
    if (op.personalisable === 'never' && flagged.length > 0) add('FAIL', `${op.id}: "personalisable" is "never" but ${flagged.map(p => p.name).join(', ')} is marked personalisable`)
    else if ((op.personalisable === 'optional' || op.personalisable === 'always') && flagged.length === 0) add('note', `${op.id}: "personalisable" is "${op.personalisable}" but no setting is marked personalisable: a designer cannot hand anything to a customer`)
    else add('ok', `${op.id}: personalisable flags are consistent`)
  }

  // 5. every operation on small models
  const step = (op: Operation, params: Record<string, unknown> = {}) => makeStep({ id: 's1', plugin: { id: manifest.id, version: manifest.version }, op: op.id, params })
  const go = (op: Operation, source: Payload | undefined, signal?: AbortSignal) => {
    const sample = samplePayloads(op)   // a setting that takes a stored item gets a small sample of the kind it accepts
    return runWorkflow(addStep(emptyStepList(), step(op, sample.params)), { registry, assets: dev.assets, ...(dev.fonts ? { fonts: dev.fonts } : {}), ...(source ? { source } : {}), store: sample.store, ...(signal ? { signal } : {}) })
  }
  for (const op of manifest.operations) {
    if (!validateParams(op, {}).ok) continue
    const input = mainInput(op)
    const what = inputLabel(input)
    const first = await go(op, input).catch((e: unknown) => ({ ok: false, results: [{ error: { code: 'check.crashed', params: { message: short(e) } } }], mesh: undefined }) as never)
    const r0 = (first as { results: Array<{ error?: StructuredError; report?: unknown }> }).results[0]
    if (!(first as { ok: boolean }).ok) { add('FAIL', `${op.id}: runs on ${what} with its default settings`, r0?.error ? describeError(r0.error) : 'it failed'); continue }
    add('ok', `${op.id}: runs on ${what} with its default settings`)
    const out = (first as { mesh?: Mesh }).mesh
    const outPayload = (first as { payload?: Payload }).payload
    // determinism
    const second = await go(op, input)
    if (out && second.mesh) add(meshHash(out) === meshHash(second.mesh) ? 'ok' : 'FAIL', `${op.id}: the same input gives the same result (two runs, same triangles and positions)`)
    else if (outPayload && !isMesh(outPayload) && second.payload) add(canonicalJson(outPayload) === canonicalJson(second.payload) ? 'ok' : 'FAIL', `${op.id}: the same input gives the same ${payloadKindOf(outPayload)} (two runs)`)
    // closed in -> closed out
    if (out && op.outputs?.closed) {
      for (const [label, m] of [['box', box()], ['sphere', sphere()], ['L bracket', bracket()]] as const) {
        const r = await go(op, m)
        if (!r.ok || !r.mesh) { add('FAIL', `${op.id}: runs on a ${label}`, r.results[0]?.error ? describeError(r.results[0].error) : ''); continue }
        add(measureMesh(r.mesh).watertight ? 'ok' : 'FAIL', `${op.id}: a closed ${label} stays a closed solid (the manifest promises "closed")`)
      }
    }
    // labels
    if (out && op.kind !== 'analyzer' && operationPayload(op).in !== 'drawing') {
      const input2 = labelled()
      const r = await go(op, input2)
      const drops = (op.outputs?.drops ?? []) as Array<unknown>
      if (r.ok && r.mesh) {
        const nt = r.mesh.indices.length / 3
        if (!r.mesh.segments && !drops.includes('segments')) add('FAIL', `${op.id}: segments are kept (the result of a labelled box has none: copy mesh.segments through, or declare outputs.drops)`)
        else if (r.mesh.segments && r.mesh.segments.labels.length !== nt) add('FAIL', `${op.id}: segment labels match the triangles (${r.mesh.segments.labels.length} labels for ${nt} triangles)`)
        else add('ok', `${op.id}: segments stay valid`)
        if (!r.mesh.groups && !drops.includes('groups')) add('FAIL', `${op.id}: groups (bodies) are kept (the result of a two-body box has none: copy mesh.groups through, or declare outputs.drops)`)
        else if (r.mesh.groups && r.mesh.groups.some(g => g.start < 0 || g.count < 0 || g.start + g.count > nt)) add('FAIL', `${op.id}: group ranges lie inside the result`)
        else add('ok', `${op.id}: groups stay valid`)
      } else add('note', `${op.id}: could not run on a box with two segments and two bodies (${r.results[0]?.error ? describeError(r.results[0].error) : 'failed'}): labels were not checked`)
    }
    // cancelling: called directly with a signal that has already fired
    {
      const ctrl = new AbortController(); ctrl.abort()
      const params = validateParams(op, {}).value
      const sampleForCtx = samplePayloads(op)
      const ctx: RunContext = { params: { ...params, ...sampleForCtx.params }, ...asContext(input), payloads: Object.fromEntries(Object.entries(sampleForCtx.params).map(([k, name]) => [k, (sampleForCtx.store[name as string] as { payload: Payload }).payload])), assets: dev.assets, fonts: { outline: dev.fonts ?? (() => Promise.reject(new Error('no fonts in check: give a font file with --font <file.ttf>'))) }, quality: 'export', progress: () => undefined, signal: ctrl.signal, log: () => undefined }
      try { await mod.run(op.id, ctx); add('note', `${op.id}: finishes even when cancelled first (fine for a fast operation; a slow one must look at ctx.signal)`) } catch (e) {
        const code = (e as { code?: string } | null)?.code
        add(code === 'run.cancelled' ? 'ok' : 'FAIL', `${op.id}: stops with run.cancelled when cancelled`, code === 'run.cancelled' ? undefined : `it threw ${short(e)}; throw { code: 'run.cancelled', params: {} }`)
      }
    }
  }

  // 6. the plugin's own fixtures
  const fx = path.join(dir, 'fixtures.json')
  if (existsSync(fx)) {
    try {
      const list = JSON.parse(readFileSync(fx, 'utf8')) as FixtureFile[]
      if (!Array.isArray(list)) throw new Error('fixtures.json must be a list')
      const fixtures: Fixture[] = list.map((f, i) => {
        const steps = (f.steps ?? (f.operation ? [{ operation: f.operation, ...(f.params ? { params: f.params } : {}) }] : [])).map((s, k) => makeStep({ id: `s${k + 1}`, plugin: { id: manifest.id, version: manifest.version }, op: s.operation, params: s.params ?? {} }))
        const store = f.store ? Object.fromEntries(Object.entries(f.store).map(([k, v]) => { const x = toInput(v); const p = x && x.kind === 'drawing' ? x : x ? buildFixtureMesh(x) : undefined; if (!p) throw new Error(`store entry ${k} is a drawing or a model like "input"`); return [k, p] as const })) : undefined
        return { name: f.name ?? `fixture ${i + 1}`, ...(f.description ? { description: f.description } : {}), input: toInput(f.input), ...(store ? { store } : {}), steps, expect: f.expect ?? {} }
      })
      for (const r of await runFixtures(fixtures, { registry, assets: dev.assets, ...(dev.fonts ? { fonts: dev.fonts } : {}) })) add(r.ok ? 'ok' : 'FAIL', `fixture: ${r.name}`, r.failures.join('\n'))
      if (fixtures.length === 0) add('note', 'fixtures.json is empty')
    } catch (e) { add('FAIL', 'fixtures.json can be read', short(e)) }
  } else add('note', 'no fixtures.json: add a few with expected sizes, volumes and error codes (the guide, section 12)')
  return summary(rows)
}

function summary(rows: Row[]): Report {
  return { rows, failed: rows.filter(r => r.status === 'FAIL').length, notes: rows.filter(r => r.status === 'note').length, passed: rows.filter(r => r.status === 'ok').length }
}

export function formatReport(r: Report): string {
  const lines = r.rows.map(x => `${x.status === 'ok' ? 'ok   ' : x.status === 'FAIL' ? 'FAIL ' : 'note '} ${x.text}${x.detail ? `\n       ${x.detail.split('\n').join('\n       ')}` : ''}`)
  lines.push('', `${r.passed} passed, ${r.failed} failed, ${r.notes} note${r.notes === 1 ? '' : 's'}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------------------------------- run

export async function readInput(spec: string): Promise<Mesh> {
  const g = /^generator:([a-z_]+)(?::([\d.,\s-]+))?$/.exec(spec)
  if (g) {
    const n = (g[2] ?? '').split(',').map(Number).filter(x => Number.isFinite(x))
    const name = g[1] as string
    const input: FixtureInput = name === 'box' ? { kind: 'generator', name: 'box', params: { width: n[0] ?? 10, depth: n[1] ?? n[0] ?? 10, height: n[2] ?? n[0] ?? 10 } }
      : name === 'plate' ? { kind: 'generator', name: 'box', params: { width: n[0] ?? 40, depth: n[1] ?? 30, height: n[2] ?? 3 } }
      : name === 'sphere' ? { kind: 'generator', name: 'sphere', params: { radius: n[0] ?? 5, subdivisions: n[1] ?? 3 } }
      : name === 'cylinder' ? { kind: 'generator', name: 'cylinder', params: { radius: n[0] ?? 5, height: n[1] ?? 10, segments: n[2] ?? 48 } }
      : name === 'l_bracket' ? { kind: 'generator', name: 'l_bracket' } : (() => { throw new Error(`unknown generator ${name}: box, plate, sphere, cylinder or l_bracket`) })()
    return buildFixtureMesh(input) as Mesh
  }
  const bytes = new Uint8Array(readFileSync(spec))
  if (/\.stl$/i.test(spec)) return parseStl(bytes).mesh
  if (/\.3mf$/i.test(spec)) return (await read3mf(bytes)).mesh
  throw new Error('--input is a .stl or .3mf file, or generator:box (also generator:box:10,20,30, plate, sphere:5, cylinder:5,10, l_bracket)')
}

/** The main input of a run: a model file or a generator (as `readInput`), a drawing file (`.amdraw`), or `drawing:square[:w,h]`. */
export async function readPayload(spec: string): Promise<Payload> {
  const sq = /^drawing:square(?::([\d.]+)(?:,([\d.]+))?)?$/.exec(spec)
  if (sq) return squareDrawing(Number(sq[1] ?? 20), Number(sq[2] ?? sq[1] ?? 10))
  if (/\.amdraw$/i.test(spec)) return decodeDrawing(new Uint8Array(readFileSync(spec)))
  return readInput(spec)
}

export async function runFolder(dir: string, opts: { input?: string; op?: string; params?: Record<string, unknown>; out?: string; font?: string; /** Items for the operation's `payload` settings: setting name to a spec as `readPayload` reads it. */ payloads?: Record<string, string> }): Promise<string> {
  const dev = devFonts(opts.font)
  const folder = await readFolder(dir)
  const v = validateManifest(folder.manifest)
  if (!v.ok || !v.value) throw new Error(`manifest: ${v.errors.map(describeManifestIssue).join('; ')}`)
  const manifest = v.value
  const op = manifest.operations.find(o => o.id === (opts.op ?? manifest.operations[0]?.id))
  if (!op) throw new Error(`no operation ${opts.op}: ${manifest.operations.map(o => o.id).join(', ')}`)
  const mod = await loadModule(folder.mainSource)
  const registry = new Registry().register({ manifest, load: () => mod, untrusted: true })
  const kinds = operationPayload(op)
  if (op.kind !== 'generator' && !opts.input) throw new Error(`--input is needed: ${kinds.in === 'drawing' ? 'a drawing (file.amdraw or drawing:square)' : 'a model (.stl, .3mf or generator:box)'}`)
  const source = op.kind === 'generator' ? undefined : await readPayload(opts.input as string)
  // the operation's `payload` settings: --payload <setting>=<spec> puts an item in the store under the setting's name and points the setting at it
  const params: Record<string, unknown> = { ...(opts.params ?? {}) }, store: ProjectStore = {}
  for (const p of op.params) if (p.type === 'payload') {
    const spec = opts.payloads?.[p.name]
    if (spec === undefined) { if (params[p.name] === undefined) throw new Error(`the setting "${p.name}" takes a stored item (${p.accept.join(' or ')}): give --payload ${p.name}=<file.amdraw | drawing:square | model.stl | generator:box>`); continue }
    store[p.name] = { payload: await readPayload(spec) }
    params[p.name] = p.name
  }
  for (const k of Object.keys(opts.payloads ?? {})) if (!op.params.some(p => p.name === k && p.type === 'payload')) throw new Error(`--payload ${k}: the operation has no setting "${k}" that takes a stored item`)
  const res = await runWorkflow(addStep(emptyStepList(), makeStep({ id: 's1', plugin: { id: manifest.id, version: manifest.version }, op: op.id, params })), { registry, assets: dev.assets, ...(dev.fonts ? { fonts: dev.fonts } : {}), ...(source ? { source } : {}), store })
  const r0 = res.results[0]
  if (!res.ok || !res.payload) throw new Error(`the step failed: ${r0?.error ? describeError(r0.error) : 'no result'}`)
  const lines: string[] = []
  if (isMesh(res.payload)) {
    const m = measureMesh(res.payload)
    lines.push(`${manifest.id} ${op.id}: ok`, `triangles ${res.payload.indices.length / 3}, size ${m.size.map(x => Math.round(x * 1000) / 1000).join(' x ')} mm, volume ${Math.round(m.volume * 1000) / 1000} mm3, closed solid: ${m.watertight ? 'yes' : 'no'}`)
  } else if (payloadKindOf(res.payload) === 'drawing') {
    const dr = res.payload as Drawing, b = drawingBounds(dr)
    lines.push(`${manifest.id} ${op.id}: ok`, `drawing: ${dr.paths.length} path${dr.paths.length === 1 ? '' : 's'}, ${drawingPointCount(dr)} points${b ? `, from (${b[0]}, ${b[1]}) to (${b[2]}, ${b[3]}) mm` : ''}`)
  } else lines.push(`${manifest.id} ${op.id}: ok (a result of kind ${payloadKindOf(res.payload)})`)
  if (r0?.report) lines.push(`report ${JSON.stringify(r0.report)}`)
  if (r0?.warnings?.length) lines.push(`warnings ${r0.warnings.map(describeError).join('; ')}`)
  if (opts.out) {
    mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true })
    if (isMesh(res.payload)) {
      if (/\.stl$/i.test(opts.out)) writeFileSync(opts.out, writeStlBinary(res.payload))
      else if (/\.3mf$/i.test(opts.out)) writeFileSync(opts.out, write3mf(res.payload, { slicer: 'none' }).bytes)
      else throw new Error('--out is a .stl or .3mf file for a model')
    } else if (payloadKindOf(res.payload) === 'drawing') {
      if (!/\.amdraw$/i.test(opts.out)) throw new Error('--out is a .amdraw file for a drawing')
      writeFileSync(opts.out, encodeDrawing(res.payload as Drawing))
    } else throw new Error('--out cannot write this kind of result')
    lines.push(`wrote ${opts.out}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------------------------------- new

export function scaffold(name: string, into: string): string[] {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(name)) throw new Error('the name is lowercase letters, digits and hyphens, starting with a letter (for example my-shift)')
  const dir = path.resolve(into, name)
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`${dir} already exists and is not empty`)
  const files = newPluginFiles(name)
  const written: string[] = []
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(dir, rel)
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(p, text)
    written.push(path.join(name, rel))
  }
  return written
}

export { dec }

/** A sentence for the problems `imageBytesProblem` finds in a plugin's example picture. */
export function describeImageProblem(code: string, p: Record<string, unknown>): string {
  switch (code) {
    case 'package.image_type': return 'must be a PNG, JPEG or WebP picture (it is checked by its content, not its name)'
    case 'package.image_too_big': return `is ${String(p['bytes'])} bytes; the most allowed is ${String(p['max'])} (300 KB). Make it smaller (for example 640 x 420 px).`
    default: return `is ${String(p['width'])} x ${String(p['height'])} px; it must be at least ${String(p['minWidth'])} px wide and at most ${String(p['maxWidth'])} x ${String(p['maxHeight'])} px`
  }
}
