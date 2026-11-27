import { describe, expect, it } from 'vitest'
import { History } from '../src'

describe('History', () => {
  it('undoes and redoes in order, and a new edit drops the redo branch', () => {
    const h = new History('a')
    h.push('b'); h.push('c')
    expect(h.undo()).toBe('b'); expect(h.undo()).toBe('a'); expect(h.undo()).toBeUndefined()
    expect(h.canUndo).toBe(false); expect(h.canRedo).toBe(true)
    expect(h.redo()).toBe('b')
    h.push('x')
    expect(h.canRedo).toBe(false)
    expect(h.undo()).toBe('b'); expect(h.present).toBe('b')
  })
  it('shares one entry between quick edits with the same key, but not across a pause or another key', () => {
    let t = 0
    const h = new History('a', 100, 500, () => t)
    h.push('H', 'text'); t = 100; h.push('He', 'text'); t = 200; h.push('Hel', 'text')
    expect(h.undo()).toBe('a')                     // one step back for the whole word
    h.redo(); t = 2000; h.push('Hello', 'text')    // a pause starts a new entry
    expect(h.undo()).toBe('Hel')
    h.redo(); t = 2100; h.push('Hello!', 'size')   // another key starts a new entry
    expect(h.undo()).toBe('Hello')
  })
  it('keeps at most `limit` entries, and clear forgets the past', () => {
    const h = new History(0, 3)
    for (let i = 1; i <= 10; i++) h.push(i)
    let n = 0; while (h.undo() !== undefined) n++
    expect(n).toBe(3)
    h.push(99); h.clear()
    expect(h.canUndo).toBe(false); expect(h.canRedo).toBe(false); expect(h.present).toBe(99)
    h.clear(5); expect(h.present).toBe(5)
  })
})
