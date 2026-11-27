/* global process, Buffer, console */
// Builds the standalone app into dist/: index.html, the stylesheets, fonts, brand files and the bundle (the viewer is a separate lazy chunk).
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { extractQuickPrompt, extractQuickPromptNoNpm, pageHtml, renderMarkdown } from './tools/docs.mjs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(here, 'dist')
// the sandbox bootstrap that the plugin loader embeds is generated from source
execFileSync(process.execPath, [path.join(here, '../../scripts/gen-bootstrap.mjs')], { stdio: 'inherit' })
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })
// the help for plugin makers: the quick prompt comes out of docs/prompt-make-a-plugin.md (so the app never carries a second copy), the guide and the prompt become pages
const repo = path.join(here, '../..')
const promptMd = readFileSync(path.join(repo, 'docs/prompt-make-a-plugin.md'), 'utf8')
const quickPrompt = extractQuickPrompt(promptMd) ?? ''
const quickPromptNoNpm = extractQuickPromptNoNpm(promptMd) ?? ''
if (!quickPrompt) process.stdout.write('warning: no quick prompt found in docs/prompt-make-a-plugin.md\n')
let exampleUrl = ''
mkdirSync(path.join(dist, 'docs'), { recursive: true })
try {
  execFileSync(process.execPath, [path.join(repo, 'packages/loader/bin/amplugin.mjs'), 'pack', path.join(repo, 'examples/plugins/mirror-full'), '--out', path.join(dist, 'docs/mirror-example.amplugin')], { stdio: ['ignore', 'ignore', 'inherit'] })
  exampleUrl = 'docs/mirror-example.amplugin'
} catch { process.stdout.write('warning: the example plugin could not be packed; the download button will not work\n') }
// the plugin developer kit: everything a person outside the repository needs (guide, spec extract, the Mirror source, packages, types, the packing tool).
// It uses build/tarballs when they exist (run `npm run pack` before a release build so the kit carries current packages); without them it packs into a temporary folder.
let kitUrl = ''
if (!process.env['NO_KIT']) {
  try {
    const have = existsSync(path.join(repo, 'build/tarballs'))
    execFileSync(process.execPath, [path.join(repo, 'scripts/make-plugin-kit.mjs'), '--out', path.join(dist, 'docs/ateliermesh-plugin-kit.zip'), ...(have ? ['--tarballs', path.join(repo, 'build/tarballs')] : [])], { stdio: ['ignore', 'ignore', 'inherit'] })
    kitUrl = 'docs/ateliermesh-plugin-kit.zip'
  } catch { process.stdout.write('warning: the plugin kit could not be made; its download button is hidden\n') }
}
function gitBuild() { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { return '' } }
const result = await build({
  entryPoints: { app: path.join(here, 'src/main.tsx') },
  bundle: true, splitting: true, format: 'esm', outdir: dist, minify: true, jsx: 'automatic', loader: { '.json': 'json' }, sourcemap: false, target: 'es2022', metafile: true, logLevel: 'warning',
  entryNames: '[name]', chunkNames: 'chunk-[name]-[hash]',
  define: { __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8')).version), __APP_BUILD__: JSON.stringify(gitBuild()), __PLUGIN_PROMPT__: JSON.stringify(quickPrompt), __PLUGIN_PROMPT_NO_NPM__: JSON.stringify(quickPromptNoNpm), __PLUGIN_GUIDE_URL__: JSON.stringify('docs/plugin-guide.html'), __PLUGIN_EXAMPLE_URL__: JSON.stringify(exampleUrl), __PLUGIN_KIT_URL__: JSON.stringify(kitUrl) },
})
await build({ entryPoints: { worker: path.join(here, 'src/worker.ts') }, bundle: true, format: 'iife', outdir: dist, minify: true, target: 'es2022', logLevel: 'warning' })
writeFileSync(path.join(dist, 'index.html'), readFileSync(path.join(here, 'index.html'), 'utf8'))
cpSync(path.join(here, 'public'), dist, { recursive: true })
// The plugin catalogue (PHP, for Apache): its folder goes into the site as catalog/. Nothing local goes along: no config.php, no uploaded packages, no tests.
// The folder is not in the public copy of the repository; a build without it makes a static site with no catalog/.
if (existsSync(path.join(here, 'server/catalog'))) {
  cpSync(path.join(here, 'server/catalog'), path.join(dist, 'catalog'), {
    recursive: true,
    filter: src => { const rel = path.relative(path.join(here, 'server/catalog'), src).split(path.sep); return !(rel[0] === 'config.php' || rel[0] === 'data' || (rel[0] === 'packages' && rel.length > 1 && !['.htaccess', 'README.txt'].includes(rel[1]))) },
  })
}
// the React package's stylesheets: the design tokens and dark theme, the overlay and the editor
for (const f of ['theme.css', 'overlay.css', 'editor.css']) cpSync(path.join(here, '../../packages/react/src', f), path.join(dist, f))
cpSync(path.join(here, 'src/app.css'), path.join(dist, 'app.css'))
// the picture book of how plugins work: one self-contained page next to the app, so the project's links to it do not depend on another site
// (the source page asks Google Fonts for its typefaces; the copy in the app does not: it has system fonts to fall back on, and the app asks no other server for files)
if (existsSync(path.join(repo, 'docs/plugin-framework-explained.html'))) {
  const html = readFileSync(path.join(repo, 'docs/plugin-framework-explained.html'), 'utf8').replace(/<link[^>]*fonts\.(?:googleapis|gstatic)\.com[^>]*>\s*/gi, '')
  writeFileSync(path.join(dist, 'how-plugins-work.html'), html)
}
// the guide pages (English only) and the example plugin
const pages = { 'plugin-guide.md': 'plugin-guide.html', 'prompt-make-a-plugin.md': 'prompt-make-a-plugin.html' }
for (const [file, title] of [['plugin-guide.md', 'Build a plugin'], ['prompt-make-a-plugin.md', 'Prompt for your coding agent']]) {
  const { html, toc } = renderMarkdown(readFileSync(path.join(repo, 'docs', file), 'utf8'), pages)
  writeFileSync(path.join(dist, 'docs', pages[file]), pageHtml({ title, body: html, toc, backHref: '../', note: 'This guide is in English. The app itself is also in Dutch and French.', ...(kitUrl ? { actions: [{ label: 'Download the plugin kit (zip)', href: 'ateliermesh-plugin-kit.zip', download: true }] } : {}) }))
}
// The Atelier's fonts, from the copy in assets/atelier (set ATELIER_FONTS to build from another folder): static WOFF2 files are copied, variable ones are unpacked to TrueType
// (fontkit cannot read a variable WOFF2 directly). Without the folder only Roboto is offered.
const atelierFonts = process.env['ATELIER_FONTS'] ?? path.join(here, '../../assets/atelier/frontend')
const cfg = path.join(atelierFonts, 'src/config/fonts.ts')
const list = []
if (existsSync(cfg)) {
  const wawoff = (await import('wawoff2')).default
  mkdirSync(path.join(dist, 'fonts/atelier'), { recursive: true })
  // the licence of every font travels with it (the OFL asks for it): each `<Name>-license.txt` says which font files it covers on its "Font file(s) in this folder:" line
  const fontDir = path.join(atelierFonts, 'public/fonts')
  const licences = new Map()   // font file name -> licence file name
  if (existsSync(fontDir)) {
    mkdirSync(path.join(dist, 'fonts/atelier/licences'), { recursive: true })
    for (const f of readdirSync(fontDir)) {
      if (!/-license\.txt$/.test(f) && f !== 'README.md') continue
      copyFileSync(path.join(fontDir, f), path.join(dist, 'fonts/atelier/licences', f))
      const covers = /Font file\(s\) in this folder:\s*(.+)/.exec(readFileSync(path.join(fontDir, f), 'utf8'))?.[1] ?? ''
      for (const name of covers.split(',').map(x => x.trim()).filter(Boolean)) licences.set(name, f)
    }
  }
  for (const m of readFileSync(cfg, 'utf8').matchAll(/family:\s*'([^']+)',\s*url:\s*'([^']+)'(?:,\s*weightRange:\s*'([^']+)')?(,\s*hidden:\s*true)?/g)) {
    const [, family, url, weightRange, hidden] = m
    const src = path.join(atelierFonts, 'public', url)
    if (!existsSync(src)) continue
    const variable = Boolean(weightRange)
    const name = path.basename(url).replace(/\.woff2$/, variable ? '.ttf' : '.woff2')
    const bytes = readFileSync(src)
    writeFileSync(path.join(dist, 'fonts/atelier', name), variable ? Buffer.from(await wawoff.decompress(bytes)) : bytes)
    const licence = licences.get(path.basename(url))
    if (!licence) console.warn(`no licence file found for ${family} (${path.basename(url)}): a font without its licence file must not ship`)
    list.push({ family, file: `fonts/atelier/${name}`, ...(weightRange ? { weightRange } : {}), ...(hidden ? { hidden: true } : {}), ...(licence ? { licence: `fonts/atelier/licences/${licence}` } : {}) })
  }
}
writeFileSync(path.join(dist, 'fonts/fonts.json'), JSON.stringify([{ family: 'Roboto', file: 'fonts/roboto-regular.woff2' }, ...list.filter(f => f.family !== 'Roboto')]))
const sizes = Object.entries(result.metafile.outputs).filter(([f]) => f.endsWith('.js')).map(([f, o]) => `${path.basename(f)} ${(o.bytes / 1024).toFixed(0)} KB`)
process.stdout.write(`built ${dist}\n  ${sizes.join('\n  ')}\n`)
