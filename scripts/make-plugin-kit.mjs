// Builds the plugin developer kit: one zip with everything a person OUTSIDE this repository needs to write, test, pack and load a plugin.
//   build/kit/ateliermesh-plugin-kit-<version>.zip   (and the folder it was made from)
// Contents: README-START-HERE.md, the guide and the other plugin documents, the plugin parts of SPEC.md, the complete source of the Mirror example (set up to
// work outside the repository), the packed packages (core, plugins, ui, react) for types and local tests, the type declarations, and tools/amplugin.mjs (the
// packing tool, self-contained: Node 20 or newer, nothing to install; esbuild only when the plugin is written in TypeScript).
// Nothing is published to npm and the kit does not touch the repository. The packages are packed into a temporary folder (npm run pack would wipe build/);
// pass --tarballs <folder> to reuse tarballs that were already made.
// Usage: node scripts/make-plugin-kit.mjs [--out file.zip] [--tarballs folder] [--keep]
/* global process, console */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def }
const version = JSON.parse(readFileSync(path.join(root, 'packages/core/package.json'), 'utf8')).version
const name = `ateliermesh-plugin-kit-${version}`
const outZip = path.resolve(arg('out', path.join(root, 'build/kit', `${name}.zip`)))
const work = mkdtempSync(path.join(os.tmpdir(), 'ateliermesh-kit-'))
const dir = path.join(work, name)
mkdirSync(dir, { recursive: true })
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...opts })
const copy = (from, to) => cpSync(path.join(root, from), path.join(dir, to), { recursive: true })
const write = (to, text) => { mkdirSync(path.dirname(path.join(dir, to)), { recursive: true }); writeFileSync(path.join(dir, to), text) }

// 1. the packages (packed here, or taken from --tarballs)
let tarballs = arg('tarballs', '')
if (tarballs) tarballs = path.resolve(tarballs)
else {
  const packOut = path.join(work, 'pack')
  run(process.execPath, ['scripts/pack.mjs'], { env: { ...process.env, ATELIERMESH_PACK_OUT: packOut } })
  tarballs = path.join(packOut, 'tarballs')
}
if (!existsSync(tarballs) || readdirSync(tarballs).filter(f => f.endsWith('.tgz')).length < 3) { console.error(`no tarballs in ${tarballs}: run npm run pack`); process.exit(1) }
for (const f of readdirSync(tarballs)) if (f.endsWith('.tgz')) cpSync(path.join(tarballs, f), path.join(dir, 'packages', f))
const coreTgz = readdirSync(path.join(dir, 'packages')).find(f => /^ateliermesh-core-.*\.tgz$/.test(f))

// 2. the tool: the packing command line, built fresh
run(process.execPath, ['scripts/build-cli.mjs'])
copy('packages/loader/bin/amplugin.mjs', 'tools/amplugin.mjs')
copy('packages/loader/py/amplugin_pack.py', 'tools/amplugin_pack.py')
copy('packages/loader/py/amplugin_check.py', 'tools/amplugin_check.py')

// 3. the type declarations (for a coding agent that cannot install the packages, and for reading)
for (const pkg of ['core', 'plugins']) {
  const tgz = path.join(dir, 'packages', readdirSync(path.join(dir, 'packages')).find(f => f.startsWith(`ateliermesh-${pkg}-`)))
  const tmp = path.join(work, `untar-${pkg}`)
  mkdirSync(tmp, { recursive: true })
  execFileSync('tar', ['-xzf', tgz, '-C', tmp])
  const src = path.join(tmp, 'package/dist')
  const walk = (d, rel = '') => { for (const f of readdirSync(path.join(d, rel))) { const r = path.join(rel, f); if (statSync(path.join(d, r)).isDirectory()) walk(d, r); else if (f.endsWith('.d.ts')) { mkdirSync(path.dirname(path.join(dir, 'types', pkg, r)), { recursive: true }); cpSync(path.join(d, r), path.join(dir, 'types', pkg, r)) } } }
  walk(src)
}
write('types/README.md', `# Type declarations

\`core/\` is the \`.d.ts\` of \`@ateliermesh/core\` and \`plugins/\` of \`@ateliermesh/plugins\`, exactly as they are inside the packages in \`../packages/\`. They are here for reading, and for a coding agent that cannot install the packages.
Start with \`core/index.d.ts\`: the manifest types (\`Manifest\`, \`Operation\`, \`ParamDef\`), \`Mesh\`, \`PluginModule\` and \`RunContext\`, \`MeshError\` and \`ERROR_CODES\`, the validators (\`validateManifest\`, \`validateParams\`, \`validateStepList\`),
the file readers and writers (\`parseStl\`, \`writeStlBinary\`, \`read3mf\`, \`write3mf\`) and the step list types (\`StepList\`, \`Step\`).
Colour on parts: \`MeshGroup.color\` and \`SegmentInfo.color\` (\`#rrggbb\`), and the helpers \`setGroupColor\`, \`setSegmentColor\`, \`colorSegments\` and \`assignSegment(mesh, name, flags, color?)\`.

With the packages installed (\`npm install ../packages/ateliermesh-core-${version}.tgz\`) you do not need this folder: TypeScript finds the same declarations in \`node_modules/@ateliermesh/core\`.
`)

// 4. the documents: the guide and its companions (links to the specification point into this kit), the plugin parts of SPEC.md
const keep = ['plugin-guide.md', '3mf-colour.md', '3mf-parts.md', 'prompt-make-a-plugin.md', 'plugin-authoring.md', 'plugin-tutorial.md', 'external-plugins.md', 'fonts.md', 'NO-NPM.md', 'CONTRACT-CHEATSHEET.md']
for (const f of keep) {
  const text = readFileSync(path.join(root, 'docs', f), 'utf8').replaceAll('](../SPEC.md', '](../spec/SPEC-plugins.md').replaceAll('(../SPEC.md', '(../spec/SPEC-plugins.md')
  write(`docs/${f}`, text)
}
write('docs/design-texts/README.md', `# Texts

A plugin's words (titles, hints, option names, every problem it can report) are written in English (UK spelling), Dutch and French, as nested JSON in \`locales/en.json\`, \`nl.json\` and \`fr.json\` of the plugin (see \`examples/plugins/mirror-full/locales\`).
The host owner merges them into the host's own texts. Keep a short list of every key you added, with the English wording, in a page like \`docs/design-texts-<your plugin>.md\` for the people who confirm wording.
The guide, section 9, lists the key names.
`)
const spec = readFileSync(path.join(root, 'SPEC.md'), 'utf8').split('\n')
const heads = []
spec.forEach((l, i) => { if (/^## /.test(l)) heads.push(i) })
const wanted = [/^## 1\. /, /^## 2\. /, /^## 3\. /, /^## 4\. /, /^## 5\. /, /^## 5A\. /, /^## 6\. /, /^## 8\. /, /^## 11\. /]
const parts = [spec.slice(0, heads[0]).join('\n')]
for (const w of wanted) {
  const k = heads.findIndex(i => w.test(spec[i]))
  if (k < 0) { console.error(`SPEC.md has no section ${w}`); process.exit(1) }
  parts.push(spec.slice(heads[k], heads[k + 1] ?? spec.length).join('\n'))
}
write('spec/SPEC-plugins.md', `> **Extract.** This file holds the sections of the AtelierMesh specification (\`SPEC.md\`) that a plugin author needs: 1 to 6 (concepts, workflow, package, manifest, mesh, built-in operations as models, runtime contract), 8 (security) and 11 (versioning and conformance). The text is copied unchanged; the sections left out (7 project file, 9 agent access, 10 host UI, 10A recipes, 12 open questions, 13 prior art) concern hosts. Made by \`scripts/make-plugin-kit.mjs\`.\n\n${parts.join('\n\n')}\n`)

// 5. the examples: the complete Mirror source, set up to work outside the repository, and the tiny one
copy('examples/plugins/mirror-full', 'examples/plugins/mirror-full')
copy('examples/plugins/mirror', 'examples/plugins/mirror')
copy('examples/plugins/mirror-plain', 'examples/plugins/mirror-plain')
copy('examples/plugins/shape-fit-plain', 'examples/plugins/shape-fit-plain')
copy('examples/plugins/nameplate-plain', 'examples/plugins/nameplate-plain')
rmSync(path.join(dir, 'examples/plugins/mirror-full/node_modules'), { recursive: true, force: true })
const pkgPath = path.join(dir, 'examples/plugins/mirror-full/package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
pkg.description = 'The complete example of docs/plugin-guide.md: a Mirror plugin with tests, fixtures and texts. It works from where it is (inside the plugin kit) and from anywhere else if you copy it together with the packages and tools folders (the paths below start at ../../../).'
pkg.scripts = {
  typecheck: 'tsc --noEmit',
  test: 'vitest run',
  pack: 'node ../../../tools/amplugin.mjs pack . --out dist/com.example.mirror-1.0.0.amplugin',
  inspect: 'node ../../../tools/amplugin.mjs inspect dist/com.example.mirror-1.0.0.amplugin',
}
pkg.devDependencies = { ...pkg.devDependencies, '@ateliermesh/core': `file:../../../packages/${coreTgz}` }
write('examples/plugins/mirror-full/package.json', JSON.stringify(pkg, null, 2) + '\n')
write('examples/plugins/mirror-full/README.md', `# Mirror (the complete example plugin)

The worked example of [\`docs/plugin-guide.md\`](../../../docs/plugin-guide.md): a \`mirror\` operation that mirrors a model in place or adds a mirrored copy, keeps segments and groups, reports problems with a code, stops when cancelled, and has tests, fixtures, texts (en, nl, fr) and a package script.

What is where:

| File | What it is |
|---|---|
| \`manifest.json\` | the plugin's id, its operation and every setting with limits, units and conditions |
| \`main.ts\` | the plugin module: one default export with a \`run\` function |
| \`src/mirror.ts\` | the algorithm (keeps segments and groups, stops when cancelled) |
| \`test/mirror.test.ts\`, \`test/personalise.test.ts\` | tests and conformance fixtures, run in the real engine |
| \`locales/en.json\`, \`nl.json\`, \`fr.json\` | the plugin's texts |
| \`package.json\`, \`tsconfig.json\` | the setup (depends on the packed core package in \`../../../packages/\`) |

Run it from this folder (Node 20 or newer; the first command needs the network once, for TypeScript, vitest and esbuild):

\`\`\`
npm install
npm run typecheck
npm test
npm run pack        # dist/com.example.mirror-1.0.0.amplugin, made by ../../../tools/amplugin.mjs
npm run inspect
\`\`\`

To start your own plugin, copy this folder, change the id in \`manifest.json\`, and keep the tests. The smaller example, \`../mirror\`, is the shortest possible plugin (no tests, no groups).
`)

// 6. the start page and the version file
const tree = []
const list = (d, rel = '', depth = 0) => {
  for (const f of readdirSync(path.join(d, rel)).sort()) {
    const r = path.join(rel, f), st = statSync(path.join(d, r))
    if (depth >= 2 && st.isDirectory()) { tree.push(`${'  '.repeat(depth)}${f}/ …`); continue }
    if (['node_modules', 'dist'].includes(f)) continue
    tree.push(`${'  '.repeat(depth)}${f}${st.isDirectory() ? '/' : ''}`)
    if (st.isDirectory()) list(d, r, depth + 1)
  }
}
list(dir)
copy('LICENSE-KIT', 'LICENSE-KIT-MIT.txt')
copy('LICENSING.md', 'LICENSING.md')
copy('LICENSE', 'LICENSE')
write('README-START-HERE.md', `# AtelierMesh plugin kit ${version}

Everything you need to write, test, pack and load an AtelierMesh plugin, **without the AtelierMesh repository**. A plugin turns a 3D mesh into another mesh (a "step" in a list); the host (the standalone app, or a web shop) draws its settings from a manifest and runs it. You write no user interface.

**Licence.** The kit (guide, templates, Mirror example, packing tool) is MIT (\`LICENSE-KIT-MIT.txt\`). The packages in \`packages/\` are AtelierMesh's, under the AGPL with an additional permission: you may bundle the plugin interface (\`MeshError\`, the types, the helpers the guide names) into your plugin and license your plugin as you like (\`LICENSING.md\`).

> **The npm package named \`amplugin\` is NOT ours.** Do not install it. Our packing tool ships in this kit as \`tools/amplugin.mjs\` and needs only Node 20 or newer. Nothing of AtelierMesh is published on npm: the packages are the \`.tgz\` files in \`packages/\`.

## Every plugin says what it is

The manifest MUST have \`license\` (an SPDX id such as MIT, Apache-2.0 or GPL-3.0-only, or Proprietary) and \`description\` (plain text, 10 to 300 characters): a package without them is refused. It MAY have \`contact\` (\`url\` https, \`email\`, \`name\`) and \`package_url\` (the https address where the packed file is published, so users can click “Check for update”). Never invent contact details. \`amplugin check\` and the Python checker tell you what is missing. It MAY also have \`image\` (\`{ "file": "assets/example.png", "alt": "..." }\`): an example picture for the plugin gallery in \`assets/\` (PNG, JPEG or WebP, at most 300 KB, 200 to 1600 px wide, at most 1200 px high, alt text of 5 to 160 characters).

## No npm? Read this first

No network, no package installs, or only Node, only Python 3, or only a shell and an editor: you can still build, test and pack a plugin. Write plain JavaScript (\`manifest.json\` + one \`main.js\` with no imports). Then:

- **Node 20+, no npm (tier A):** \`node tools/amplugin.mjs new my-plugin\`, \`check\`, \`run\`, \`pack\`. Complete tests, zero dependencies.
- **Python 3, no Node (tier B):** \`python3 tools/amplugin_check.py <folder>\` (static checks only: it cannot run the plugin) and \`python3 tools/amplugin_pack.py <folder>\` (the same package, unsigned).
- **Only a shell or an editor (tier C):** write the files, check them with the list in the docs, pack with \`sha256sum\` and \`zip\`.

Read \`docs/NO-NPM.md\` (all three tiers, exact commands) and \`docs/CONTRACT-CHEATSHEET.md\` (one page), and start from \`examples/plugins/mirror-plain/main.js\`. For a plugin that takes or returns a flat drawing, or needs a stored drawing next to its model, start from \`examples/plugins/shape-fit-plain/\` (\`amplugin run ... --input drawing:square:40,20\`, \`--payload setting=drawing:square\`). Agent prompt for this case: \`docs/prompt-make-a-plugin.md\`, "without npm".

## Read first

1. \`docs/plugin-guide.md\` — the whole path, with a worked example. Follow it.
2. \`docs/plugin-authoring.md\` — the exact interfaces and the presentation hints.
3. \`spec/SPEC-plugins.md\` — the format and the rules (manifest, mesh, parts, runtime contract, security).
4. \`examples/plugins/mirror-full\` — a complete plugin with tests, fixtures and texts. Copy its structure.
5. \`docs/3mf-colour.md\` — how colours on parts reach a 3MF file and a slicer.

**Colour.** Every part of a mesh, a segment (a coloured region) or a group (a body), can carry a colour (#rrggbb). The mesh itself has no textures, UV coordinates or per-vertex colours: colour lives on parts. A plugin may keep the colours it gets, give new parts a colour, or colour its output by a rule (height, face direction ...). Colours appear in the 3D view and in a 3MF export.

Using a coding agent? Give it \`docs/prompt-make-a-plugin.md\` (a full prompt and a 10-line quick prompt), and tell it to read this file first.

## The five-minute path

\`\`\`
cd examples/plugins/mirror-full
npm install                     # TypeScript, vitest, esbuild and the packed core package (needs the network once)
npm run typecheck
npm test                        # the plugin runs inside the real engine, with fixtures
npm run pack                    # dist/com.example.mirror-1.0.0.amplugin (about 6 KB)
npm run inspect                 # id, hash, signer, files
\`\`\`

Load the result in the standalone app: open a sample, **Add a step**, **Plugins…**, **Choose a plugin file**, approve the dialog. The operation appears in the **Add a step** menu under its category.

Your own plugin: copy \`examples/plugins/mirror-full\` somewhere inside this kit (keep the folder depth, or fix the \`../../../\` paths in its \`package.json\`), change the id in \`manifest.json\` (reverse-domain, lower case: \`com.yourname.thing\`), rename the operation, replace \`src/mirror.ts\`. Keep the tests.

## The packing tool

\`\`\`
node tools/amplugin.mjs pack <plugin folder> [--out file.amplugin] [--key private.key]
node tools/amplugin.mjs keygen <name>                    # <name>.key (secret) and <name>.pub (public)
node tools/amplugin.mjs sign <plugin folder> --key <name>.key
node tools/amplugin.mjs inspect <file.amplugin> [--trust <name>.pub]
node tools/amplugin.mjs verify <file.amplugin> --trust <name>.pub
node tools/amplugin.mjs new <name>                       # a plain JavaScript plugin folder (no npm, no build)
node tools/amplugin.mjs check <plugin folder>            # test it like the host would: manifest, rules, determinism, cancelling, fixtures.json
node tools/amplugin.mjs run <plugin folder> --input generator:box:10,20,30 --params '{}' --out result.stl
\`\`\`

A plugin written in plain JavaScript (\`main.js\`) packs with nothing installed. A plugin written in TypeScript (\`main.ts\`) needs esbuild in its own folder: \`npm install -D esbuild\` (the example already has it).

## What is in this kit

\`\`\`
${tree.join('\n')}
\`\`\`

- \`packages/\` — the packed packages (\`@ateliermesh/core\` for types, validators and file readers; \`plugins\`, \`ui\` and \`react\` are for hosts and are here for reading and for local tests of bigger plugins). Install one with \`npm install ./packages/ateliermesh-core-${version}.tgz\` (or a \`file:\` dependency).
- \`types/\` — the same type declarations, loose, for reading.
- \`tools/amplugin.mjs\` — the packing and test tool above. \`tools/amplugin_pack.py\` and \`tools/amplugin_check.py\` do packing and static checks with Python 3 only.

## Good to know

- Millimetres, Z up, triangles counter-clockwise seen from outside. A printable result must be a closed solid if the input was one.
- No materials, no prices, no network, no clock, no random numbers in a plugin. Same input, same output. The guide explains why and how.
- Texts go in English (UK spelling), Dutch and French, in the plugin's \`locales/\` folder. The host reads them from the package, but only keys inside your plugin's own namespace: \`ops.<operation id>.…\`, \`step.op.<operation id>\` and \`mesh.<operation id or last part of the plugin id>.…\`.
- Problems are \`new MeshError('yourprefix.something', { numbers })\`: a code and numbers, never only a sentence.
`)
write('VERSION.json', JSON.stringify({ kit: version, packages: readdirSync(path.join(dir, 'packages')).sort(), node: '>=20', made: new Date().toISOString().slice(0, 10) }, null, 2) + '\n')

// 7. the zip
mkdirSync(path.dirname(outZip), { recursive: true })
rmSync(outZip, { force: true })
execFileSync('zip', ['-qr', outZip, name], { cwd: work, stdio: 'inherit' })
if (process.argv.includes('--keep')) { rmSync(path.join(path.dirname(outZip), name), { recursive: true, force: true }); cpSync(dir, path.join(path.dirname(outZip), name), { recursive: true }) }
rmSync(work, { recursive: true, force: true })
console.log(`${path.relative(root, outZip)}  ${(statSync(outZip).size / 1024).toFixed(0)} KB`)
