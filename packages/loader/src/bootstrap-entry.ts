// Runs inside the sandbox worker. It receives the plugin's manifest, its main.js text and one end of a MessageChannel, imports the plugin
// from a blob URL, and then speaks the engine's normal worker protocol over the port: no relay, the host talks to the worker directly.
import { Registry, installWorkerEntry } from '@ateliermesh/core'
import type { Manifest, PluginModule } from '@ateliermesh/core'

interface Init { manifest: Manifest; main: string; port: MessagePort }

self.addEventListener('message', (e: MessageEvent<Init>) => {
  const { manifest, main, port } = e.data
  void (async () => {
    try {
      const url = URL.createObjectURL(new Blob([main], { type: 'text/javascript' }))
      const mod = (await import(/* @vite-ignore */ url)) as { default?: PluginModule; run?: PluginModule['run'] }
      URL.revokeObjectURL(url)
      const plugin: PluginModule | undefined = mod.default && typeof mod.default.run === 'function' ? mod.default : typeof mod.run === 'function' ? { run: mod.run } : undefined
      if (!plugin) throw new Error('the plugin has no default export with a run function')
      const registry = new Registry().register({ manifest, load: () => plugin })
      installWorkerEntry(registry, { postMessage: (m, t) => port.postMessage(m, t as Transferable[]), onMessage: cb => { port.onmessage = ev => cb(ev.data) } })
      ;(self as unknown as { postMessage(m: unknown): void }).postMessage({ type: 'am-ready' })
    } catch (err) {
      ;(self as unknown as { postMessage(m: unknown): void }).postMessage({ type: 'am-error', message: err instanceof Error ? err.message : String(err) })
    }
  })()
}, { once: true })
