declare module 'fontkit' {
  export interface Glyph { id: number; path: { commands: Array<{ command: string; args: number[] }> }; advanceWidth: number }
  export interface Run { glyphs: Glyph[]; positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }> }
  export interface Font {
    unitsPerEm: number
    capHeight: number
    xHeight: number
    ascent: number
    descent: number
    lineGap: number
    variationAxes?: Record<string, { min: number; default: number; max: number }>
    layout(text: string, features?: string[]): Run
    getVariation(settings: Record<string, number>): Font
    hasGlyphForCodePoint(cp: number): boolean
  }
  export function create(data: Uint8Array): Font
}
declare module 'clipper-lib' {
  const ClipperLib: {
    Clipper: new () => {
      AddPaths(paths: Array<Array<{ X: number; Y: number }>>, polyType: number, closed: boolean): boolean
      Execute(clipType: number, solution: unknown, subjFill: number, clipFill: number): boolean
    }
    PolyTree: new () => { Childs(): Array<PolyNode> }
    Paths: new () => Array<Array<{ X: number; Y: number }>>
    ClipperOffset: new (miterLimit?: number, arcTolerance?: number) => {
      AddPath(path: Array<{ X: number; Y: number }>, join: number, end: number): void
      AddPaths(paths: Array<Array<{ X: number; Y: number }>>, join: number, end: number): void
      Execute(solution: Array<Array<{ X: number; Y: number }>>, delta: number): void
    }
    JoinType: { jtRound: number; jtMiter: number; jtSquare: number }
    EndType: { etClosedLine: number; etOpenRound: number; etClosedPolygon: number }
    PolyType: { ptSubject: number; ptClip: number }
    ClipType: { ctUnion: number; ctIntersection: number; ctDifference: number }
    PolyFillType: { pftNonZero: number; pftEvenOdd: number }
  }
  interface PolyNode { IsHole(): boolean; Contour(): Array<{ X: number; Y: number }>; Childs(): PolyNode[] }
  export default ClipperLib
}
declare module 'cdt2d' {
  /** Constrained Delaunay triangulation of 2D points with constraint edges. */
  export default function cdt2d(points: Array<[number, number]>, edges?: Array<[number, number]>, options?: { delaunay?: boolean; interior?: boolean; exterior?: boolean; infinity?: boolean }): Array<[number, number, number]>
}
declare module 'svgpath' {
  interface SvgPath {
    abs(): SvgPath
    unarc(): SvgPath
    unshort(): SvgPath
    transform(t: string): SvgPath
    iterate(fn: (segment: Array<string | number>, index: number, x: number, y: number) => void): SvgPath
  }
  export default function svgpath(d: string): SvgPath
}
