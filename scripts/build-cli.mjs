// Bundles the amplugin command line tool into packages/loader/bin/amplugin.mjs.
import { build } from 'esbuild'
import { chmodSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'packages/loader/bin/amplugin.mjs')
await build({
  entryPoints: [path.join(root, 'packages/loader/src/cli.ts')], bundle: true, format: 'esm', platform: 'node', target: 'node24', outfile: out, logLevel: 'warning',
  banner: { js: '#!/usr/bin/env node' }, external: ['esbuild'],
})
chmodSync(out, 0o755)
