// The condition language of `visible_if` and `enabled_if` (SPEC section 4.4): comparison and boolean operators over parameter names.
// A tiny parser and evaluator. There is no eval, no function call, no property access, and the size is capped.
import { MeshError } from './errors'

export type ExprValue = string | number | boolean | null | undefined
export type Expr =
  | { t: 'lit'; v: string | number | boolean }
  | { t: 'id'; name: string }
  | { t: 'not'; e: Expr }
  | { t: 'and' | 'or'; l: Expr; r: Expr }
  | { t: 'cmp'; op: '==' | '!=' | '<' | '<=' | '>' | '>='; l: Expr; r: Expr }

const MAX_LENGTH = 300, MAX_DEPTH = 16
const bad = (reason: string, at?: number): MeshError => new MeshError('expr.invalid', { reason, ...(at === undefined ? {} : { at }) })

type Tok = { k: 'num' | 'str' | 'id' | 'op' | 'end'; v: string; at: number }

function lex(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i] as string
    if (/\s/.test(c)) { i++; continue }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i)) as RegExpExecArray
      out.push({ k: 'num', v: m[0], at: i }); i += m[0].length; continue
    }
    if (c === '"' || c === "'") {
      const e = src.indexOf(c, i + 1)
      if (e < 0) throw bad('unterminated_string', i)
      out.push({ k: 'str', v: src.slice(i + 1, e), at: i }); i = e + 1; continue
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i)) as RegExpExecArray
      out.push({ k: 'id', v: m[0], at: i }); i += m[0].length; continue
    }
    const two = src.slice(i, i + 2)
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) { out.push({ k: 'op', v: two, at: i }); i += 2; continue }
    if (['<', '>', '!', '(', ')'].includes(c)) { out.push({ k: 'op', v: c, at: i }); i++; continue }
    throw bad('unexpected_character', i)
  }
  out.push({ k: 'end', v: '', at: src.length })
  return out
}

export function parseExpr(src: string): Expr {
  if (typeof src !== 'string' || src.trim() === '') throw bad('empty')
  if (src.length > MAX_LENGTH) throw bad('too_long')
  const toks = lex(src)
  let p = 0
  const peek = (): Tok => toks[p] as Tok
  const isOp = (v: string): boolean => peek().k === 'op' && peek().v === v
  const parseOr = (d: number): Expr => {
    if (d > MAX_DEPTH) throw bad('too_deep')
    let l = parseAnd(d)
    while (isOp('||')) { p++; l = { t: 'or', l, r: parseAnd(d) } }
    return l
  }
  const parseAnd = (d: number): Expr => {
    let l = parseNot(d)
    while (isOp('&&')) { p++; l = { t: 'and', l, r: parseNot(d) } }
    return l
  }
  const parseNot = (d: number): Expr => {
    if (d > MAX_DEPTH) throw bad('too_deep')
    if (isOp('!')) { p++; return { t: 'not', e: parseNot(d + 1) } }
    const l = parsePrimary(d)
    const t = peek()
    if (t.k === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.v)) { p++; return { t: 'cmp', op: t.v as '==', l, r: parsePrimary(d) } }
    return l
  }
  const parsePrimary = (d: number): Expr => {
    const t = peek()
    if (t.k === 'num') { p++; return { t: 'lit', v: Number(t.v) } }
    if (t.k === 'str') { p++; return { t: 'lit', v: t.v } }
    if (t.k === 'id') { p++; return t.v === 'true' ? { t: 'lit', v: true } : t.v === 'false' ? { t: 'lit', v: false } : { t: 'id', name: t.v } }
    if (isOp('(')) {
      p++
      const e = parseOr(d + 1)
      if (!isOp(')')) throw bad('missing_close_paren', peek().at)
      p++
      return e
    }
    throw bad('unexpected_token', t.at)
  }
  const e = parseOr(0)
  if (peek().k !== 'end') throw bad('unexpected_token', peek().at)
  return e
}

/** Names the expression reads. */
export function exprIdentifiers(e: Expr, out = new Set<string>()): Set<string> {
  switch (e.t) {
    case 'id': out.add(e.name); break
    case 'not': exprIdentifiers(e.e, out); break
    case 'and': case 'or': case 'cmp': exprIdentifiers(e.l, out); exprIdentifiers(e.r, out); break
    case 'lit': break
  }
  return out
}

function value(e: Expr, values: Record<string, ExprValue>): ExprValue {
  switch (e.t) {
    case 'lit': return e.v
    case 'id': return values[e.name]
    case 'not': return !truthy(value(e.e, values))
    case 'and': return truthy(value(e.l, values)) && truthy(value(e.r, values))
    case 'or': return truthy(value(e.l, values)) || truthy(value(e.r, values))
    case 'cmp': {
      const a = value(e.l, values), b = value(e.r, values)
      if (e.op === '==') return a === b
      if (e.op === '!=') return a !== b
      if (typeof a !== 'number' || typeof b !== 'number') return false // ordering only means something for numbers
      return e.op === '<' ? a < b : e.op === '<=' ? a <= b : e.op === '>' ? a > b : a >= b
    }
  }
}
const truthy = (v: ExprValue): boolean => v !== null && v !== undefined && v !== false && v !== 0 && v !== ''

/** Evaluate a condition (source text or parsed) against parameter values. */
export function evalExpr(expr: string | Expr, values: Record<string, ExprValue>): boolean {
  return truthy(value(typeof expr === 'string' ? parseExpr(expr) : expr, values))
}
