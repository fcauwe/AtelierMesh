// Designs the person shared as examples: what this browser keeps about them (the private key that lets only this browser remove one), and the calls to the catalogue.
// The key is shown to nobody and sent only to the catalogue it came from.

export interface SharedRecord {
  id: string
  key: string
  /** The catalogue's folder the design was sent to. */
  base: string
  name: string
  created: string
  state: 'pending' | 'accepted' | 'rejected' | 'removed'
  reason?: string
}

const KEY = 'am.shared'
const clean = (v: unknown, max: number): string => (typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : '')   // eslint-disable-line no-control-regex

export function readShared(): SharedRecord[] {
  let raw: unknown
  try { raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') } catch { return [] }
  if (!Array.isArray(raw)) return []
  const out: SharedRecord[] = []
  for (const r of raw.slice(0, 100) as Array<Record<string, unknown> | null>) {
    if (!r || typeof r !== 'object') continue
    const id = typeof r['id'] === 'string' && /^[a-z2-7]{8}$/.test(r['id']) ? r['id'] : '', key = typeof r['key'] === 'string' && /^[0-9a-f]{32}$/.test(r['key']) ? r['key'] : ''
    const base = clean(r['base'], 300), name = clean(r['name'], 80), state = r['state']
    if (!id || !key || !/^https?:\/\//.test(base) || !name || (state !== 'pending' && state !== 'accepted' && state !== 'rejected' && state !== 'removed')) continue
    const reason = clean(r['reason'], 200)
    out.push({ id, key, base, name, created: clean(r['created'], 40), state, ...(reason ? { reason } : {}) })
  }
  return out
}

export function saveShared(list: SharedRecord[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 100))) } catch { /* private window: lasts until the page closes */ }
}

export type SendResult = { ok: true; id: string; key: string } | { ok: false; error: 'rate' | 'too_large' | 'picture' | 'project' | 'name' | 'network' | 'other' }

/** Send a design in: it waits for an admin. The picture is the PNG the person chose; the project is the .amproj as it would be saved. */
export async function sendShare(base: string, fields: { name: string; line: string; author: string }, project: Uint8Array, picture: Uint8Array, f: typeof fetch = fetch): Promise<SendResult> {
  const form = new FormData()
  form.append('name', fields.name); form.append('line', fields.line); form.append('author', fields.author); form.append('consent', '1')
  form.append('project', new Blob([project as BlobPart]), 'design.amproj'); form.append('picture', new Blob([picture as BlobPart], { type: 'image/png' }), 'picture.png')
  let r: Response
  try { r = await f(`${base}submit.php`, { method: 'POST', body: form, credentials: 'omit', referrerPolicy: 'no-referrer' }) } catch { return { ok: false, error: 'network' } }
  let j: { id?: unknown; key?: unknown; error?: unknown } = {}
  try { j = JSON.parse(await r.text()) as typeof j } catch { /* not JSON */ }
  if (r.status === 201 && typeof j.id === 'string' && typeof j.key === 'string') return { ok: true, id: j.id, key: j.key }
  if (r.status === 429) return { ok: false, error: 'rate' }
  if (r.status === 413 || j.error === 'project_too_large') return { ok: false, error: 'too_large' }
  if (j.error === 'picture') return { ok: false, error: 'picture' }
  if (j.error === 'name') return { ok: false, error: 'name' }
  if (typeof j.error === 'string' && j.error.startsWith('project')) return { ok: false, error: 'project' }
  return { ok: false, error: 'other' }
}

/** The state of each design that is not over (pending, accepted): asked of the catalogue with its key. An unknown design (the catalogue forgot it) counts as removed. */
export async function refreshShared(list: SharedRecord[], f: typeof fetch = fetch): Promise<SharedRecord[]> {
  return Promise.all(list.map(async r => {
    if (r.state === 'removed' || r.state === 'rejected') return r
    try {
      const res = await f(`${r.base}gallery.php?status=${r.id}&key=${r.key}`, { credentials: 'omit', referrerPolicy: 'no-referrer' })
      if (res.status === 404) return { ...r, state: 'removed' as const }
      if (!res.ok) return r
      const j = JSON.parse(await res.text()) as { state?: unknown; reason?: unknown }
      if (j.state === 'pending' || j.state === 'accepted' || j.state === 'rejected' || j.state === 'removed') { const reason = clean(j.reason, 200); const { reason: _old, ...rest } = r; return { ...rest, state: j.state, ...(reason ? { reason } : {}) } }
      return r
    } catch { return r }
  }))
}

/** Take a design back: the catalogue deletes its files; the key proves it is the sender's. */
export async function withdrawShared(r: SharedRecord, f: typeof fetch = fetch): Promise<boolean> {
  try { const res = await f(`${r.base}gallery.php?remove=${r.id}`, { method: 'POST', body: new URLSearchParams({ key: r.key }), credentials: 'omit', referrerPolicy: 'no-referrer' }); return res.ok } catch { return false }
}

/** The address of the share page of a design that is listed. */
export const sharedLink = (r: SharedRecord): string => `${r.base}gallery.php?view=${r.id}`

export type PluginSendResult = { ok: true } | { ok: false; error: 'exists' | 'package' | 'rate' | 'network' | 'other'; errors?: string[] }

/** Send a plugin package to the catalogue: it waits for an admin, like a design. */
export async function sendPlugin(base: string, bytes: Uint8Array, f: typeof fetch = fetch): Promise<PluginSendResult> {
  const form = new FormData()
  form.append('package', new Blob([bytes as BlobPart]), 'plugin.amplugin')
  let r: Response
  try { r = await f(`${base}submit.php`, { method: 'POST', body: form, credentials: 'omit', referrerPolicy: 'no-referrer' }) } catch { return { ok: false, error: 'network' } }
  let j: { error?: unknown; errors?: unknown } = {}
  try { j = JSON.parse(await r.text()) as typeof j } catch { /* not JSON */ }
  if (r.status === 201) return { ok: true }
  if (r.status === 429) return { ok: false, error: 'rate' }
  const errors = Array.isArray(j.errors) ? (j.errors as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 5) : []
  if (j.error === 'exists') return { ok: false, error: 'exists', errors }
  if (j.error === 'package') return { ok: false, error: 'package', errors }
  return { ok: false, error: 'other' }
}
