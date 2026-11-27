// Text for the panel: labels, help and titles come from each plugin's `locales/<lang>.json` (flat keys), with host overrides on top.
// Lookup order for language "nl-BE": host nl-BE, plugin nl-BE, host nl, plugin nl, then the same for each fallback language (default en),
// then the text written in the manifest, then the bare name. A missing translation never shows an empty label.

export type Messages = Record<string, string>
export type LocaleSet = Record<string, Messages>

export const opTitleKey = (op: string): string => `ops.${op}.title`
export const sectionKey = (op: string, section: string): string => `ops.${op}.sections.${section}`
export const paramKey = (op: string, param: string, field: 'label' | 'help' | 'unit'): string => `ops.${op}.params.${param}.${field}`
export const optionKey = (op: string, param: string, value: string): string => `ops.${op}.params.${param}.options.${value}`

export interface TranslatorOptions {
  lang: string
  /** Languages tried after `lang`. Default `['en']`. */
  fallback?: string[]
  plugin?: LocaleSet
  /** Host overrides: win over the plugin's own text in the same language. */
  overrides?: LocaleSet
}

export type Translate = (key: string, fallbackText?: string) => string

export function createTranslator(opts: TranslatorOptions): Translate {
  const chain: string[] = []
  for (const l of [opts.lang, ...(opts.fallback ?? ['en'])]) {
    for (const c of [l, l.split('-')[0] as string]) if (!chain.includes(c)) chain.push(c)
  }
  return (key, fallbackText) => {
    for (const l of chain) {
      const o = opts.overrides?.[l]?.[key]
      if (typeof o === 'string' && o !== '') return o
      const p = opts.plugin?.[l]?.[key]
      if (typeof p === 'string' && p !== '') return p
    }
    return fallbackText ?? key.split('.').slice(-1)[0] as string
  }
}

/**
 * The texts that installed packages bring (their `locales/<lang>.json`, already read, checked and cut down to the plugin's own namespace by the loader),
 * kept per plugin so that unloading a plugin takes its texts away. A host builds its `t` from its own files first and asks this store second, and only
 * for keys its own English file does not have: a package can add texts, it can never change the app's. Two packages never share a namespace root
 * (`ops.<op>`, `step.op.<op>`, `mesh.<prefix>`): the first one installed keeps it, the other one's keys for that root are left out and listed by `ignoredFor`.
 */
export class PluginTexts {
  private readonly byPlugin = new Map<string, { lang: LocaleSet; ignored: string[] }>()
  private readonly roots = new Map<string, string>()
  private changes = 0
  /** Goes up on every change, for a `useMemo` that builds `t`. */
  get version(): number { return this.changes }

  /** The namespace root of a key: `ops.<op>`, `step.op.<op>` or `mesh.<code prefix>` (the part before the first dot of the code). */
  static rootOf(key: string): string { return key.split('.').slice(0, key.startsWith('step.op.') ? 3 : 2).join('.') }

  /** Add (or replace) the texts of one plugin. Returns the keys that were left out because another plugin owns their root. */
  set(pluginId: string, texts: LocaleSet): string[] {
    this.remove(pluginId)
    const kept: LocaleSet = {}
    const ignored: string[] = []
    for (const [lang, msgs] of Object.entries(texts)) {
      for (const [key, text] of Object.entries(msgs)) {
        const root = PluginTexts.rootOf(key)
        const owner = this.roots.get(root)
        if (owner !== undefined && owner !== pluginId) { ignored.push(`${lang}:${key}`); continue }
        this.roots.set(root, pluginId)
        ;(kept[lang] ??= Object.create(null) as Messages)[key] = text
      }
    }
    this.byPlugin.set(pluginId, { lang: kept, ignored })
    this.changes++
    return ignored
  }

  remove(pluginId: string): void {
    const had = this.byPlugin.delete(pluginId)
    for (const [root, owner] of [...this.roots]) if (owner === pluginId) this.roots.delete(root)
    if (had) this.changes++
  }

  ignoredFor(pluginId: string): string[] { return this.byPlugin.get(pluginId)?.ignored ?? [] }

  /** The text of `key` in exactly this language, from whichever plugin owns it. */
  get(lang: string, key: string): string | undefined {
    const owner = this.roots.get(PluginTexts.rootOf(key))
    const v = owner === undefined ? undefined : this.byPlugin.get(owner)?.lang[lang]?.[key]
    return typeof v === 'string' && v !== '' ? v : undefined
  }
}
