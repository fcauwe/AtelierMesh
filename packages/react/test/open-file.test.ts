import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Registry } from '@ateliermesh/core'
import { repairPlugin, REPAIR_PLUGIN_ID } from '@ateliermesh/plugins'
import { Loader, LoaderIconProvider } from '../src/Working'
import { isMemoryError, repairFirstList } from '../src/useOpenFile'

describe('the Repair-first step list', () => {
  it('is one Repair mesh step that the registry accepts as it is', () => {
    const list = repairFirstList()
    expect(list.steps.length).toBe(1)
    expect(list.steps[0]!.plugin.id).toBe(REPAIR_PLUGIN_ID)
    const reg = new Registry().register(repairPlugin())
    const v = reg.validateStepList(list)
    expect(v.ok, JSON.stringify(v.errors)).toBe(true)
  })
})

describe('out of memory', () => {
  it('is recognised by the error a browser gives', () => {
    expect(isMemoryError(new RangeError('Array buffer allocation failed'))).toBe(true)
    expect(isMemoryError(new Error('Out of memory'))).toBe(true)
    expect(isMemoryError(new Error('bad file'))).toBe(false)
    expect(isMemoryError({ code: 'budget.triangles' })).toBe(false)
  })
})

describe('the waiting icon', () => {
  it('is the AtelierMesh loader by default', () => {
    expect(renderToStaticMarkup(createElement(Loader, { size: 40 }))).toContain('am-loader')
  })
  it('is a slot of size x size for a plain function, and size x (size x aspect) for an icon that is wider than it is high', () => {
    const plain = renderToStaticMarkup(createElement(LoaderIconProvider, { value: (size: number) => createElement('i', { 'data-size': size }) }, createElement(Loader, { size: 28 })))
    expect(plain).toContain('width:28px;height:28px')
    const wide = renderToStaticMarkup(createElement(LoaderIconProvider, { value: { render: (size: number) => createElement('i', { 'data-size': size }), aspect: 1.5 } }, createElement(Loader, { size: 64 })))
    expect(wide).toContain('width:96px;height:64px'); expect(wide).toContain('data-size="64"')   // the icon is told the slot's height
  })
  it('is the host\'s own icon when the screens are wrapped in a provider, at the size asked for', () => {
    const html = renderToStaticMarkup(createElement(LoaderIconProvider, { value: (size: number) => createElement('i', { className: 'atelier-spinner', 'data-size': size }) }, createElement(Loader, { size: 64 })))
    expect(html).toContain('atelier-spinner'); expect(html).toContain('data-size="64"'); expect(html).not.toContain('class="am-loader"')   // not the AtelierMesh loader itself (the slot around the host's icon is am-loader-slot)
  })
})
