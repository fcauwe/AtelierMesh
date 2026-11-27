// Undo and redo for edits to the step list (SPEC section 10). A plain value history: the host stores whatever it needs to restore
// (the step list and the rollback marker), pushes a new value after each edit, and asks for the previous or next one.
// Quick consecutive edits of the same thing (typing a word, dragging a slider) can share one entry through a key.

export class History<T> {
  private past: T[] = []
  private future: T[] = []
  private current: T
  private lastKey: string | undefined
  private lastAt = 0

  constructor(initial: T, private readonly limit = 100, private readonly coalesceMs = 800, private readonly now: () => number = () => Date.now()) { this.current = initial }

  get present(): T { return this.current }
  get canUndo(): boolean { return this.past.length > 0 }
  get canRedo(): boolean { return this.future.length > 0 }

  /** Record a new value. With the same `key` as the previous push, within the coalesce window, the entry is replaced instead of added. */
  push(value: T, key?: string): void {
    const t = this.now()
    if (key !== undefined && key === this.lastKey && t - this.lastAt <= this.coalesceMs) { this.current = value; this.lastAt = t; this.future = []; return }
    this.past.push(this.current)
    if (this.past.length > this.limit) this.past.shift()
    this.current = value; this.future = []; this.lastKey = key; this.lastAt = t
  }

  undo(): T | undefined {
    const v = this.past.pop()
    if (v === undefined) return undefined
    this.future.push(this.current); this.current = v; this.lastKey = undefined
    return v
  }

  redo(): T | undefined {
    const v = this.future.pop()
    if (v === undefined) return undefined
    this.past.push(this.current); this.current = v; this.lastKey = undefined
    return v
  }

  /** Forget everything before now: after Apply nothing earlier can be restored. */
  clear(to: T = this.current): void { this.past = []; this.future = []; this.current = to; this.lastKey = undefined }
}
