// Projects kept in the browser (IndexedDB): save, list, open, delete. The bytes are the same .amproj file that "Save project" downloads.
// Everything is best effort: a private window or a full disk throws, and the caller shows the message.
export interface StoredProject {
  id: string; name: string; updated: number; size: number
  /** A PNG of the result, kept next to the bytes for the lists. Older records have none. */
  preview?: Uint8Array
}

const DB = 'ateliermesh', STORE = 'projects', RECIPES = 'recipes', PLUGINS = 'plugins'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // version 2 added the store of recipes, version 3 the store of plugins; the projects and recipes are never touched
    const req = indexedDB.open(DB, 3)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(RECIPES)) db.createObjectStore(RECIPES, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(PLUGINS)) db.createObjectStore(PLUGINS, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB is not available'))
  })
}

async function tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>, store: string = STORE): Promise<T> {
  const db = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(store, mode)
      const r = f(t.objectStore(store))
      t.oncomplete = () => resolve(r.result)
      t.onerror = () => reject(t.error ?? new Error('IndexedDB error'))
      t.onabort = () => reject(t.error ?? new Error('IndexedDB aborted (storage full?)'))
    })
  } finally { db.close() }
}

/** Saves (or replaces) a project. Pass the id of an earlier save to overwrite it, and a preview picture (PNG bytes) for the lists. */
/**
 * A new id for a stored project. `crypto.randomUUID` only exists on secure pages (https or localhost), so a page opened over plain http from a phone on the
 * local network has none: then random bytes from `crypto.getRandomValues` (available everywhere) make the same shape of id.
 */
export function newProjectId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  const b = new Uint8Array(16)
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256)
  b[6] = (b[6]! & 0x0f) | 0x40; b[8] = (b[8]! & 0x3f) | 0x80   // version 4, variant 1
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export async function putProject(name: string, bytes: Uint8Array, id: string = newProjectId(), preview?: Uint8Array): Promise<StoredProject> {
  const rec = { id, name, updated: Date.now(), size: bytes.length, bytes, ...(preview ? { preview } : {}) }
  await tx('readwrite', s => s.put(rec))
  return { id, name, updated: rec.updated, size: rec.size, ...(preview ? { preview } : {}) }
}

export async function listProjects(): Promise<StoredProject[]> {
  const all = await tx('readonly', s => s.getAll()) as Array<StoredProject & { bytes?: Uint8Array }>
  return all.map(({ id, name, updated, size, preview }) => ({ id, name, updated, size, ...(preview instanceof Uint8Array ? { preview } : {}) })).sort((a, b) => b.updated - a.updated)
}

export async function getProject(id: string): Promise<Uint8Array | null> {
  const rec = await tx('readonly', s => s.get(id)) as { bytes?: Uint8Array } | undefined
  return rec?.bytes ?? null
}

export const deleteProject = (id: string): Promise<undefined> => tx('readwrite', s => s.delete(id)) as Promise<undefined>

// ---------------------------------------------------------------------------------------------------- recipes (a saved set of steps)
/** A recipe kept in the browser: the text of the `.amrecipe` file with the name and the step count copied out for the list. */
export interface StoredRecipe { id: string; name: string; steps: number; updated: number; text: string }

export async function putRecipe(rec: Omit<StoredRecipe, 'id' | 'updated'> & { id?: string }): Promise<StoredRecipe> {
  const full: StoredRecipe = { ...rec, id: rec.id ?? newProjectId(), updated: Date.now() }
  await tx('readwrite', s => s.put(full), RECIPES)
  return full
}
export async function listRecipes(): Promise<StoredRecipe[]> {
  const all = await tx('readonly', s => s.getAll(), RECIPES) as StoredRecipe[]
  return all.sort((a, b) => b.updated - a.updated)
}
export async function getRecipe(id: string): Promise<StoredRecipe | null> { return ((await tx('readonly', s => s.get(id), RECIPES)) as StoredRecipe | undefined) ?? null }
export const deleteRecipe = (id: string): Promise<undefined> => tx('readwrite', s => s.delete(id), RECIPES) as Promise<undefined>

// ---------------------------------------------------------------------------------------------------- plugins (packed .amplugin files kept in this browser)
/** A plugin kept in the browser: the packed file with what the list needs. The bytes are checked again every time they are loaded. */
export interface StoredPlugin {
  id: string; name: string; version: string
  /** SHA-256 of the bytes, checked when the plugin is loaded again. */
  sha256: string
  /** SHA-256 over the file hashes inside the package (its identity, `LoadedPackage.hash`), checked as well. */
  pkgHash: string
  size: number
  bytes: Uint8Array
  source: 'file' | 'url'
  url?: string
  signedBy?: string
  added: number
  enabled: boolean
}
/** At most this many plugins are kept, each at most this many bytes. */
export const MAX_STORED_PLUGINS = 20
export const MAX_STORED_PLUGIN_BYTES = 5 * 1024 * 1024

export const putPlugin = (rec: StoredPlugin): Promise<IDBValidKey> => tx('readwrite', s => s.put(rec), PLUGINS) as Promise<IDBValidKey>
export async function listPlugins(): Promise<StoredPlugin[]> {
  const all = await tx('readonly', s => s.getAll(), PLUGINS) as StoredPlugin[]
  return all.filter(r => r && typeof r.id === 'string').sort((a, b) => a.added - b.added)
}
export async function getPlugin(id: string): Promise<StoredPlugin | null> { return ((await tx('readonly', s => s.get(id), PLUGINS)) as StoredPlugin | undefined) ?? null }
export const deletePlugin = (id: string): Promise<undefined> => tx('readwrite', s => s.delete(id), PLUGINS) as Promise<undefined>
