import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Mesh } from '@ateliermesh/core'
import { PartsList } from '../src/PartsList'

const t = (_k: string, v?: Record<string, string | number>): string => (v ? JSON.stringify(v) : _k)
const mesh = (): Mesh => ({
  positions: new Float64Array(12), indices: Uint32Array.from([0, 1, 2, 0, 1, 3]),
  groups: [{ start: 0, count: 1, role: 'solid', name: 'Lid', color: '#e5484d' }, { start: 1, count: 1, role: 'solid', name: 'Base' }],
})

describe('the Parts list shows the colour of a body', () => {
  it('a body with a colour has a swatch of that colour; a body without one keeps the plain body swatch', () => {
    const html = renderToStaticMarkup(createElement(PartsList, { t, mesh: mesh(), viewer: null }))
    expect(html).toMatch(/<span class="am-swatch-dot" style="background:#e5484d"/)
    expect(html).toMatch(/<span class="am-swatch-dot am-body-dot"/)
  })
})
