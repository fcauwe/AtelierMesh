import { describe, expect, it } from 'vitest'
import { problemText } from '../src/common'

// A plugin's text may name a value only some of its errors carry: the person must not read the braces.
const t = (text: string) => (_key: string, values: Record<string, string | number> = {}): string => text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, n: string) => String(values[n] ?? `{{${n}}}`))

describe('problemText', () => {
  it('fills the values it has and leaves nothing behind for one it has not', () => {
    const text = 'Er liep iets mis bij het maken van de uitsteker ({{part}}{{message}}). Meld het met je instellingen.'
    expect(problemText(t(text), 'k', { part: 'cutter' })).toBe('Er liep iets mis bij het maken van de uitsteker (cutter). Meld het met je instellingen.')
    expect(problemText(t(text), 'k', { part: 'cutter', message: ': boom' })).toBe('Er liep iets mis bij het maken van de uitsteker (cutter: boom). Meld het met je instellingen.')
  })
  it('tidies the brackets and spaces a missing value leaves, and changes nothing else', () => {
    expect(problemText(t('Failed ({{message}}) twice'), 'k', {})).toBe('Failed twice')
    expect(problemText(t('{{a}} and {{b}}'), 'k', { a: 'x', b: 'y' })).toBe('x and y')
    expect(problemText(t('Plain text.'), 'k', {})).toBe('Plain text.')
  })
})
