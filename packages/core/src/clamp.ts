// Make a typed value acceptable: numbers are limited to min and max, ints are rounded, steps are honoured. Used by the panel so that
// a typed 5000 becomes the maximum instead of an error. Validation (validate.ts) still refuses what is out of range.
import type { ParamDef } from './manifest'

export function clampParam(def: ParamDef, v: unknown): unknown {
  const lim = (x: number, min?: number, max?: number): number => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, x))
  switch (def.type) {
    case 'int': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return def.default
      let x = Math.round(v)
      if (def.step && def.step > 0) x = Math.round((x - (def.min ?? 0)) / def.step) * def.step + (def.min ?? 0)
      return Math.round(lim(x, def.min, def.max))
    }
    case 'float': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return def.default
      let x = v
      if (def.step && def.step > 0) x = Math.round((x - (def.min ?? 0)) / def.step) * def.step + (def.min ?? 0)
      return lim(x, def.min, def.max)
    }
    case 'angle': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return def.default
      if (def.wrap) return ((((v - (def.min ?? 0)) % 360) + 360) % 360) + (def.min ?? 0)
      return lim(v, def.min, def.max)
    }
    case 'vector': {
      if (!Array.isArray(v) || v.length !== def.size) return def.default
      return v.map(x => (typeof x === 'number' && Number.isFinite(x) ? lim(x, def.min, def.max) : 0))
    }
    case 'string': {
      if (typeof v !== 'string') return def.default
      return def.max_length !== undefined ? v.slice(0, def.max_length) : v
    }
    case 'range': {
      if (!Array.isArray(v) || v.length !== 2) return def.default
      const a = typeof v[0] === 'number' && Number.isFinite(v[0]) ? lim(v[0], def.min, def.max) : def.default[0]
      const b = typeof v[1] === 'number' && Number.isFinite(v[1]) ? lim(v[1], def.min, def.max) : def.default[1]
      return a <= b ? [a, b] : [b, a]
    }
    case 'list': {
      if (!Array.isArray(v)) return def.default
      const rows = v.slice(0, def.max_items ?? Infinity).map(row => {
        const r = (typeof row === 'object' && row !== null && !Array.isArray(row) ? row : {}) as Record<string, unknown>
        return Object.fromEntries(def.item.map(f => [f.name, f.name in r ? clampParam(f, r[f.name]) : f.default]))
      })
      return rows
    }
    case 'color': {
      const ok = typeof v === 'string' && (def.alpha ? /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/ : /^#[0-9a-fA-F]{6}$/).test(v)
      if (!ok) return def.default
      const c = (v as string).toLowerCase()
      return def.only_palette && def.palette && !def.palette.some(x => x.toLowerCase() === c) ? def.default : c
    }
    case 'object': {
      const r = (typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {}) as Record<string, unknown>
      return Object.fromEntries(def.fields.map(f => [f.name, f.name in r ? clampParam(f, r[f.name]) : f.default]))
    }
    default: return v
  }
}

/** Cuts a text to the designer's limits: at most `max_lines` lines, each at most `max_line_length` characters (counted as characters, not bytes). */
export function fitTextToLimits(text: string, limits: { max_lines?: number; max_line_length?: number } | undefined): string {
  if (!limits) return text
  let lines = text.split('\n')
  if (limits.max_lines !== undefined) lines = lines.slice(0, limits.max_lines)
  const n = limits.max_line_length
  if (n !== undefined) lines = lines.map(l => ([...l].length > n ? [...l].slice(0, n).join('') : l))
  return lines.join('\n')
}
