// The manifest: a small JSON file that describes a plugin so the host can use it without knowing its code.
// Shape follows SPEC.md section 4 and the Atelier's vision doc (operation `personalisable`, parameter `personalisable`).

export type OperationKind = 'generator' | 'modifier' | 'analyzer' | 'exporter'

interface ParamBase {
  /** Stable key, never shown. `^[a-z][a-z0-9_]*$`. */
  name: string
  label?: string
  help?: string
  /** The id of the panel section (one of the operation's `sections`) this parameter is shown in. */
  section?: string
  unit?: string
  /** Conditional display over other parameters (host UI only; not part of validation). */
  visible_if?: string
  enabled_if?: string
  /** May the end customer change this value? Everything else is fixed by the designer. */
  personalisable?: boolean
  quality?: 'both' | 'export' | 'preview'
  affects?: 'geometry' | 'appearance'
  /**
   * How a host may present the value (a hint: a host that does not know it shows the plain control). `segmented` and `cards` for an `enum`, `slider` and `stepper`
   * for a number (`slider` needs `min` and `max`), `axes` for a `vector`, `font` and `gallery` for an `asset`. See `WIDGETS_FOR` and docs/plugin-authoring.md, "How it looks".
   */
  widget?: ParamWidget
  /** How much the field matters: `main` fields come first in the open group, `advanced` ones go into the collapsed "More" group. Absent: `normal`. */
  importance?: 'main' | 'normal' | 'advanced'
  /** The name of an icon from the host's icon set (`^[a-z][a-z0-9_-]*$`) shown next to the label. A host that does not know the name shows none. */
  icon?: string
}

export const PARAM_WIDGETS = ['segmented', 'cards', 'slider', 'stepper', 'axes', 'font', 'gallery'] as const
export type ParamWidget = (typeof PARAM_WIDGETS)[number]
/** Which widget hints make sense for which parameter type. */
export const WIDGETS_FOR: Readonly<Record<string, readonly ParamWidget[]>> = {
  enum: ['segmented', 'cards'], int: ['slider', 'stepper'], float: ['slider', 'stepper'], angle: ['slider', 'stepper'], vector: ['axes'], asset: ['font', 'gallery'],
}
export const IMPORTANCES = ['main', 'normal', 'advanced'] as const
/** The values of an operation's `importance` (a parameter's is `IMPORTANCES`). */
export const OPERATION_IMPORTANCES = ['normal', 'low'] as const
/** Icon names, and the same pattern for the operation's `icon`. */
export const ICON_NAME_RE = /^[a-z][a-z0-9_-]{0,39}$/

export interface BoolParam extends ParamBase { type: 'bool'; default: boolean }
export interface IntParam extends ParamBase { type: 'int'; default: number; min?: number; max?: number; step?: number }
export interface FloatParam extends ParamBase { type: 'float'; default: number; min?: number; max?: number; step?: number; scale?: 'linear' | 'log'; wheel_fine?: boolean }
export interface StringParam extends ParamBase { type: 'string'; default: string; min_length?: number; max_length?: number; pattern?: string; multiline?: boolean }
/** The picture of an `enum` option: the `d` of an SVG path on a 24 x 24 grid, drawn as an outline (stroke, no fill, round line ends and joins). Path data only: no markup can come with it. */
export const SHAPE_PATH_RE = /^[Mm][MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]{0,999}$/
/** At most this many options of one parameter may carry a `shape`. */
export const MAX_SHAPES = 64
/**
 * An `enum` choice: a plain value, or a value with its own label, an optional icon name and an optional `shape`, a picture of its own (hints, like `widget`).
 * `shape` wins over `icon`. A host that does not know `shape` ignores it.
 */
export type EnumOption = string | { value: string; label?: string; icon?: string; shape?: string }
/** `shape_style` (a hint): how the pictures made from `shape` are drawn, as an outline (`line`, the default) or as a solid silhouette (`fill`). */
export interface EnumParam extends ParamBase { type: 'enum'; default: string; options: EnumOption[]; shape_style?: 'line' | 'fill' }
export interface VectorParam extends ParamBase { type: 'vector'; size: 2 | 3; default: number[]; min?: number; max?: number; labels?: string[] }
/** Degrees. */
export interface AngleParam extends ParamBase { type: 'angle'; default: number; min?: number; max?: number; wrap?: boolean }
/** An id the host resolves to bytes (a font, a texture, a model). `null` means none. */
/**
 * `widget` is a hint for how a host may present the choice: `font` is a grid of fonts, `gallery` a grid of pictures. `preview: 'text'` says each
 * choice is better shown with the user's own text (a font with the wording typed). A host that does not know a hint shows a plain picker.
 */
export interface AssetParam extends ParamBase { type: 'asset'; default: string | null; accept?: string[]; library?: string; widget?: 'font' | 'gallery'; preview?: 'text'; allow_upload?: boolean; categories?: string[]; searchable?: boolean }
export const ASSET_WIDGETS = ['font', 'gallery'] as const
/**
 * The name of an entry in the project store (docs/proposals/project-store-plan.md): a payload of one of the `accept`ed kinds (`mesh`, `drawing`, or a kind the host
 * registered) that the step takes next to its main input. The value is the entry's name, or `null` for none. The runner finds the entry (the nearest earlier
 * `store` step that wrote the name, else the project's own entry), checks its kind and gives it to the plugin as `ctx.payloads[<param name>]`.
 */
export interface PayloadParam extends ParamBase { type: 'payload'; default: string | null; accept: string[] }
/** Position and orientation on the mesh surface (SPEC.md section 5A.7). */
export interface PlacementParam extends ParamBase { type: 'placement'; default: unknown; up_ref?: 'x' | 'y' | 'z' }

/** One part of the mesh at this step, chosen by name: a segment (a labelled set of triangles, SPEC.md section 5.1) or a group (a distinct body). Empty means the whole mesh. Checked when the step runs. */
export interface PartParam extends ParamBase {
  type: 'part'
  default: string
  /** Empty means the whole mesh (default true). */
  allow_empty?: boolean
  /** What may be chosen: a labelled `segment` of the surface, a distinct `group` (body) of the mesh, or both (the default). */
  kinds?: Array<'segment' | 'group'>
  /** A host that adds a step with this parameter picks the first part that exists (a body first, then a labelled segment) so the step starts out valid. */
  preselect?: 'first'
}

/** A low and a high value (for example a band of surface angles). `[low, high]` with low at most high, both within `min` and `max`. */
export interface RangeParam extends ParamBase { type: 'range'; default: [number, number]; min?: number; max?: number; step?: number }

/**
 * Which triangles of the mesh at this step: painted by the user, or picked by rules. Stored as runs of triangle indices (`[start, count]`,
 * ascending, not overlapping). `basis` is the key of the mesh the runs were made on (`meshKey`); a host that sees a different mesh can warn
 * that the selection no longer fits. `null` means no selection.
 */
export interface SelectionValue { mode: 'include' | 'exclude'; triangles: Array<[number, number]>; basis?: string }
export interface SelectionParam extends ParamBase { type: 'selection'; default: SelectionValue | null }

/**
 * A colour as `#rrggbb` (`#rrggbbaa` when `alpha` is true). `palette` lists colours a host can offer as swatches; with `only_palette` the
 * value must be one of them (a shop's own filament colours, say).
 */
export interface ColorParam extends ParamBase { type: 'color'; default: string; alpha?: boolean; palette?: string[]; only_palette?: boolean }

/** The fields a group or a list row can hold: any single-valued parameter. */
export type FieldParam = BoolParam | IntParam | FloatParam | StringParam | EnumParam | VectorParam | AngleParam | AssetParam | PayloadParam | PartParam | RangeParam | SelectionParam | ColorParam

/** Several fields kept together as one value (an object), shown as a box with a title: "Outline", "Layer settings". Cannot hold a list, a group or a placement. */
export interface ObjectParam extends ParamBase { type: 'object'; default: Record<string, unknown>; fields: FieldParam[] }


/** A parameter of a row in a list: any parameter except another list. A row may hold a placement (several clicked points: a list of rows that each hold one), which the person sets by clicking on the model. */
export type ItemParam = FieldParam | ObjectParam | PlacementParam

/** A list of rows, each with the same fields (for example texture layers, each with its own image, strength and mask). */
export interface ListParam extends ParamBase { type: 'list'; default: Array<Record<string, unknown>>; item: ItemParam[]; min_items?: number; max_items?: number; item_label?: string }

export type ParamDef = BoolParam | IntParam | FloatParam | StringParam | EnumParam | VectorParam | AngleParam | AssetParam | PayloadParam | PlacementParam | PartParam | RangeParam | SelectionParam | ListParam | ColorParam | ObjectParam 

export const PARAM_TYPES = ['bool', 'int', 'float', 'string', 'enum', 'vector', 'angle', 'asset', 'payload', 'placement', 'part', 'range', 'selection', 'list', 'color', 'object'] as const
export type ParamType = (typeof PARAM_TYPES)[number]

export interface Operation {
  /** `^[a-z][a-z0-9_]*$`. */
  id: string
  title?: string
  kind: OperationKind
  /**
   * Where the operation sits in the host's "Add a step" menu. Well known: `prepare` (repair, clean up), `shape` (basic shape changes), `style` (an artistic restyling of the whole model), `surface` (put something on the surface),
   * `check` (analyse without changing). Any other id is shown as its own group. Absent: `check` for an analyzer, else `shape`.
   */
  category?: string
  /** The name of an icon from the host's icon set for the step list and the menu (`^[a-z][a-z0-9_-]*$`). Absent or unknown: the host's own icon for the operation, else a neutral one. */
  icon?: string
  /**
   * A short line under the step's name, as a template over its parameters: `{{angle}}°`, `{{percent}} %`. Numbers are rounded to two decimals. Left out, or when a
   * parameter it names has no value: the host shows no line.
   */
  summary?: string
  /**
   * How much the operation matters in the "Add a step" menu: `low` ones (a check, plumbing like `store` and `load`) are folded into a "More" group when the menu is long.
   * Absent: `normal`.
   */
  importance?: 'normal' | 'low'
  /** May the designer hand some parameters of this operation to the customer? */
  personalisable?: 'never' | 'optional' | 'always'
  params: ParamDef[]
  /** Collapsible sections of the panel; a parameter names its section with `section`. (Not the mesh's groups, which are distinct parts.) */
  sections?: Array<{ id: string; title?: string; collapsed?: boolean }>
  /** Stage names for progress reporting. */
  stages?: string[]
  inputs?: { mesh?: { required?: boolean } }
  /**
   * The kind of thing this operation takes and returns (`^[a-z][a-z0-9_]*$`): `mesh` (default) or `drawing`, or a kind the host registered. `out` defaults to `in`,
   * so a modifier of drawings says `{ "in": "drawing" }` and an extrusion says `{ "in": "drawing", "out": "mesh" }`. A generator has no input, so only `out` counts for it.
   * The runner refuses a step whose input is of another kind (`input.wrong_kind`) and a result of another kind than `out` (`plugin.bad_output`).
   * `*` means whatever passes through: a step with `in: '*'` takes any kind, and `out: '*'` (the default then) returns the kind it received. Only the built-in `store` operation uses it.
   */
  payload?: { in?: string; out?: string }
  /** `closed`: the result must be a closed solid when the input was (the engine checks it after the run). */
  outputs?: {
    mesh?: boolean; report?: boolean; closed?: boolean
    /** Segments this operation creates: a fixed name, or `{ param }` when the value of a parameter names it. */
    segments?: Array<string | { param: string }>
    /** Groups (distinct parts) this operation creates, named the same way. */
    groups?: Array<string | { param: string }>
    /**
     * What it does not carry through. Everything else is kept (SPEC.md section 5.1). A later step that names a dropped part cannot find it.
     * `'segments'` / `'groups'`: every part of that kind. `{ param }`: the one part that the `part` parameter names (the value says which kind,
     * or the parameter's own `kinds`). `{ param, keep: true }`: every part of the named part's kind EXCEPT that one (an operation that keeps only it).
     */
    drops?: Array<'segments' | 'groups' | { param: string; keep?: boolean }>
  }
  /** What this operation can take and produce. A plugin knows its own cost; the host's general budget still applies on top. */
  limits?: OperationLimits
}

export interface OperationLimits {
  /** The mesh going in may have at most this many triangles. */
  max_input_triangles?: number
  /** The mesh coming out may have at most this many triangles (a texture can multiply them). */
  max_output_triangles?: number
  /** The mesh going in or out may take at most this much memory (positions and indices), in MiB. */
  max_memory_mb?: number
}

/** Contact details of a plugin's maker. All optional; `url` is an https address, `email` an address, `name` plain text up to 80 characters. */
export interface PluginContact { url?: string; email?: string; name?: string }

/** The example picture of a plugin. */
export interface PluginImage { file: string; alt: string }

export interface Manifest {
  manifest_version: 1
  /** Reverse-domain id, e.g. `nl.microfabriek.core`. */
  id: string
  name: string
  /** Semver, `major.minor.patch`. */
  version: string
  /** What the plugin does, in plain text of 10 to 300 characters. Required for every external package and every built-in plugin (see `validateManifest`). */
  description?: string
  /** The name of an icon from the host's icon set (`^[a-z][a-z0-9_-]*$`) for the plugin as a whole: a menu that folds a plugin's operations into one row shows it. Optional. */
  icon?: string
  author?: string
  /** An SPDX identifier such as `MIT`, `Apache-2.0` or `GPL-3.0-only`, or the word `Proprietary` (1 to 64 characters). Required like `description`. */
  license?: string
  /** Who to ask about this plugin. Every field is optional; shown as text and as a link (https URL) or a mail link (email) in the plugin manager. */
  contact?: PluginContact
  /**
   * Where the packed `.amplugin` can be fetched again, an https URL of at most 300 characters. Optional. With it the plugin manager can offer
   * "Check for update" (only when the person clicks; nothing is fetched in the background).
   */
  package_url?: string
  /** An example picture for the plugin gallery: `file` is a path inside the package (a built-in plugin: inside the app), `alt` describes it in 5 to 160 characters. PNG, JPEG or WebP, up to 300 KB and 1600 x 1200 px, at least 200 px wide. Optional. */
  image?: PluginImage
  /**
   * Ids this plugin replaces: the plugin was published under one of them before. A step saved with such an id runs with this plugin (its settings go through `migrate`, which gets the old
   * version), and a host can tell the person which plugin replaces a missing one. Up to 8 plugin ids, none of them this plugin's own. An id that is itself installed is never renamed.
   * The new version must be higher than the highest old one. Optional.
   */
  replaces?: string[]
  /** What the plugin asks for beyond computing on meshes, for example `network:https://example.org`. Shown to the user before a package runs. */
  permissions?: string[]
  /**
   * Host services the plugin calls beyond `ctx.assets`: `fonts` for `ctx.fonts.outline(...)` (letter outlines made by the host). A host that does not offer
   * a service refuses the step with a clear message (`plugin.needs_fonts`) instead of failing in the middle of the run. Optional.
   */
  uses?: Array<'fonts'>
  operations: Operation[]
}

export function optionValues(p: EnumParam): string[] {
  return p.options.map(o => (typeof o === 'string' ? o : o.value))
}
