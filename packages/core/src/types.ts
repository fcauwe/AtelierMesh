// Shared types. Units are millimetres, the frame is right-handed with Z up (SPEC.md section 5).
import type { StructuredError } from './errors'
import type { Drawing } from './drawing'

/**
 * The mesh passed between steps: indexed, welded triangles, counter-clockwise seen from outside.
 * Positions are double precision on purpose: the cut needs it, and STL is only the interchange format.
 */
export interface Mesh {
  /** xyz per vertex, millimetres. */
  positions: Float64Array
  /** Three vertex indices per triangle. */
  indices: Uint32Array
  /** Optional named bodies: `start` and `count` are triangle ranges. `negative` bodies are subtracted by exporters that support it. */
  groups?: MeshGroup[]
  /** Optional labels for the triangles of one surface (SPEC.md section 5.1). */
  segments?: MeshSegments
}

/** One label per triangle, plus a table naming the labels. Label 0 is the default segment `body`. */
export interface MeshSegments {
  labels: Uint16Array
  table: SegmentInfo[]
}

export interface SegmentInfo {
  id: number
  /** `^[a-z][a-z0-9_]*$`, unique in the table. */
  name: string
  /** Display colour `#rrggbb`; an exporter may use it. */
  color?: string
}

export interface MeshGroup {
  start: number
  count: number
  role: 'solid' | 'negative'
  name?: string
  /** Display colour `#rrggbb` of the whole body; an exporter may use it. A segment colour on a triangle of the body wins over it. */
  color?: string
}

/**
 * What flows between steps: a mesh (no tag), a `Drawing`, or any kind a host registers (`payloadKinds`). A value of another kind carries a `kind` word and
 * must survive structured cloning, because it crosses into the plugin's worker.
 */
export type Payload = Mesh | Drawing | { kind: string }

export type Vec3 = [number, number, number]

export type Quality = 'preview' | 'export'

export type LogLevel = 'info' | 'warn' | 'error'

/** What a plugin hands back: an optional mesh, an optional report of plain JSON, and structured warnings. */
export interface RunResult {
  mesh?: Mesh
  /** The result when it is not a mesh (for example a drawing). A step that returns a mesh may use `mesh` or `payload`. */
  payload?: Payload
  report?: Record<string, unknown>
  warnings?: StructuredError[]
}

/** Fonts and textures come from the host, by id. The engine never bundles them. */
export type AssetResolver = (id: string) => Promise<Uint8Array>

/**
 * Letter outlines from a font (the same code as the built-in text step). Everything in millimetres, y up. By default the left edge of the letters is at x = 0 and the
 * first baseline at y = 0; `anchor` moves the origin to another point of the text's box.
 */
export interface FontOutlineOptions {
  /** Height of a capital letter, mm (0.1 to 1000). */
  size: number
  /** Variable fonts: the `wght` axis. */
  weight?: number
  /** Extra space after every glyph, mm. */
  letterSpacing?: number
  /** Line pitch as a multiple of `size` (default 1.2). */
  lineSpacing?: number
  align?: 'left' | 'center' | 'right'
  /** Scale the text down to fit this width, mm. */
  maxWidth?: number
  /** Curve flattening tolerance, mm (default 0.01; 0.001 to 1). */
  tolerance?: number
  /** Which point of the text's box sits at the origin (default `{ h: 'left', v: 'baseline' }`). */
  anchor?: { h: 'left' | 'center' | 'right'; v: 'baseline' | 'middle' }
}

/**
 * Closed polygons, outer contours counter-clockwise and holes clockwise (y up). Fill them with either rule: `nonzero` and `evenodd` give the same shape.
 * Contours never touch or cross each other.
 */
export interface FontOutlines {
  contours: Array<Array<[number, number]>>
  fillRule: 'nonzero'
  bbox: [number, number, number, number]
  lines: number
  /** The size after `maxWidth` scaled it down. */
  size: number
  /** 1 unless `maxWidth` scaled the text down. */
  fitScale: number
}

export interface FontsApi {
  /**
   * Outlines of `text` in the font of asset `fontId` (the id of an asset parameter). Throws `emboss.missing_glyphs` (`characters`) when the font lacks a character,
   * `emboss.font_unreadable`, `emboss.empty_text`, `emboss.text_too_long` (200 characters) or `fonts.unavailable` when the host has no font service.
   */
  outline(fontId: string, text: string, options: FontOutlineOptions): Promise<FontOutlines>
}

/** What a plugin sees while it runs. */
export interface RunContext {
  /** Letter outlines, done by the host (see `FontsApi`). A plugin that uses it says so in its manifest: `"uses": ["fonts"]`. */
  fonts: FontsApi
  /** Validated, with defaults filled. */
  params: Record<string, unknown>
  /** The mesh from the previous step (absent for a generator at the start of a workflow, and when the input is not a mesh). */
  mesh?: Mesh
  /** What the previous step produced, whatever its kind (the same object as `mesh` when it is a mesh). */
  payload?: Payload
  /** The stored payloads the step asked for with its `payload` parameters, by parameter name (empty when it has none). Read only. */
  payloads: Record<string, Payload>
  assets: AssetResolver
  quality: Quality
  progress(stage: string, fraction: number): void
  /** Plugins must check this regularly and stop when it fires. */
  signal: AbortSignal
  log(level: LogLevel, message: string): void
}

/** The code a plugin ships. One function per operation, selected by name. */
export interface PluginModule {
  run(op: string, ctx: RunContext): Promise<RunResult> | RunResult
  /**
   * Bring parameters stored by an older plugin version up to the current one. Called with the stored version.
   * Must be a pure function of its arguments.
   */
  migrate?(fromVersion: string, params: Record<string, unknown>, op: string): Record<string, unknown>
  /** Name the operation a stored step belongs to now, when an operation was split or renamed. Called with the stored (not yet migrated) params. */
  migrateOp?(fromVersion: string, op: string, params: Record<string, unknown>): string
}

/** Placement of content on a mesh surface (SPEC.md section 5A.7). */
export interface Placement {
  anchor: {
    point: Vec3
    normal: Vec3
    /** Triangle hint, valid only while the mesh fingerprint matches. */
    tri?: number
    bary?: Vec3
    fingerprint?: string
  }
  up_ref?: 'x' | 'y' | 'z'
  /** Degrees about the surface normal at the anchor, -180 to 180. */
  direction?: number
  /** Shift in millimetres on the unfolded map. */
  offset?: [number, number]
  align?: { h: 'left' | 'center' | 'right'; v: 'baseline' | 'middle' }
}
