import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Field } from '../src/PersonaliseOverlay'

// A choice whose options have icons is a grid of cards with the icon, not a list without one (more than four choices).
const t = (k: string): string => k
const step = { id: 's', params: {} } as never
const render = (options: unknown[], extra: object = {}): string => renderToStaticMarkup(createElement(Field, {
  step, t, sizeLimit: undefined, onAsset: () => undefined, onChange: () => undefined, fonts: [], param: { name: 'mark', type: 'enum', default: 'a', options, ...extra } as never,
}))
const six = (icon?: string): unknown[] => ['a', 'b', 'c', 'd', 'e', 'f'].map(v => ({ value: v, label: v.toUpperCase(), ...(icon ? { icon } : {}) }))

describe('a choice with icons', () => {
  it('more than four with icons the host knows: cards with the icon', () => {
    const html = render(six('hole_round'))
    expect(html).toContain('am-cards')
    expect(html).not.toContain('<select')
    expect((html.match(/<svg/g) ?? []).length).toBe(7)   // six pictures and the tick of the chosen one
  })
  it('more than four without known icons: still a list', () => {
    expect(render(six()).includes('<select')).toBe(true)
    expect(render(six('no_such_icon')).includes('<select')).toBe(true)
  })
  it('up to four with icons: buttons, as before; the `widget` hint still wins', () => {
    expect(render(six('hole_round').slice(0, 3))).toContain('am-seg')
    expect(render(six('hole_round'), { widget: 'segmented' })).toContain('am-seg')
  })
})

describe('a choice with shapes of its own', () => {
  const shapes = (n: number, extra: object = {}): string => render(Array.from({ length: n }, (_, i) => ({ value: `v${i}`, label: `V${i}`, shape: 'M4 4h16v16H4z' })), extra)
  it('more than four: cards with the drawing at 48 px and round line ends and joins', () => {
    const html = shapes(6)
    expect(html).toContain('am-cards')
    expect(html).not.toContain('<select')
    expect((html.match(/width="48"/g) ?? []).length).toBe(6)
    expect(html).toContain('stroke-linecap="round"')
    expect(html).toContain('stroke-linejoin="round"')
    expect(html).toContain('d="M4 4h16v16H4z"')
  })
  it('the chosen card has a tick (not only a colour); the pictures are outlines, or solid with `shape_style: fill`', () => {
    const html = render(Array.from({ length: 6 }, (_, i) => ({ value: i === 0 ? 'a' : `v${i}`, label: `V${i}`, shape: 'M4 4h16v16H4z' })))
    expect((html.match(/am-card-check/g) ?? []).length).toBe(1)
    expect(html).toContain('aria-pressed="true"')
    expect(html).not.toContain('fill="currentColor"')
    expect(shapes(6, { shape_style: 'fill' })).toContain('fill="currentColor"')
  })
  it('up to four: buttons with a smaller drawing; a shape wins over an icon name', () => {
    const few = shapes(3)
    expect(few).toContain('am-seg')
    expect(few).toContain('width="24"')
    expect(render([{ value: 'a', shape: 'M0 0h5', icon: 'hole_round' }, 'b']).includes('d="M0 0h5"')).toBe(true)
  })
})
