// Cooperative work: long loops (reading an STL, welding vertices, parsing a 3MF) are written as generators that yield their progress now and then.
// The synchronous API drains the generator at once; the asynchronous one lets the event loop run between the chunks, so a page can draw a loader,
// move a progress bar and answer a Stop button while a big file is read.
export interface ProgressOptions {
  /** Called with a number from 0 to 1, never going back, and once with 1 at the end. */
  onProgress?: (fraction: number) => void
  /** Stops the work at the next chunk; the promise rejects with a `DOMException` named `AbortError`. */
  signal?: AbortSignal
}

/** Triangles (or corners, objects) handled between two yields: small enough for a frame or two, big enough that the overhead is invisible. */
export const CHUNK = 60_000

/** A plain macrotask: timers, messages and React's own scheduling run before the work goes on. */
interface Env {
  MessageChannel?: new () => { port1: { onmessage: (() => void) | null; close(): void }; port2: { postMessage(m: unknown): void } }
  requestAnimationFrame?: (cb: () => void) => number
  document?: { hidden: boolean }
}
const env = globalThis as unknown as Env

function macrotask(): Promise<void> {
  const MC = env.MessageChannel
  if (typeof MC === 'function') return new Promise(resolve => { const c = new MC(); c.port1.onmessage = () => { c.port1.close(); resolve() }; c.port2.postMessage(null) })
  return new Promise(resolve => setTimeout(resolve, 0))
}

const pageVisible = (): boolean => { const d = env['document']; return d !== undefined && !d.hidden }
let lastPaint = 0
/**
 * Let the browser (or Node) run other tasks, and about every 80 ms let it draw a frame as well, so a loader animates and a bar moves while the work goes on.
 * Not `scheduler.yield`: its continuation outranks timers and React's updates, so a page would never get to show anything until the work was done.
 */
export function tick(): Promise<void> {
  const now = Date.now()
  if (typeof env.requestAnimationFrame === 'function' && pageVisible() && now - lastPaint > 80) {
    return new Promise(resolve => {
      let done = false
      const go = (): void => { if (done) return; done = true; lastPaint = Date.now(); setTimeout(resolve, 0) }
      env.requestAnimationFrame?.(go); setTimeout(go, 120)   // a background tab never runs the frame callback
    })
  }
  return macrotask()
}

export function runSync<T>(gen: Generator<number, T>): T {
  let r = gen.next()
  while (!r.done) r = gen.next()
  return r.value
}

export async function runAsync<T>(gen: Generator<number, T>, opts: ProgressOptions = {}): Promise<T> {
  let last = 0
  let r = gen.next()
  while (!r.done) {
    opts.signal?.throwIfAborted()
    if (r.value > last) { last = r.value; opts.onProgress?.(Math.min(0.999, r.value)) }
    await tick()
    r = gen.next()
  }
  opts.signal?.throwIfAborted()
  opts.onProgress?.(1)
  return r.value
}
