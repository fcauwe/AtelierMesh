// Loading a package from a URL: https in production, http only in development mode, no credentials, a size cap counted while streaming,
// an optional #sha256= pin, and a single download (the app never fetches it again by itself).
import { MeshError, sha256Hex } from '@ateliermesh/core'
import { DEFAULT_PACKAGE_LIMITS } from './package'

export interface FetchOptions {
  /** Development mode: also accept http. Off by default. */
  allowHttp?: boolean
  maxBytes?: number
  fetch?: typeof fetch
  /** Give up after this many milliseconds (default 30000). */
  timeoutMs?: number
}

const bad = (reason: string, extra: Record<string, unknown> = {}): MeshError => new MeshError('loader.bad_url', { reason, ...extra })

/** Split a link into the URL to fetch and the pinned hash, if any. */
export function parsePluginUrl(input: string, allowHttp = false): { url: string; sha256?: string } {
  let u: URL
  try { u = new URL(input) } catch { throw bad('not_a_url') }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw bad('scheme_not_allowed', { scheme: u.protocol })
  if (u.username || u.password) throw bad('credentials_in_url')
  const m = /(?:^|&)sha256=([0-9a-fA-F]{64})(?:&|$)/.exec(u.hash.slice(1))
  if (u.hash && !m && u.hash.slice(1).startsWith('sha256=')) throw bad('bad_sha256_pin')
  u.hash = ''
  return { url: u.toString(), ...(m ? { sha256: (m[1] as string).toLowerCase() } : {}) }
}

export async function fetchPluginBytes(input: string, opts: FetchOptions = {}): Promise<{ bytes: Uint8Array; url: string; sha256: string }> {
  const { url, sha256: pin } = parsePluginUrl(input, opts.allowHttp)
  const max = opts.maxBytes ?? DEFAULT_PACKAGE_LIMITS.maxCompressedBytes
  // a server that does not allow this page to read its answer (CORS), or no network at all, makes fetch throw a TypeError without saying which: one clear code for both
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 30_000)
  let res: Response
  try { res = await (opts.fetch ?? fetch)(url, { credentials: 'omit', redirect: 'follow', referrerPolicy: 'no-referrer', cache: 'no-store', signal: ctl.signal }) }
  catch (e) { throw ctl.signal.aborted ? bad('timeout', { url }) : bad('network_or_cors', { url, message: e instanceof Error ? e.message : String(e) }) }
  if (!res.ok) throw bad('http_error', { status: res.status })
  // a redirect must not lead to another scheme than the one allowed
  if (res.url) { try { const f = new URL(res.url); if (f.protocol !== 'https:' && !(opts.allowHttp && f.protocol === 'http:')) throw bad('redirect_to_disallowed_scheme', { scheme: f.protocol }) } catch (e) { if (e instanceof MeshError) throw e } }
  const declared = Number(res.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > max) throw bad('too_large', { bytes: declared, max })
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = res.body?.getReader()
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > max) { void reader.cancel(); throw bad('too_large', { bytes: total, max }) }
      chunks.push(value)
    }
  } else {
    const b = new Uint8Array(await res.arrayBuffer())
    if (b.length > max) throw bad('too_large', { bytes: b.length, max })
    chunks.push(b); total = b.length
  }
  clearTimeout(timer)
  const bytes = new Uint8Array(total)
  let o = 0
  for (const c of chunks) { bytes.set(c, o); o += c.length }
  const sha = sha256Hex(bytes)
  if (pin && pin !== sha) throw bad('hash_pin_mismatch', { expected: pin, actual: sha })
  return { bytes, url, sha256: sha }
}
