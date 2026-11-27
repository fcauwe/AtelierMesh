// Pictures drawn in this browser, kept in IndexedDB by the hash of what they show, so a second visit does not draw them again.
// Best effort: a private window or a full disk throws, and the caller goes on without a cache.
import type { ThumbnailCache } from '@ateliermesh/react'

const DB = 'ateliermesh-thumbs', STORE = 'png'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB is not available'))
  })
}

async function run<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode)
      const r = f(t.objectStore(STORE))
      t.oncomplete = () => resolve(r.result)
      t.onerror = () => reject(t.error ?? new Error('IndexedDB error'))
      t.onabort = () => reject(t.error ?? new Error('IndexedDB aborted'))
    })
  } finally { db.close() }
}

// The bytes are stored, not the Blob: WebKit is unreliable with Blobs in IndexedDB.
export const thumbCache: ThumbnailCache = {
  async get(key) { const v = await run('readonly', s => s.get(key)) as ArrayBuffer | undefined; return v instanceof ArrayBuffer ? new Blob([v], { type: 'image/png' }) : undefined },
  async set(key, png) { const bytes = await png.arrayBuffer(); await run('readwrite', s => s.put(bytes, key)) },
}
