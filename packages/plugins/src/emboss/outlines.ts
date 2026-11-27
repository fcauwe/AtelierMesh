// Letter outlines for everyone: the same code the text step uses, with a fixed contract (see `FontOutlines` in @ateliermesh/core): millimetres, y up, outer contours
// counter-clockwise and holes clockwise, no crossings. A host offers it to plugins as `ctx.fonts.outline(fontId, text, options)` through `createFontService`.
import { MeshError, sha256Hex } from '@ateliermesh/core'
import type { AssetResolver, FontOutlineOptions, FontOutlines, FontService } from '@ateliermesh/core'
import type { Font } from 'fontkit'
import { layoutText, loadFont } from './text'

/** A font that `getFont` parsed. Opaque on purpose: the parser's own types do not appear in this package's declarations. */
export type ParsedFont = object

type Ring = Array<[number, number]>
const signedArea = (r: Ring): number => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i] as [number, number], q = r[(i + 1) % r.length] as [number, number]; a += p[0] * q[1] - q[0] * p[1] } return a / 2 }

/** Outlines of `text` in an already loaded font. Throws the text step's errors (`emboss.missing_glyphs`, `emboss.empty_text`, `emboss.text_too_long`, ...). */
export function fontOutlines(font: ParsedFont, text: string, o: FontOutlineOptions): FontOutlines {
  const shape = layoutText(font as Font, {
    text, size: o.size, ...(o.weight !== undefined ? { weight: o.weight } : {}), ...(o.align ? { align: o.align } : {}),
    ...(o.letterSpacing !== undefined ? { spacing: o.letterSpacing } : {}), ...(o.lineSpacing !== undefined ? { lineSpacing: o.lineSpacing } : {}),
    ...(o.maxWidth !== undefined ? { maxWidth: o.maxWidth } : {}), tolerance: o.tolerance ?? 0.01, anchor: o.anchor ?? { h: 'left', v: 'baseline' },
  })
  const contours = shape.rings.map((r, i) => {
    const wantCcw = !shape.holes[i]
    return (signedArea(r) > 0) === wantCcw ? r : r.slice().reverse()
  })
  return { contours, fillRule: 'nonzero', bbox: shape.bbox, lines: shape.lines, size: shape.size, fitScale: shape.fitScale }
}

/** SVG path data (`M x y L ... Z`) for the contours, y flipped when `flipY` (SVG's y points down; default true), numbers rounded to `digits` decimals (default 3). */
export function outlinesToSvgPath(contours: FontOutlines['contours'], o: { flipY?: boolean; digits?: number } = {}): string {
  const k = 10 ** (o.digits ?? 3), sy = o.flipY === false ? 1 : -1
  const n = (v: number): string => String(Math.round(v * k) / k)
  return contours.map(c => c.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${n(x)} ${n(sy * y)}`).join('') + 'Z').join('')
}

// parsed fonts are kept by what the bytes are, not by the asset id: the same id may name different files in different projects
export interface LoadFontOptions {
  /** Turns a WOFF2 file into plain TrueType bytes. Needed only for variable WOFF2 fonts, which the font parser cannot read directly. */
  decompressWoff2?: (bytes: Uint8Array) => Promise<Uint8Array>
}

const fontCache = new Map<string, Promise<Font>>()
export function getFont(bytes: Uint8Array, opts: LoadFontOptions = {}): Promise<ParsedFont> {
  const key = `${bytes.length}:${sha256Hex(bytes)}`
  let p = fontCache.get(key)
  if (!p) { p = loadFont(bytes, opts); fontCache.set(key, p); p.catch(() => fontCache.delete(key)) }
  return p
}

export interface FontServiceOptions extends LoadFontOptions {
  /** How many finished outlines to remember (a preview that runs again asks for the same text). Default 40. */
  remember?: number
}

/** The host's side of `ctx.fonts.outline`: reads the font bytes with the host's asset resolver, parses and caches the font, and returns the outlines. */
export function createFontService(assets: AssetResolver, opts: FontServiceOptions = {}): FontService {
  const done = new Map<string, FontOutlines>()
  const limit = opts.remember ?? 40
  return async (fontId, text, options) => {
    if (typeof fontId !== 'string' || fontId === '') throw new MeshError('emboss.no_font')
    const bytes = await assets(fontId)
    const font = await getFont(bytes, opts)
    const key = `${bytes.length}:${sha256Hex(bytes)}|${JSON.stringify([text, options])}`
    const hit = done.get(key)
    if (hit) return hit
    const out = fontOutlines(font, text, options)
    done.set(key, out)
    if (done.size > limit) done.delete(done.keys().next().value as string)
    return out
  }
}
