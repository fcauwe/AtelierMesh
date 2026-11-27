// The `amplugin` command line tool: keygen, pack, inspect. Node only. Built into bin/amplugin.mjs by scripts/build-cli.mjs.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { buildPluginPackage } from './builder'
import { readPackageLocales } from './locales'
import { readPluginPackage } from './package'
import { describeImageProblem } from './devtools'
import { generateKeyPair } from './signing'
import { checkFolder, describeManifestIssue, formatReport, runFolder, scaffold } from './devtools'
import { validateManifest, imageBytesProblem } from '@ateliermesh/core'

const USAGE = `amplugin <command>      (the tool of the AtelierMesh plugin kit; the npm package called "amplugin" is a different, unrelated project)
  new <name>                           a plain JavaScript plugin folder to start from (no npm, no build): manifest.json, main.js, fixtures.json, locales/
  check <dir> [--font file.ttf]        test a plugin folder the way the host would: manifest, rules, every operation on test models, determinism, cancelling, labels, fixtures.json
                                       (--font: a font file for a plugin that asks the host for letter outlines, ctx.fonts.outline)
  run <dir> --input <model.stl|model.3mf|generator:box[:w,d,h]|drawing.amdraw|drawing:square[:w,h]> [--op id] [--params '{"x":5}'] [--payload setting=<drawing.amdraw|drawing:square|model.stl|generator:box>] [--out result.stl|result.3mf|result.amdraw] [--font file.ttf]
                                       (--payload: for a setting that takes a stored item, a drawing or a model; repeat it for several settings. A generator needs no --input.)
                                       try the plugin on a model and write the result
  keygen <name>                        write <name>.key (private) and <name>.pub (public, base64); keep the .key file secret
  pack <dir> [--out file] [--key private.key] [--no-hashes]
                                       build <id>-<version>.amplugin from <dir>/manifest.json, <dir>/main.js (or main.ts), <dir>/assets/ and <dir>/locales/
                                       (a plugin written in TypeScript needs esbuild in its own folder: npm i -D esbuild; plain JavaScript needs nothing)
  sign <dir> --key private.key [--out file]
                                       the same as pack with --key: a signed package
  inspect <file> [--trust public.pub]  check a package and print what it is
  verify <file> --trust public.pub     like inspect, and fails unless the package is signed by that key`

function files(dir: string, base = dir): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {}
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f)
    if (statSync(p).isDirectory()) Object.assign(out, files(p, base))
    else out[path.relative(base, p).split(path.sep).join('/')] = new Uint8Array(readFileSync(p))
  }
  return out
}

/** esbuild is only needed to turn TypeScript into one JavaScript file. It is taken from the plugin's own folder (npm i -D esbuild there), or from next to this tool. */
async function loadEsbuild(dir: string): Promise<{ build: (o: Record<string, unknown>) => Promise<{ outputFiles?: Array<{ text: string }> }> }> {
  const tries = [() => createRequire(path.resolve(dir, 'package.json')).resolve('esbuild'), () => createRequire(import.meta.url).resolve('esbuild')]
  for (const t of tries) { try { return (await import(pathToFileURL(t()).href)) as never } catch { /* try the next place */ } }
  throw new Error('This plugin is written in TypeScript, so esbuild is needed to pack it. Run `npm install -D esbuild` in the plugin folder (or write main.js by hand: then nothing is needed).')
}

function option(args: string[], name: string): string | undefined { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
/** Every value of an option that may be given more than once. */
function options(args: string[], name: string): string[] { return args.flatMap((a, i) => (a === name && args[i + 1] !== undefined ? [args[i + 1] as string] : [])) }

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv
  if (cmd === 'new') {
    const name = args[0]
    if (!name) { console.error(USAGE); return 2 }
    try { const written = scaffold(name, process.cwd()); console.log(`wrote ${name}/\n${written.map(f => `  ${f}`).join('\n')}\nnext: node amplugin.mjs check ${name}    (amplugin.mjs is in the tools/ folder of the plugin kit)`); return 0 } catch (e) { console.error(e instanceof Error ? e.message : String(e)); return 2 }
  }
  if (cmd === 'check') {
    const dir = args[0]
    if (!dir) { console.error(USAGE); return 2 }
    const report = await checkFolder(dir, option(args, '--font') ? { font: option(args, '--font') as string } : {})
    console.log(formatReport(report))
    return report.failed === 0 ? 0 : 1
  }
  if (cmd === 'run') {
    const dir = args[0], input = option(args, '--input')
    if (!dir) { console.error(USAGE); return 2 }
    const payloads: Record<string, string> = {}
    for (const spec of options(args, '--payload')) { const k = spec.indexOf('='); if (k < 1) { console.error('--payload is <setting>=<file or generator>, for example --payload shape=logo.amdraw'); return 2 }; payloads[spec.slice(0, k)] = spec.slice(k + 1) }
    const raw = option(args, '--params')
    let params: Record<string, unknown> | undefined
    if (raw) { try { params = JSON.parse(raw) as Record<string, unknown> } catch { console.error('--params must be JSON, for example --params \'{"x":5}\''); return 2 } }
    try { console.log(await runFolder(dir, { ...(input ? { input } : {}), ...(Object.keys(payloads).length > 0 ? { payloads } : {}), ...(option(args, '--op') ? { op: option(args, '--op') as string } : {}), ...(params ? { params } : {}), ...(option(args, '--font') ? { font: option(args, '--font') as string } : {}), ...(option(args, '--out') ? { out: option(args, '--out') as string } : {}) })); return 0 } catch (e) { console.error(e instanceof Error ? e.message : String(e)); return 1 }
  }
  if (cmd === 'keygen') {
    const name = args[0]
    if (!name) { console.error(USAGE); return 2 }
    const k = await generateKeyPair()
    writeFileSync(`${name}.key`, k.privateKey + '\n', { mode: 0o600 })
    writeFileSync(`${name}.pub`, k.publicKey + '\n')
    console.log(`wrote ${name}.key (secret) and ${name}.pub\npublic key: ${k.publicKey}`)
    return 0
  }
  if (cmd === 'pack' || cmd === 'sign') {
    const dir = args[0]
    if (cmd === 'sign' && !option(args, '--key')) { console.error('sign needs --key private.key (make one with: keygen <name>)'); return 2 }
    if (!dir || !existsSync(path.join(dir, 'manifest.json'))) { console.error(`no manifest.json in ${dir ?? '(no directory)'}\n${USAGE}`); return 2 }
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { id: string; version: string }
    const metaCheck = validateManifest(manifest, { requireMetadata: true })
    if (!metaCheck.ok) { for (const e of metaCheck.errors) console.error(describeManifestIssue(e)); return 1 }
    let main: string
    const ts = ['main.ts', 'src/main.ts'].map(f => path.join(dir, f)).find(existsSync)
    if (ts) {
      const esbuild = await loadEsbuild(dir)
      const r = await esbuild.build({ entryPoints: [ts], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, minify: false, logLevel: 'warning' })
      main = r.outputFiles?.[0]?.text ?? ''
    } else if (existsSync(path.join(dir, 'main.js'))) main = readFileSync(path.join(dir, 'main.js'), 'utf8')
    else { console.error('no main.js or main.ts'); return 2 }
    const assets = existsSync(path.join(dir, 'assets')) ? Object.fromEntries(Object.entries(files(path.join(dir, 'assets'))).map(([k, v]) => [`assets/${k}`, v])) : {}
    // the plugin's texts travel in the package as locales/<lang>.json: same limits and namespace rule as a host applies when it reads it
    const ld = path.join(dir, 'locales')
    if (existsSync(ld)) {
      for (const [k, v] of Object.entries(files(ld))) assets[`locales/${k}`] = v
      try {
        const lp = readPackageLocales(new Map(Object.entries(assets).filter(([k]) => k.startsWith('locales/'))), manifest as never)
        if (lp.ignored.length > 0) { for (const g of lp.ignored) console.error(`locales: ${g.item}: ${g.reason} (a host would leave it out; keep to ops.<operation id>.*, step.op.<operation id>, mesh.<operation id or last part of the plugin id>.*)`); return 1 }
      } catch (e) { console.error(`locales: ${JSON.stringify((e as { params?: unknown }).params ?? String(e))}`); return 1 }
    }
    const imageFile = (manifest as { image?: { file: string } }).image?.file
    if (imageFile) {
      const ib = assets[imageFile]
      if (!ib) { console.error(`image: "${imageFile}" is not in the package. Put the picture in the assets folder and name it "assets/<file>".`); return 1 }
      const pr = imageBytesProblem(ib)
      if (pr) { console.error(`image "${imageFile}": ${describeImageProblem(pr.code, pr.params)}`); return 1 }
    }
    const keyFile = option(args, '--key')
    const bytes = await buildPluginPackage({ manifest: manifest as never, main, assets, hashes: !args.includes('--no-hashes'), ...(keyFile ? { privateKey: readFileSync(keyFile, 'utf8').trim() } : {}) })
    const out = option(args, '--out') ?? `${manifest.id}-${manifest.version}.amplugin`
    mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
    writeFileSync(out, bytes)
    console.log(`wrote ${out} (${(bytes.length / 1024).toFixed(1)} KB)${keyFile ? ', signed' : ''}`)
    return 0
  }
  if (cmd === 'inspect' || cmd === 'verify') {
    const file = args[0]
    if (!file) { console.error(USAGE); return 2 }
    const trust = option(args, '--trust')
    if (cmd === 'verify' && !trust) { console.error('verify needs --trust public.pub'); return 2 }
    const pkg = await readPluginPackage(new Uint8Array(readFileSync(file)), { origin: path.basename(file), trustedKeys: trust ? [{ name: path.basename(trust, '.pub'), publicKey: readFileSync(trust, 'utf8').trim() }] : [] })
    if (cmd === 'verify' && !(pkg.signed && pkg.signer)) { console.error('not signed by that key'); return 1 }
    console.log(JSON.stringify({ id: pkg.manifest.id, name: pkg.manifest.name, license: pkg.manifest.license, description: pkg.manifest.description, contact: pkg.manifest.contact ?? null, package_url: pkg.manifest.package_url ?? null, version: pkg.manifest.version, hash: pkg.hash, signed: pkg.signed, signer: pkg.signer ?? null, permissions: pkg.permissions, files: [...pkg.files.keys()] }, null, 2))
    return 0
  }
  console.error(USAGE)
  return cmd ? 2 : 0
}

main(process.argv.slice(2)).then(code => { process.exitCode = code }, e => { console.error(e instanceof Error ? e.message : JSON.stringify(e)); process.exitCode = 1 })
