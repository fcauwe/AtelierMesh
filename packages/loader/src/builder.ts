// Building a package (used by the amplugin command line tool and by tests).
import { writeZip } from '@ateliermesh/core'
import type { Manifest } from '@ateliermesh/core'
import { hashListing } from './package'
import { sign } from './signing'

export interface BuildInput {
  manifest: Manifest
  /** The plugin's code: an ES module whose default export is a PluginModule. Must not import anything. */
  main: string
  /** Extra files by path, for example `assets/engine.wasm`. */
  assets?: Record<string, Uint8Array>
  /** Base64 PKCS8 Ed25519 private key: also write manifest.sha256 and manifest.sig. Without it only the hash listing is written (set `hashes: false` to skip that too). */
  privateKey?: string
  hashes?: boolean
}

export async function buildPluginPackage(i: BuildInput): Promise<Uint8Array> {
  const enc = new TextEncoder()
  const files = new Map<string, Uint8Array>([['manifest.json', enc.encode(JSON.stringify(i.manifest, null, 2))], ['main.js', enc.encode(i.main)]])
  for (const [n, d] of Object.entries(i.assets ?? {})) files.set(n, d)
  const out = [...files].map(([name, data]) => ({ name, data }))
  if (i.privateKey || i.hashes !== false) {
    const listing = enc.encode(hashListing(files))
    out.push({ name: 'manifest.sha256', data: listing })
    if (i.privateKey) out.push({ name: 'manifest.sig', data: enc.encode(JSON.stringify({ alg: 'ed25519', signature: await sign(i.privateKey, listing) })) })
  }
  return writeZip(out)
}
