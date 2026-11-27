/* global console */
// Bundles the `ateliermesh` command (apps/cli) into build/cli/ateliermesh.mjs: one Node file with the engine and the built-in plugins in it.
import { build } from 'esbuild'
import { chmodSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'build/cli/ateliermesh.mjs')
mkdirSync(path.dirname(out), { recursive: true })
await build({
  entryPoints: [path.join(root, 'apps/cli/src/main.ts')], bundle: true, format: 'esm', platform: 'node', target: 'node24', outfile: out, logLevel: 'warning',
  loader: { '.woff2': 'binary' }, banner: { js: '#!/usr/bin/env node\nimport { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url)' },
})
chmodSync(out, 0o755)
console.log('wrote build/cli/ateliermesh.mjs')
