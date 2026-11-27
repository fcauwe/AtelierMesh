// A licence report for what the packages bring to an application: the runtime dependencies of core, plugins and ui, with every
// transitive one. Fails when a licence is not on the permissive list. Dev tools are not reported.
/* global process */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PERMISSIVE = /^(MIT|ISC|BSD-2-Clause|BSD-3-Clause|Apache-2\.0|0BSD|BSL-1\.0|BSL|Zlib|Unlicense|CC0-1\.0|Python-2\.0)$/i
const read = p => JSON.parse(readFileSync(p, 'utf8'))
const found = new Map()

function find(name, from) {
  for (let d = from; ; d = path.dirname(d)) {
    const p = path.join(d, 'node_modules', name, 'package.json')
    if (existsSync(p)) return p
    if (d === path.dirname(d)) return null
  }
}
function visit(name, from, via) {
  const p = find(name, from)
  if (!p) { found.set(name, { name, version: '?', license: 'NOT INSTALLED', via }); return }
  const pkg = read(p)
  if (found.has(name) && found.get(name).version === pkg.version) return
  const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? (pkg.licenses?.map(l => l.type).join(' OR ') ?? 'UNKNOWN')
  found.set(name, { name, version: pkg.version, license, via })
  for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, path.dirname(p), name)
}

for (const dir of ['core', 'plugins', 'ui']) {
  const pkgFile = path.join(root, 'packages', dir, 'package.json')
  const pkg = read(pkgFile)
  for (const dep of Object.keys(pkg.dependencies ?? {})) if (!dep.startsWith('@ateliermesh/')) visit(dep, path.dirname(pkgFile), `@ateliermesh/${dir}`)
}
const rows = [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
const ok = l => /^\(?[\w.\- ]+(\s+(OR|AND)\s+[\w.\- ]+)*\)?$/.test(l) && l.replace(/[()]/g, '').split(/\s+(?:OR|AND)\s+/).every(x => PERMISSIVE.test(x.trim()))
let bad = 0
process.stdout.write('Runtime dependencies brought in by the packages (three.js is a peer, supplied by the host: MIT)\n')
for (const r of rows) { const good = ok(r.license); if (!good) bad++; process.stdout.write(`${good ? 'ok  ' : 'FAIL'} ${r.name}@${r.version}  ${r.license}  (via ${r.via})\n`) }
process.stdout.write(`${rows.length} packages, ${bad} not on the permissive list\n`)
process.exit(bad === 0 ? 0 : 1)
