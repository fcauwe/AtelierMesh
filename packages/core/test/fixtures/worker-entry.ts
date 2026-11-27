import { parentPort } from 'node:worker_threads'
import { Registry, installWorkerEntry, scopeFromNodePort } from '../../src'
import { createShapesPlugin, createTestPlugin } from '../../src/testing'

installWorkerEntry(new Registry().register(createTestPlugin().entry).register(createShapesPlugin().entry), scopeFromNodePort(parentPort!))
