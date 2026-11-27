import { describe, expect, it } from 'vitest'
import { Registry, makeStep } from '@ateliermesh/core'
import manifest from '../manifest.json'
import module from '../main'

// a copy of the manifest in which the designer may hand the gap to the customer
const handedOver = JSON.parse(JSON.stringify(manifest)) as { operations: Array<{ personalisable?: string; params: Array<{ name: string; personalisable?: boolean }> }> }
handedOver.operations[0]!.personalisable = 'optional'
handedOver.operations[0]!.params.find(p => p.name === 'gap')!.personalisable = true
const registry = new Registry().register({ manifest: handedOver as never, load: () => module })

const designer = makeStep({ id: 's1', plugin: { id: 'com.example.mirror', version: '1.0.0' }, op: 'mirror', params: { axis: 'x', mode: 'copy', gap: 2 }, personalisable: true, personalisable_params: ['gap'] })
const asCustomer = (params: Record<string, unknown>) => registry.validateStep({ ...designer, params: { ...designer.params, ...params } }, { role: 'customer', base: designer })

describe('what a customer may change', () => {
  it('accepts a change to the parameter the designer handed over, inside its limits', () => { expect(asCustomer({ gap: 10 }).ok).toBe(true) })
  it('refuses a change to anything else', () => {
    const r = asCustomer({ axis: 'z' })
    expect(r.ok).toBe(false)
    expect(r.errors[0]!.code).toBe('param.not_editable')
  })
  it('refuses a value outside the manifest limits', () => { expect(asCustomer({ gap: 999 }).ok).toBe(false) })
})
