// The .amplugin package: a ZIP with manifest.json, main.js, optional assets/, and optional manifest.sha256 and manifest.sig.
// Reading checks everything before anything runs: size limits, safe paths, manifest, file hashes, signature, name clashes.
import { MeshError, readZip, sha256Hex, validateManifest, compareSemver, imageBytesProblem, sniffImage } from '@ateliermesh/core'
import type { Manifest, Registry, ZipLimits } from '@ateliermesh/core'
import { readPackageLocales } from './locales'
import type { PackageLocales } from './locales'
import { verifyWithAny } from './signing'
import type { TrustedKey } from './signing'

export const DEFAULT_PACKAGE_LIMITS = { maxCompressedBytes: 20 * 1024 * 1024, maxExpandedBytes: 60 * 1024 * 1024, maxFiles: 500 }

export interface LoadedPackage {
  manifest: Manifest
  /** Every file in the package by path. */
  files: Map<string, Uint8Array>
  main: string
  /** SHA-256 over the list of file hashes: the identity of this exact package. */
  hash: string
  signed: boolean
  signer?: string
  permissions: string[]
  origin?: string
  /** SHA-256 of the package file itself, as a `#sha256=` pin for loading it again. */
  fileSha256: string
  /** The example picture of the plugin, checked: its bytes, type and alt text. Absent when the manifest has no `image`. */
  image?: { bytes: Uint8Array; mime: string; alt: string }
  /** The package's `locales/<lang>.json`, checked and cut down to the plugin's own namespace (SPEC.md section 4). */
  locales: PackageLocales
}

export interface ReadPackageOptions {
  trustedKeys?: TrustedKey[]
  /** To refuse names that clash with a plugin that is already registered. */
  registry?: Registry
  origin?: string
  limits?: Partial<typeof DEFAULT_PACKAGE_LIMITS>
}

const bad = (reason: string, extra: Record<string, unknown> = {}): MeshError => new MeshError('loader.invalid_package', { reason, ...extra })
const dec = new TextDecoder()
const SIDE_FILES = new Set(['manifest.sha256', 'manifest.sig'])

/** The listing that manifest.sha256 holds: one `<hash>  <path>` line per file (not the two side files), sorted by path. */
export function hashListing(files: Map<string, Uint8Array>): string {
  return [...files.entries()].filter(([n]) => !SIDE_FILES.has(n)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([n, d]) => `${sha256Hex(d)}  ${n}\n`).join('')
}

export async function readPluginPackage(bytes: Uint8Array, opts: ReadPackageOptions = {}): Promise<LoadedPackage> {
  const lim = { ...DEFAULT_PACKAGE_LIMITS, ...opts.limits }
  if (bytes.length > lim.maxCompressedBytes) throw bad('too_large', { bytes: bytes.length, max: lim.maxCompressedBytes })
  const zip: ZipLimits = { maxEntries: lim.maxFiles, maxEntryBytes: lim.maxExpandedBytes, maxTotalBytes: lim.maxExpandedBytes, maxRatio: 200 }
  let entries
  try { entries = await readZip(bytes, zip) } catch (e) { throw bad('bad_zip', { cause: e instanceof MeshError ? e.toJSON() : String(e) }) }
  const files = new Map(entries.map(e => [e.name, e.data]))

  const mf = files.get('manifest.json')
  if (!mf) throw bad('missing_manifest')
  let raw: unknown
  try { raw = JSON.parse(dec.decode(mf)) } catch { throw bad('manifest_not_json') }
  // a package must say what it is and under which licence it may be used: licence and description are required here (the rule for every external package)
  const v = validateManifest(raw, { requireMetadata: true })
  if (!v.ok || !v.value) throw bad('invalid_manifest', { issues: v.errors })
  const manifest = v.value
  let image: LoadedPackage['image']
  if (manifest.image) {
    const ib = files.get(manifest.image.file)
    if (!ib) throw bad('image_missing', { path: manifest.image.file })
    const pr = imageBytesProblem(ib)
    if (pr) throw bad(pr.code.slice('package.'.length), { path: manifest.image.file, ...pr.params })
    image = { bytes: ib, mime: (sniffImage(ib) as { mime: string }).mime, alt: manifest.image.alt }
  }
  const locales = readPackageLocales(files, manifest)
  const mainBytes = files.get('main.js')
  if (!mainBytes) throw bad('missing_main')

  // hashes: if a listing is present, it must describe the package exactly
  const listingBytes = files.get('manifest.sha256')
  const actual = hashListing(files)
  if (listingBytes) {
    const claimed = new Map<string, string>()
    for (const line of dec.decode(listingBytes).split('\n')) {
      if (!line.trim()) continue
      const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line)
      if (!m) throw bad('bad_hash_listing')
      claimed.set(m[2] as string, m[1] as string)
    }
    for (const [name, data] of files) {
      if (SIDE_FILES.has(name)) continue
      const want = claimed.get(name)
      if (want === undefined) throw bad('unlisted_file', { path: name })
      if (want !== sha256Hex(data)) throw bad('hash_mismatch', { path: name })
    }
    for (const name of claimed.keys()) if (!files.has(name)) throw bad('listed_file_missing', { path: name })
  }

  // signature: covers the listing, so it covers every file
  let signed = false, signer: string | undefined
  const sigBytes = files.get('manifest.sig')
  if (sigBytes) {
    if (!listingBytes) throw bad('signature_without_hashes')
    let sig: { alg?: string; signature?: string }
    try { sig = JSON.parse(dec.decode(sigBytes)) as typeof sig } catch { throw bad('bad_signature_file') }
    if (sig.alg !== 'ed25519' || typeof sig.signature !== 'string') throw bad('bad_signature_file')
    const who = await verifyWithAny(opts.trustedKeys ?? [], sig.signature, listingBytes)
    if (who === null) throw bad('signature_not_trusted')   // a signature that does not verify is worse than none: refuse
    signed = true; signer = who
  }

  // names
  const reg = opts.registry
  if (reg?.has(manifest.id)) {
    const have = reg.manifest(manifest.id) as Manifest
    if (reg.sourceOf(manifest.id)?.kind === 'builtin') throw bad('clashes_with_builtin', { id: manifest.id })
    if (compareSemver(manifest.version, have.version) <= 0) throw bad('already_loaded', { id: manifest.id, loaded: have.version, offered: manifest.version })
  }
  return { manifest, files, main: dec.decode(mainBytes), hash: sha256Hex(actual), fileSha256: sha256Hex(bytes), signed, ...(signer ? { signer } : {}), permissions: manifest.permissions ?? [], locales, ...(image ? { image } : {}), ...(opts.origin ? { origin: opts.origin } : {}) }
}
