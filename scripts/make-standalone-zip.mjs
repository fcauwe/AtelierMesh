/* global console, process */
// Builds the standalone app and packs it as one zip you can upload to a web server: build/standalone/ateliermesh-standalone-<version>.zip
// Usage: node scripts/make-standalone-zip.mjs [--no-build]
// The zip holds ONE folder with the contents to copy to the server (index.html, app.js, chunks, fonts, samples, docs, .htaccess), a DEPLOY.md with the steps,
// and SHA256SUMS. The site is static: no server code, no database, no other server is contacted by the page.
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const noBuild = process.argv.includes('--no-build')
const version = JSON.parse(readFileSync(path.join(root, 'apps/standalone/package.json'), 'utf8')).version
const dist = path.join(root, 'apps/standalone/dist')
if (!noBuild) execFileSync(process.execPath, [path.join(root, 'apps/standalone/build.mjs')], { stdio: 'inherit', cwd: root })
if (!existsSync(path.join(dist, 'index.html'))) throw new Error('apps/standalone/dist/index.html is missing: build first')

const out = path.join(root, 'build/standalone')
const name = `ateliermesh-standalone-${version}`
const site = path.join(out, name, 'site')
rmSync(path.join(out, name), { recursive: true, force: true }); rmSync(path.join(out, `${name}.zip`), { force: true })
mkdirSync(site, { recursive: true })
cpSync(dist, site, { recursive: true })

const files = (dir, base = dir) => readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))]))
const list = files(site).sort()

// 1. the page must not depend on another server
const problems = []
for (const f of list.filter(x => /\.(html|css|js|mjs)$/.test(x))) {
  const text = readFileSync(path.join(site, f), 'utf8')
  for (const m of text.matchAll(/https?:\/\/(?!localhost)[a-z0-9.-]+/gi)) {
    const host = m[0].replace(/^https?:\/\//i, '')
    // namespaces, specs and documentation links inside strings are not requests; fonts and scripts would be
    if (/fonts\.(googleapis|gstatic)\.com|cdn\.|unpkg|jsdelivr|cloudflare/i.test(host)) problems.push(`${f}: ${m[0]}`)
  }
}
if (problems.length > 0) throw new Error(`the built site asks another server for files:\n${problems.join('\n')}`)

// 1b. the optional catalog folder must be complete and carry nothing local (no password file, no uploaded packages) (the public copy of the repository has no catalogue folder, so then there is nothing to check)
if (list.some(f => f.startsWith('catalog/'))) {
  const need = ['catalog/catalog.php', 'catalog/upload.php', 'catalog/lib.php', 'catalog/index.php', 'catalog/gallery.php', 'catalog/gallery-lib.php', 'catalog/share-lib.php', 'catalog/submit.php', 'catalog/fonts/Manrope-ExtraBold.ttf', 'catalog/fonts/Manrope-Medium.ttf', 'catalog/fonts/LICENSE-Manrope.txt', 'catalog/config.sample.php', 'catalog/.htaccess', 'catalog/packages/.htaccess', 'catalog/README.md']
  const missing = need.filter(f => !list.includes(f))
  if (missing.length > 0) throw new Error(`the catalog folder is incomplete: ${missing.join(', ')}`)
  const stray = list.filter(f => /^catalog\/(config\.php$|packages\/.+\.amplugin$|packages\/\.state\/|data\/|test\/)/.test(f))
  if (stray.length > 0) throw new Error(`the catalog folder holds local files that must not be shipped: ${stray.join(', ')}`)
}

// 2. checksums and the deploy note
const sums = list.map(f => `${createHash('sha256').update(readFileSync(path.join(site, f))).digest('hex')}  site/${f}`).join('\n') + '\n'
writeFileSync(path.join(out, name, 'SHA256SUMS'), sums)
// the licence travels with the build: AGPL-3.0-or-later by default, other licences on request (LICENSING.md)
for (const f of ['LICENSE', 'LICENSING.md']) copyFileSync(path.join(root, f), path.join(out, name, f))
const bytes = list.reduce((n, f) => n + statSync(path.join(site, f)).size, 0)
writeFileSync(path.join(out, name, 'DEPLOY.md'), `# AtelierMesh standalone ${version}: put it on a web server

The folder \`site/\` is the whole app: a static site. The app itself needs no PHP, no database and no Node on the server, and the page asks no other server for anything
(fonts, scripts and pictures are inside it). ${list.length} files, ${(bytes / 1048576).toFixed(1)} MB.
The folder \`catalog/\` inside it is an OPTIONAL plugin catalog that needs PHP 8.0 or newer (see "Plugin catalog" below); without PHP the app works the same and the
plugin manager says "The catalog is not available here".

1. Unzip this file on your computer.
2. Upload the CONTENTS of \`site/\` (not the folder itself) to the web root, or to a sub folder such as \`/mesh/\`, with FTP, SFTP or scp.
   Include the hidden file \`.htaccess\` (some FTP programs hide dotfiles: turn "show hidden files" on).
3. Open the address. The first time you should see the logo and a welcome popup.

## Apache
\`.htaccess\` sets the file types, compression, caching and two safety headers. If the server ignores .htaccess (AllowOverride None), copy its lines into the site's
Apache configuration instead. Every block is skipped when its module is missing (mod_mime, mod_deflate, mod_headers).

## Other servers
nginx: serve the folder as static files; make sure \`.js\` is \`text/javascript\`, \`.json\` is \`application/json\`, \`.svg\` is \`image/svg+xml\` and \`.woff2\` is \`font/woff2\`; cache \`chunk-*.js\` for a year and
\`index.html\`, \`app.js\`, \`app.css\`, \`worker.js\` with \`no-cache\`. Any static host (S3, GitHub Pages, Netlify) works the same way.

${existsSync(path.join(site, 'catalog')) ? `## Plugin catalog (optional, needs PHP 8.0+)
\`catalog/\` lets you keep plugin packages (.amplugin files) on your own server. The app's plugin manager then has a "Search in the catalog" field, and installed
plugins show "Update available" when you upload a newer version. It is a few small PHP files; it needs no database and no PHP extension beyond the standard ones.

1. In \`catalog/\`, copy \`config.sample.php\` to \`config.php\`.
2. Open \`https://your-site/…/catalog/upload.php\`. Until a password is set, the page offers a form that makes a password hash. Paste that hash into \`config.php\`
   as \`PASSWORD_HASH\` (or make one on the command line: \`php -r "echo password_hash('your password', PASSWORD_DEFAULT);"\`).
3. Make sure PHP can write to \`catalog/packages/\` (for example \`chmod 775\` and the web server's group; some hosts need \`777\`).
4. Reload \`upload.php\`, sign in, and upload a .amplugin file. The page checks it (ZIP, manifest, licence, description, picture, checksums) before keeping it.
5. Open \`catalog/catalog.php\`: it is the list the app reads (JSON). Open the app, Settings, Plugins: the catalog is searched under "Add a plugin".

Use https: the upload password otherwise travels unprotected. \`.htaccess\` files in \`catalog/\` and \`catalog/packages/\` keep \`config.php\` and \`lib.php\` from being read
and keep uploaded files from being run as code; check that they work on your server (open \`catalog/config.php\` in the browser: it must say forbidden).
If the server ignores .htaccess, add the same rules to its configuration. Back up \`catalog/packages/\` and \`config.php\`. Everything in \`packages/\` and \`catalog.php\` is public.
The folder name can be changed; the app finds it at \`catalog/catalog.php\` unless you set another address in Settings. More in \`catalog/README.md\`.
` : ''}

## Use HTTPS
The app works over plain http, but browsers give secure pages some features only: copying text with a button, for example. Use https for a real site.

## Updating
Upload the whole \`site/\` again and delete the old \`chunk-*.js\` files on the server (their names change with each build).

## Licence
AtelierMesh is dual licensed: GNU AGPL-3.0-or-later by default (\`LICENSE\`), other licences on request (\`LICENSING.md\`). Under the AGPL, people who use a changed version of this site over the network must be able to get its source code: keep a link to the source of the version you run, or ask for another licence.

The fonts have licences of their own. Every font in \`fonts/\` comes with its licence file (\`fonts/atelier/licences/<Name>-license.txt\`, and \`fonts/README.txt\` for Roboto). Keep those files with the fonts when you upload the site: the SIL Open Font License asks for the notice and licence text to travel with the font files.

## Check
\`sha256sum -c SHA256SUMS\` (in this folder) checks that nothing was damaged. Open the browser's developer tools, tab Network: every request goes to your own server.
`)

execFileSync('zip', ['-qr', `${name}.zip`, name], { cwd: out, stdio: 'inherit' })
console.log(`${path.relative(root, path.join(out, `${name}.zip`))}  ${(statSync(path.join(out, `${name}.zip`)).size / 1024).toFixed(0)} KB, ${list.length} files in site/`)
