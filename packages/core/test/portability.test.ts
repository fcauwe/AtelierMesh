import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(f => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [] })
}

describe('the core is portable', () => {
  const src = join(__dirname, '../src')
  const core = files(src).filter(f => !f.includes('/testing/'))
  it('imports nothing outside the package, no DOM, no node: modules', () => {
    const bad: string[] = []
    for (const f of core) {
      const text = readFileSync(f, 'utf8')
      for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const spec = m[1]!
        if (!spec.startsWith('.')) bad.push(`${f}: ${spec}`)
      }
      if (/\b(document|window|navigator|localStorage|require)\b\s*[.(]/.test(text.replace(/\/\/.*$/gm, ''))) bad.push(`${f}: touches a DOM or Node global`)
    }
    expect(bad).toEqual([])
  })
})
