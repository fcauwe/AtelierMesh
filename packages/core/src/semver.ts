// Minimal semver for `major.minor.patch` (the only form manifests may use).

export function parseSemver(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v)
  if (!m) throw new TypeError(`not a major.minor.patch version: ${v}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** -1 if a is older than b, 0 if equal, 1 if newer. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const x = parseSemver(a), y = parseSemver(b)
  for (let i = 0; i < 3; i++) {
    const d = (x[i] as number) - (y[i] as number)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}
