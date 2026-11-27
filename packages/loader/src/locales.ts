// The texts of a package: `locales/<lang>.json`. Read with strict limits, flattened to dotted keys, and cut down to the plugin's own namespace so a
// package can never change the words of the app or of another plugin. The texts are plain strings with {{placeholders}}; they are never markup.
import type { Manifest } from '@ateliermesh/core'
import { MeshError } from '@ateliermesh/core'

export const LOCALE_LIMITS = { maxFiles: 8, maxFileBytes: 64 * 1024, maxDepth: 6, maxLeaves: 2000, maxTextLength: 1000 }

/** What a package says, by language, as flat `a.b.c` keys; `ignored` lists what was left out (`<file or lang:key>`) and why. */
export interface PackageLocales {
  texts: Record<string, Record<string, string>>
  ignored: Array<{ item: string; reason: 'not_a_language_file' | 'outside_namespace' | 'bad_key' }>
}

const LANG_FILE_RE = /^locales\/([a-z]{2,3}(?:-(?:[A-Za-z]{2}|[0-9]{3}))?)\.json$/
const KEY_RE = /^[A-Za-z0-9_-]{1,60}$/
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype'])
const dec = new TextDecoder('utf-8', { fatal: true })

const bad = (reason: string, extra: Record<string, unknown> = {}): MeshError => new MeshError('loader.invalid_package', { reason, ...extra })

/** The prefixes a plugin may use for `mesh.<code>`: its operation ids and the last part of its id. */
export function problemPrefixes(m: Manifest): string[] { return [...new Set([...m.operations.map(o => o.id), m.id.split('.').slice(-1)[0] as string])] }

/** Is this flat key inside the plugin's own namespace: `ops.<its op>.…`, `step.op.<its op>`, or `mesh.<prefix>.…` for its own prefixes? */
export function inOwnNamespace(m: Manifest, key: string): boolean {
  const parts = key.split('.')
  const [a, b] = parts
  if (parts.length < 3) return false
  // the step's name in the list and the menu: `step.op.<its op>` and nothing below it
  if (a === 'step') return b === 'op' && parts.length === 3 && m.operations.some(o => o.id === parts[2])
  if (a === 'ops') return m.operations.some(o => o.id === b)
  if (a === 'mesh') return problemPrefixes(m).includes(b)
  return false
}

/**
 * Where a text that is outside the plugin's namespace probably belongs, or null when there is no good guess. Used by `amplugin check`, so the author is told what to
 * write instead of only what is wrong. Progress texts: `ops.<operation id>.stage.<stage>` (shown while the step runs). Error and warning texts: `mesh.<prefix>.<code>`.
 */
export function suggestKey(m: Manifest, key: string): string | null {
  const parts = key.split('.')
  const last = parts[parts.length - 1] as string
  const op = m.operations.length === 1 ? (m.operations[0] as { id: string }).id : '<operation id>'
  if (['work', 'stage', 'stages', 'progress'].includes(parts[0] as string) || parts.includes('stage') || parts.includes('stages') || parts.includes('progress')) return `ops.${op}.stage.${last}`
  const prefixes = problemPrefixes(m)
  if (parts[0] === 'mesh' && parts.length >= 3) return `mesh.${prefixes[prefixes.length - 1] as string}.${parts.slice(2).join('.')}`
  if (prefixes.includes(parts[0] as string) && parts.length >= 2) return `mesh.${parts[0]}.${parts.slice(1).join('.')}`
  if (['error', 'errors', 'warning', 'warnings', 'problem', 'problems'].includes(parts[0] as string) && parts.length >= 2) return `mesh.${prefixes[prefixes.length - 1] as string}.${parts.slice(1).join('.')}`
  return null
}

export function readPackageLocales(files: Map<string, Uint8Array>, manifest: Manifest): PackageLocales {
  const out: PackageLocales = { texts: {}, ignored: [] }
  const langFiles: Array<[string, string, Uint8Array]> = []
  for (const [path, data] of files) {
    if (!path.startsWith('locales/')) continue
    const m = LANG_FILE_RE.exec(path)
    if (!m) { out.ignored.push({ item: path, reason: 'not_a_language_file' }); continue }
    langFiles.push([m[1] as string, path, data])
  }
  if (langFiles.length > LOCALE_LIMITS.maxFiles) throw bad('locale_too_many_files', { count: langFiles.length, max: LOCALE_LIMITS.maxFiles })
  let leaves = 0
  for (const [lang, path, data] of langFiles.sort(([, a], [, b]) => (a < b ? -1 : 1))) {
    if (data.length > LOCALE_LIMITS.maxFileBytes) throw bad('locale_too_large', { path, bytes: data.length, max: LOCALE_LIMITS.maxFileBytes })
    let json: unknown
    try { json = JSON.parse(dec.decode(data)) } catch { throw bad('locale_not_json', { path }) }
    if (typeof json !== 'object' || json === null || Array.isArray(json)) throw bad('locale_not_an_object', { path })
    const flat: Record<string, string> = Object.create(null) as Record<string, string>
    const walk = (node: Record<string, unknown>, prefix: string[], depth: number): void => {
      for (const [k, v] of Object.entries(node)) {
        const keyPath = [...prefix, k]
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
          if (depth + 1 > LOCALE_LIMITS.maxDepth) throw bad('locale_too_deep', { path, max: LOCALE_LIMITS.maxDepth })
          walk(v as Record<string, unknown>, keyPath, depth + 1)
        } else if (typeof v === 'string') {
          if (++leaves > LOCALE_LIMITS.maxLeaves) throw bad('locale_too_many_texts', { path, max: LOCALE_LIMITS.maxLeaves })
          if (v.length > LOCALE_LIMITS.maxTextLength) throw bad('locale_text_too_long', { path, key: keyPath.join('.'), max: LOCALE_LIMITS.maxTextLength })
          const flatKey = keyPath.join('.')
          if (keyPath.some(s => !KEY_RE.test(s) || FORBIDDEN.has(s))) out.ignored.push({ item: `${lang}:${flatKey}`, reason: 'bad_key' })
          else if (!inOwnNamespace(manifest, flatKey)) out.ignored.push({ item: `${lang}:${flatKey}`, reason: 'outside_namespace' })
          else flat[flatKey] = v
        } else throw bad('locale_not_text', { path, key: keyPath.join('.') })
      }
    }
    walk(json as Record<string, unknown>, [], 1)
    if (Object.keys(flat).length > 0) out.texts[lang] = flat
  }
  return out
}
