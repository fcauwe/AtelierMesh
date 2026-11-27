import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { WorkingRow } from '../src/Working'

const texts: Record<string, string> = { 'work.step': 'Step {{n}} of {{total}}', 'work.weld': 'Joining the vertices…', 'work.other': 'Working…', 'work.stop': 'Stop', 'ops.blocks.stage.build_blocks': 'Building the blocks…' }
const t = (k: string, v?: Record<string, string | number>): string => (texts[k] ?? k).replace(/\{\{(\w+)\}\}/g, (_, n: string) => String(v?.[n] ?? ''))
const html = (stage: string, op?: string) => renderToString(createElement(WorkingRow, { t, progress: { stepId: 's1', stage, fraction: 0.4 }, index: 0, total: 1, onStop: () => undefined, ...(op ? { op } : {}) }))

describe('the progress row shows a plugin\'s own stage text', () => {
  it('uses ops.<op>.stage.<stage> when the plugin has one', () => { expect(html('build_blocks', 'blocks')).toContain('Building the blocks…') })
  it('falls back to the host\'s own text for a stage it knows, and to "Working…" for one nobody has text for', () => {
    expect(html('weld', 'blocks')).toContain('Joining the vertices…')
    expect(html('unknown_stage', 'blocks')).toContain('Working…')
    expect(html('build_blocks')).toContain('Working…')       // without the op the plugin text cannot be found
  })
})
