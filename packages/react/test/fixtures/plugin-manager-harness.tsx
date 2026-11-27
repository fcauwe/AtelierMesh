// Runs in the browser: mounts the plugin manager with rows that carry metadata (including text that looks like markup), and the approval dialog.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PluginManager } from '../../src'
import type { PluginApproval, PluginRow } from '../../src'
import en from '../../../../apps/standalone/src/locales/en.json'

const flat = (d: unknown, p = ''): Record<string, string> => Object.entries(d as Record<string, unknown>).reduce((o, [k, v]) => (typeof v === 'object' && v !== null ? { ...o, ...flat(v, `${p}${k}.`) } : { ...o, [`${p}${k}`]: String(v) }), {})
const dict = flat(en)
const t = (key: string, values: Record<string, string | number> = {}): string => (dict[key] ?? key).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, n: string) => String(values[n] ?? `{{${n}}}`))

const w = window as unknown as { __approval?: PluginApproval; __calls: string[]; __pm: { start(): void } }
w.__calls = []
const rows: PluginRow[] = [
  { id: 'core', name: 'Core', version: '1.0.0', builtIn: true, usedBy: 2, description: 'Resize, rotate and orient a model for printing.', license: 'MIT', contact: { name: 'micro-fabriek', url: 'https://micro-fabriek.be' } },
  { id: 'ext.one', name: 'One', version: '1.2.0', builtIn: false, usedBy: 0, signed: false, origin: 'https://plugins.example.org/one-1.2.0.amplugin', packageUrl: 'https://plugins.example.org/one-1.2.0.amplugin',
    description: '<img src=x onerror="window.__xss=1"> A plugin whose description looks like markup.', license: 'GPL-3.0-only', contact: { name: '<b>Bold Maker</b>', url: 'https://example.org/one', email: 'one@example.org' }, stored: { size: 12345, added: Date.UTC(2026, 10, 9) } },
  { id: 'ext.two', name: 'Two', version: '0.1.0', builtIn: false, usedBy: 0, signed: true, signer: 'Anna', description: 'No contact details at all, so no link appears.', license: 'Proprietary', stored: { size: 900, added: Date.UTC(2026, 10, 8) } },
  { id: 'ext.bad', name: 'Bad contact', version: '1.0.0', builtIn: false, usedBy: 0, signed: false, description: 'Its contact address is not https, so it is shown as nothing.', license: 'MIT', contact: { url: 'javascript:alert(1)', email: 'not an email' } },
  { id: 'ext.off', name: 'Failed one', version: '1.0.0', builtIn: false, usedBy: 0, notStarted: 'the stored file does not match its checksum (it was changed or damaged)', stored: { size: 4000, added: Date.UTC(2026, 10, 7) } },
]
function App(): JSX.Element {
  const [approval, setApproval] = useState<PluginApproval | null>(w.__approval ?? null)
  return <PluginManager t={t} plugins={rows} storage={{ available: true, count: 3, max: 20 }} approval={approval} onApprove={() => { w.__calls.push('approve'); setApproval(null) }} onCancelApproval={() => { w.__calls.push('cancel'); setApproval(null) }}
    onLoadFile={() => undefined} onLoadUrl={() => undefined} onRemove={id => w.__calls.push(`remove:${id}`)} onDownload={id => w.__calls.push(`download:${id}`)} onCheckUpdate={id => w.__calls.push(`update:${id}`)} onClose={() => w.__calls.push('close')} />
}
w.__pm = { start: () => createRoot(document.getElementById('root') as HTMLElement).render(<App />) }
