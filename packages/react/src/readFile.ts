// Read a File into bytes while reporting how many bytes have arrived, so the page can show "12.3 of 48.0 MB" and a bar. Stops at once with an AbortError when the signal fires.
export async function readFileBytes(file: File, onBytes: (done: number, total: number) => void, signal?: AbortSignal): Promise<Uint8Array> {
  const total = file.size
  if (typeof file.stream !== 'function') { signal?.throwIfAborted(); const b = new Uint8Array(await file.arrayBuffer()); onBytes(total, total); return b }
  const out = new Uint8Array(total)
  const reader = file.stream().getReader()
  let done = 0
  try {
    for (;;) {
      signal?.throwIfAborted()
      const r = await reader.read()
      if (r.done) break
      out.set(r.value, done); done += r.value.length
      onBytes(done, total)
    }
  } finally { void reader.cancel().catch(() => undefined) }
  return done === total ? out : out.slice(0, done)
}

/** A user stop: not a failure to report. */
export const isAbort = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError'
