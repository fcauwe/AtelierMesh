// The sandbox: an external plugin runs in a worker inside a sandboxed iframe with a strict Content-Security-Policy.
//  - the iframe has `sandbox="allow-scripts"` only: no same-origin, so no access to the app's storage, cookies or DOM;
//  - the policy allows no network (`connect-src 'none'`), scripts only from blob: and the page's own nonce, and WebAssembly;
//  - the plugin's worker is created from a blob, inherits that policy, and receives one end of a MessageChannel: the app talks to the
//    worker directly over the engine's normal worker protocol, no relay in between.
import { MeshError } from '@ateliermesh/core'
import type { AssetResolver, PluginEntry, WorkerLike } from '@ateliermesh/core'
import { BOOTSTRAP_SOURCE } from './bootstrap.generated'
import type { LoadedPackage } from './package'

/** The script inside the iframe: waits for the app's init message, starts the worker and hands it the channel. */
const PAGE_SCRIPT = `
addEventListener('message', function (e) {
  if (e.source !== parent) return
  var d = e.data
  if (!d || d.type !== 'am-init') return
  try {
    var url = URL.createObjectURL(new Blob([d.bootstrap], { type: 'text/javascript' }))
    var w = new Worker(url)
    w.onmessage = function (m) { parent.postMessage(m.data, '*') }
    w.onerror = function (ev) { parent.postMessage({ type: 'am-error', message: ev.message || 'the worker failed to start' }, '*') }
    w.postMessage({ manifest: d.manifest, main: d.main, port: d.port }, [d.port])
  } catch (err) { parent.postMessage({ type: 'am-error', message: String(err && err.message || err) }, '*') }
})
`

const randomNonce = (): string => { const b = new Uint8Array(16); crypto.getRandomValues(b); return Array.from(b, x => x.toString(16).padStart(2, '0')).join('') }

/** The permissions of a package that widen the network policy: `network:https://example.org`. */
export function allowedOrigins(permissions: string[]): string[] {
  return permissions.filter(p => p.startsWith('network:')).map(p => p.slice('network:'.length)).filter(o => /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(o))
}

export function sandboxPage(nonce: string, permissions: string[]): string {
  const connect = allowedOrigins(permissions).join(' ') || "'none'"
  const csp = `default-src 'none'; script-src 'nonce-${nonce}' blob: 'wasm-unsafe-eval'; worker-src blob:; connect-src ${connect}`
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script nonce="${nonce}">${PAGE_SCRIPT}</script></body></html>`
}

export interface SandboxOptions {
  /** Where the hidden iframe goes. Default `document.body`. */
  parent?: HTMLElement
  /** Called when the plugin's code has been imported and the worker answers requests. */
  onReady?: () => void
}

/** One sandboxed worker for one run. `terminate()` removes the iframe, which ends the worker. */
export function createSandboxWorker(pkg: LoadedPackage, opts: SandboxOptions = {}): WorkerLike {
  const parent = opts.parent ?? document.body
  const iframe = document.createElement('iframe')
  iframe.setAttribute('sandbox', 'allow-scripts')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.tabIndex = -1
  iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden'
  iframe.srcdoc = sandboxPage(randomNonce(), pkg.permissions)
  const { port1, port2 } = new MessageChannel()
  const errorHandlers: Array<(e: unknown) => void> = []
  const fail = (message: string): void => { for (const cb of errorHandlers) cb(new Error(`sandbox error in ${pkg.manifest.id}: ${message}`)) }
  const onWindow = (e: MessageEvent): void => {
    if (e.source !== iframe.contentWindow) return
    const d = e.data as { type?: string; message?: string } | null
    if (d && d.type === 'am-error') fail(d.message ?? 'sandbox error')
    else if (d && d.type === 'am-ready') opts.onReady?.()
  }
  window.addEventListener('message', onWindow)
  iframe.addEventListener('load', () => {
    iframe.contentWindow?.postMessage({ type: 'am-init', bootstrap: BOOTSTRAP_SOURCE, manifest: pkg.manifest, main: pkg.main, port: port2 }, '*', [port2])
  })
  parent.appendChild(iframe)
  return {
    postMessage: (m, t) => port1.postMessage(m, t as Transferable[]),
    onMessage: cb => { port1.onmessage = e => cb(e.data) },
    onError: cb => { errorHandlers.push(cb) },
    terminate: () => { window.removeEventListener('message', onWindow); port1.close(); iframe.remove() },
  }
}

/**
 * Start a package once, to see that its code can be imported and has a `run` function, then remove the sandbox again. A host calls this before it
 * adds a package, so a plugin that crashes on load never reaches the list. `message` is the first line of what went wrong.
 */
export function probePackage(pkg: LoadedPackage, opts: SandboxOptions & { timeoutMs?: number } = {}): Promise<{ ok: true } | { ok: false; message: string }> {
  return new Promise(resolve => {
    let done = false
    let worker: WorkerLike | null = null
    const finish = (r: { ok: true } | { ok: false; message: string }): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { void worker?.terminate() } catch { /* already gone */ }
      resolve(r)
    }
    const timer = setTimeout(() => finish({ ok: false, message: 'the plugin did not start in time' }), opts.timeoutMs ?? 8000)
    worker = createSandboxWorker(pkg, { ...opts, onReady: () => finish({ ok: true }) })
    worker.onError(e => { const raw = e instanceof Error ? e.message : String(e); finish({ ok: false, message: (raw.replace(/^sandbox error in [^:]+: /, '').split('\n')[0] ?? raw).trim() }) })
  })
}

/** The registry entry for a loaded package. Its code never runs in the app's own thread: `load` refuses, the host must use the sandbox. */
export function packageEntry(pkg: LoadedPackage): PluginEntry {
  return {
    manifest: pkg.manifest, untrusted: true,
    source: { kind: 'package', hash: pkg.hash, signed: pkg.signed, ...(pkg.signer ? { signer: pkg.signer } : {}), ...(pkg.origin ? { origin: pkg.origin } : {}) },
    load: () => { throw new MeshError('plugin.needs_sandbox', { plugin: pkg.manifest.id }) },
  }
}

/** A worker factory for `WorkerHost`: external plugins get a sandbox, everything else the app's own worker. */
export function workerFactory(builtin: (pluginId: string) => WorkerLike, packages: ReadonlyMap<string, LoadedPackage>, opts: SandboxOptions = {}): (pluginId: string) => WorkerLike {
  return id => { const pkg = packages.get(id); return pkg ? createSandboxWorker(pkg, opts) : builtin(id) }
}

/** The id a plugin passes to `ctx.assets` to read a file of its own package: `pkg:<plugin id>/<path>`. */
export const packageAssetId = (pluginId: string, path: string): string => `pkg:${pluginId}/${path}`

/** Answers `pkg:` ids from the loaded packages and hands every other id to the app's own resolver. */
export function withPackageAssets(resolver: AssetResolver, packages: ReadonlyMap<string, LoadedPackage>): AssetResolver {
  return async id => {
    if (!id.startsWith('pkg:')) return resolver(id)
    const rest = id.slice(4), slash = rest.indexOf('/')
    const pkg = slash > 0 ? packages.get(rest.slice(0, slash)) : undefined
    const file = pkg?.files.get(rest.slice(slash + 1))
    if (!pkg || !file || /^(manifest\.|main\.js$)/.test(rest.slice(slash + 1))) throw new MeshError('plugin.failed', { reason: 'no_such_package_asset', asset: id })
    return file
  }
}
