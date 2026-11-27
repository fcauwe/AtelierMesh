import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Build the standalone app once for every test file (two files building into the same folder at the same time broke each other).
export default function setup(): void {
  execFileSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), '../build.mjs')], { stdio: 'ignore' })
}
