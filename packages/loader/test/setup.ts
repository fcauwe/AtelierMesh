import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// The sandbox bootstrap is built from source into a generated file; make sure it is current before the tests run.
export default function setup(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
  execFileSync(process.execPath, [path.join(root, 'scripts/gen-bootstrap.mjs')], { stdio: 'inherit' })
  execFileSync(process.execPath, [path.join(root, 'scripts/build-cli.mjs')], { stdio: 'inherit' })
}
