// A tiny translator for the app: nested JSON files from design (the Atelier uses i18next with the same keys), {{name}} placeholders, English as fallback.
import en from './locales/en.json'
import nl from './locales/nl.json'
import fr from './locales/fr.json'
import type { PluginTexts } from '@ateliermesh/core'

export type Lang = 'en' | 'nl' | 'fr'
export const LANGS: Lang[] = ['nl', 'en', 'fr']
const dicts: Record<Lang, unknown> = { en, nl, fr }

function lookup(d: unknown, key: string): string | undefined {
  let cur: unknown = d
  for (const part of key.split('.')) { if (typeof cur !== 'object' || cur === null) return undefined; cur = (cur as Record<string, unknown>)[part] }
  return typeof cur === 'string' ? cur : undefined
}

/**
 * `extra` holds the texts of installed packages. It is asked only after the app's own file of the same language and never for a key the app's English
 * file has, so a package can add texts and never change the app's. Order: app (chosen language), package (chosen), app (English), package (English), the key.
 */
export function makeT(lang: Lang, extra?: PluginTexts): (key: string, values?: Record<string, string | number>) => string {
  return (key, values = {}) => {
    const own = lookup(dicts.en, key) !== undefined
    const text = lookup(dicts[lang], key) ?? (own ? undefined : extra?.get(lang, key)) ?? lookup(dicts.en, key) ?? (own ? undefined : extra?.get('en', key)) ?? key
    return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, n: string) => String(values[n] ?? `{{${n}}}`))
  }
}

/** Text for an engine code: `mesh.<code>`, then the group's `mesh.<group>._any`, then `mesh.unknown`. Returns the key it used. */
export function problemKey(t: (k: string) => string, key: string): string {
  if (t(key) !== key) return key
  const m = /^mesh\.([a-z]+)\./.exec(key)
  if (m && t(`mesh.${m[1]}._any`) !== `mesh.${m[1]}._any`) return `mesh.${m[1]}._any`
  return 'mesh.unknown'
}

export function initialLang(): Lang {
  try { const s = localStorage.getItem('am.lang'); if (s === 'en' || s === 'nl' || s === 'fr') return s } catch { /* private window */ }
  const n = (typeof navigator !== 'undefined' ? navigator.language : 'en').slice(0, 2)
  return n === 'nl' || n === 'fr' ? n : 'en'
}
export const rememberLang = (l: Lang): void => { try { localStorage.setItem('am.lang', l) } catch { /* ignore */ } }
