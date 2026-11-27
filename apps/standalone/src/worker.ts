// The worker entry: the plugin code runs here, off the page's thread. Built as its own file (worker.js) by build.mjs.
import { Registry, installWorkerEntry, scopeFromWebWorker } from '@ateliermesh/core'
import { registerBuiltInPlugins } from '@ateliermesh/plugins'

installWorkerEntry(registerBuiltInPlugins(new Registry()), scopeFromWebWorker(self as unknown as Parameters<typeof scopeFromWebWorker>[0]))
