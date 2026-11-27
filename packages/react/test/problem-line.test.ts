import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProblemLine } from '../src/StepListView'

const t = (key: string, values: Record<string, string | number> = {}): string => ({ 'mesh.step.unknown_plugin': 'This project needs the plugin {{plugin}}', 'plugins.replacedBy': '“{{name}}” in the catalog replaces it.', 'fix.openPluginManager': 'Open the plugin manager' } as Record<string, string>)[key]?.replace(/\{\{(\w+)\}\}/g, (_, n: string) => String(values[n] ?? '')) ?? key

describe('a step whose plugin is missing', () => {
  const html = (replacedBy?: (id: string) => { name: string } | null): string => renderToStaticMarkup(createElement(ProblemLine, { t, code: 'step.unknown_plugin', params: { plugin: 'org.old.cheese' }, onFix: undefined, ...(replacedBy ? { replacedBy } : {}) }))
  it('says which plugin of the catalog replaces it, when the catalog knows one', () => {
    expect(html(id => (id === 'org.old.cheese' ? { name: 'Cheese holes' } : null))).toContain('“Cheese holes” in the catalog replaces it.')
  })
  it('says nothing more when no plugin replaces it', () => {
    expect(html(() => null)).not.toContain('replaces it'); expect(html()).not.toContain('replaces it')
  })
})
