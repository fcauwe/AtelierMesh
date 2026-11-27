// Text to outlines: font loading, layout (lines, alignment, spacing), glyph outlines merged into one shape, placed relative to the anchor.
import { MeshError } from '@ateliermesh/core'
import * as fontkit from 'fontkit'
import type { Font } from 'fontkit'
import type { Ring } from './cut'
import { bboxOfRings, flattenPath, unionNonZeroTree } from './shape'

export interface LoadFontOptions {
  /** Turns a WOFF2 file into plain TrueType bytes. Needed only for variable WOFF2 fonts, which fontkit cannot read directly. */
  decompressWoff2?: (bytes: Uint8Array) => Promise<Uint8Array>
}

export async function loadFont(bytes: Uint8Array, opts: LoadFontOptions = {}): Promise<Font> {
  let font: Font
  try { font = fontkit.create(bytes) } catch (e) { throw new MeshError('emboss.font_unreadable', { message: e instanceof Error ? e.message : String(e) }) }
  const axes = font.variationAxes
  if (axes && Object.keys(axes).length > 0 && opts.decompressWoff2 && isWoff2(bytes)) {
    try { font = fontkit.create(await opts.decompressWoff2(bytes)) } catch (e) { throw new MeshError('emboss.font_unreadable', { message: e instanceof Error ? e.message : String(e) }) }
  }
  return font
}
const isWoff2 = (b: Uint8Array): boolean => b.length > 4 && b[0] === 0x77 && b[1] === 0x4f && b[2] === 0x46 && b[3] === 0x32

export interface TextOptions {
  text: string
  /** Height of a capital letter, mm. */
  size: number
  /** Variable fonts only. */
  weight?: number
  align?: 'left' | 'center' | 'right'
  /** Extra space after every glyph, mm. */
  spacing?: number
  /** Line pitch as a multiple of the font size. */
  lineSpacing?: number
  /** Scale the text down to fit this width (mm); 0 or absent for no limit. */
  maxWidth?: number
  /** Curve flattening tolerance, mm. */
  tolerance: number
  /** Which point of the text's box sits at the anchor. */
  anchor?: { h: 'left' | 'center' | 'right'; v: 'baseline' | 'middle' }
  /** Shift on the map, mm. */
  offset?: [number, number]
  maxLength?: number
}

export interface TextShape {
  rings: Ring[]
  /** For each ring: true when it is a hole. */
  holes: boolean[]
  bbox: [number, number, number, number]
  /** Characters the font has no glyph for. */
  missing: string[]
  /** Factor applied by `maxWidth` (1 when the text already fitted). */
  fitScale: number
  size: number
  lines: number
}

export function layoutText(fontIn: Font, o: TextOptions): TextShape {
  const text = o.text.replace(/\r\n?/g, '\n')
  if (text.trim() === '') throw new MeshError('emboss.empty_text')
  if (text.length > (o.maxLength ?? 200)) throw new MeshError('emboss.text_too_long', { length: text.length, max: o.maxLength ?? 200 })
  if (!(o.size > 0)) throw new MeshError('emboss.bad_size', { size: o.size })
  let font = fontIn
  if (font.variationAxes && Object.keys(font.variationAxes).length > 0 && o.weight !== undefined) font = font.getVariation({ wght: o.weight })
  const cap = font.capHeight > 0 ? font.capHeight : 0.7 * font.unitsPerEm
  const scale = o.size / cap
  const em = font.unitsPerEm * scale
  const pitch = em * (o.lineSpacing ?? 1.2)
  const spacing = o.spacing ?? 0
  const missing = new Set<string>()
  type Line = { rings: Ring[]; width: number }
  const lines: Line[] = []
  text.split('\n').forEach(lineText => {
    const run = font.layout(lineText)
    const chars = Array.from(lineText)
    let x = 0
    const raw: Ring[] = []
    run.glyphs.forEach((g, i) => {
      const pos = run.positions[i] as { xAdvance: number; xOffset: number; yOffset: number }
      if (g.id === 0 && chars[i] !== undefined && chars[i] !== ' ') missing.add(chars[i] as string)
      raw.push(...flattenPath(g.path.commands, scale, o.tolerance, (x + pos.xOffset * scale), pos.yOffset * scale))
      x += pos.xAdvance * scale + spacing
    })
    lines.push({ rings: raw, width: Math.max(0, x - spacing) })
  })
  if (missing.size > 0) throw new MeshError('emboss.missing_glyphs', { characters: [...missing] })
  const blockWidth = Math.max(...lines.map(l => l.width))
  // place the lines: first baseline at y = 0, the next ones below; alignment inside the block
  const placed: Ring[] = []
  lines.forEach((l, i) => {
    const dx = o.align === 'center' ? (blockWidth - l.width) / 2 : o.align === 'right' ? blockWidth - l.width : 0
    const dy = -i * pitch
    for (const r of l.rings) placed.push(r.map(([px, py]) => [px + dx, py + dy] as [number, number]))
  })
  const tree = unionNonZeroTree(placed)
  let rings = tree.map(t => t.ring)
  const holes = tree.map(t => t.hole)
  if (rings.length === 0) throw new MeshError('emboss.empty_shape')
  let fit = 1
  let [x0, y0, x1, y1] = bboxOfRings(rings)
  if (o.maxWidth && o.maxWidth > 0 && x1 - x0 > o.maxWidth) {
    fit = o.maxWidth / (x1 - x0)
    rings = rings.map(r => r.map(([px, py]) => [px * fit, py * fit] as [number, number]))
    ;[x0, y0, x1, y1] = bboxOfRings(rings)
  }
  const a = o.anchor ?? { h: 'center', v: 'middle' }
  const ax = a.h === 'left' ? x0 : a.h === 'right' ? x1 : (x0 + x1) / 2
  const ay = a.v === 'baseline' ? 0 : (y0 + y1) / 2
  const sx = -ax + (o.offset?.[0] ?? 0), sy = -ay + (o.offset?.[1] ?? 0)
  rings = rings.map(r => r.map(([px, py]) => [px + sx, py + sy] as [number, number]))
  return { rings, holes, bbox: bboxOfRings(rings), missing: [], fitScale: fit, size: o.size * fit, lines: lines.length }
}
