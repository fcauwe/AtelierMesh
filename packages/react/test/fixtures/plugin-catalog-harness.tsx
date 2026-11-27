// Runs in the browser: mounts the plugin manager with a catalog the test controls (status, items, updates), and records what the manager calls.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PluginManager } from '../../src'
import type { CatalogItem, PluginCatalogHost, PluginRow } from '../../src'
import en from '../../../../apps/standalone/src/locales/en.json'

const flat = (d: unknown, p = ''): Record<string, string> => Object.entries(d as Record<string, unknown>).reduce((o, [k, v]) => (typeof v === 'object' && v !== null ? { ...o, ...flat(v, `${p}${k}.`) } : { ...o, [`${p}${k}`]: String(v) }), {})
const dict = flat(en)
const t = (key: string, values: Record<string, string | number> = {}): string => (dict[key] ?? key).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, n: string) => String(values[n] ?? `{{${n}}}`))

interface State { status: PluginCatalogHost['status']; items: CatalogItem[]; updates: Record<string, string>; busy: string | null; source?: string }
const w = window as unknown as { __calls: string[]; __state: State; __set: (s: Partial<State>) => void; __pm: { start(): void } }
w.__calls = []
const PIC = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#9ca3af"/></svg>')
const items: CatalogItem[] = [
  { id: 'com.example.mirror', name: 'Mirror', version: '1.2.0', downloads: 1240, replaces: ['org.old.mirror'], description: 'Mirrors a model along an axis so both halves match.', license: 'MIT', contact: { name: 'Example Ltd', url: 'https://example.org/mirror' }, image: { url: PIC, alt: 'A mirrored vase' } },
  { id: 'com.example.hollow', name: 'Hollow <b>out</b>', version: '0.4.0', description: '<img src=x onerror="window.__xss=1"> Hollows a solid with a wall of your choice.', license: 'Apache-2.0' },
  { id: 'com.example.twist', name: 'Twist', version: '2.0.0', downloads: 1, description: 'Twists a model around its upright axis by an angle.', license: 'MIT' },
  { id: 'core', name: 'Core', version: '1.0.0', description: 'The built-in resize and rotate steps, also listed in a catalog.', license: 'MIT' },
]
const rows: PluginRow[] = [
  { id: 'core', name: 'Core', version: '1.0.0', builtIn: true, usedBy: 0, description: 'Resize, rotate and orient a model for printing.', license: 'MIT' },
  { id: 'com.example.mirror', name: 'Mirror', version: '1.0.0', builtIn: false, usedBy: 0, signed: false, description: 'Mirrors a model along an axis so both halves match.', license: 'MIT', stored: { size: 5000, added: Date.UTC(2026, 10, 8) } },
  { id: 'com.example.twist', name: 'Twist', version: '2.0.0', builtIn: false, usedBy: 0, signed: false, description: 'Twists a model around its upright axis by an angle.', license: 'MIT', stored: { size: 5000, added: Date.UTC(2026, 10, 8) } },
]
w.__state = { status: 'ready', items, updates: { 'com.example.mirror': '1.2.0' }, busy: null, source: 'plugins.example.org' }

function App(): JSX.Element {
  const [s, setS] = useState<State>(w.__state)
  w.__set = patch => { w.__state = { ...w.__state, ...patch }; setS(w.__state) }
  const catalog: PluginCatalogHost = { status: s.status, items: s.items, updates: s.updates, busy: s.busy, ...(s.source ? { source: s.source } : {}),
    onInstall: id => w.__calls.push(`install:${id}`), onOpen: () => w.__calls.push('open'), onRetry: () => w.__calls.push('retry') }
  return <PluginManager t={t} plugins={rows} catalog={catalog} view="list" onLoadFile={() => undefined} onLoadUrl={() => undefined} onRemove={() => undefined} onClose={() => w.__calls.push('close')} />
}
w.__pm = { start: () => createRoot(document.getElementById('root') as HTMLElement).render(<App />) }
