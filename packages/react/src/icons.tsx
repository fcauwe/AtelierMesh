// The small outline icons of the screens, drawn in the lucide style (24 px box, 1.5 stroke, round caps) and inlined, so a host needs no icon package.
// The Atelier uses lucide-react: it can ignore this file and pass its own icons where a prop takes a node.
import type { ReactElement } from 'react'

type Shape = string | [cx: number, cy: number, r: number]
const ICONS: Record<string, Shape[]> = {
  undo: ['M9 14 4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
  search: [[11, 11, 8], 'm21 21-4.3-4.3'],
  history: ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5', 'M12 7v5l4 2'],
  chevronRight: ['m9 18 6-6-6-6'],
  chevronDown: ['m6 9 6 6 6-6'],
  chevronUp: ['m18 15-6-6-6 6'],
  plug: ['M12 22v-5', 'M9 8V2', 'M15 8V2', 'M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z'],
  spline: [[19, 5, 2], [5, 19, 2], 'M5 17A12 12 0 0 1 17 5'],
  // the icons of the column switcher (lucide, ISC licence)
  listOrdered: ['M10 12h11', 'M10 18h11', 'M10 6h11', 'M4 10h2', 'M4 6h1v4', 'M6 18H4c0-1 2-2 2-3s-1-1.5-2-1'],
  palette: [[13.5, 6.5, 0.5], [17.5, 10.5, 0.5], [8.5, 7.5, 0.5], [6.5, 12.5, 0.5], 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z'],
  listChecks: ['m3 17 2 2 4-4', 'm3 7 2 2 4-4', 'M13 6h8', 'M13 12h8', 'M13 18h8'],
  printer: ['M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2', 'M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6', 'M7 14h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z'],
  trash: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'],
  upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm17 8-5-5-5 5', 'M12 3v12'],
  penTool: ['m12 19 7-7 3 3-7 7-3-3z', 'm18 13-1.5-7.5L2 2l3.5 14.5L13 18l5-5z', 'm2 2 7.586 7.586', [11, 11, 2]],
  archive: ['M3 3h18a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z', 'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8', 'M10 12h4'],
  archiveRestore: ['M3 3h18a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z', 'M4 8v11a2 2 0 0 0 2 2h2', 'M20 8v11a2 2 0 0 1-2 2h-2', 'm9 15 3-3 3 3', 'M12 12v9'],
  folderOpen: ['m6 14 1.5-2.9A2 2 0 0 1 9.3 10H20a2 2 0 0 1 1.9 2.7l-1.6 4.7A2 2 0 0 1 18.4 19H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H18a2 2 0 0 1 2 2v2'],
  redo: ['m15 14 5-5-5-5', 'M20 9H9.5a5.5 5.5 0 0 0 0 11H13'],
  recipe: ['M4 19.5V5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 1.5Z', 'M4 19.5A2 2 0 0 0 6 21.5h13V18', 'M9 7h6M9 11h6'],
  folder: ['M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'],
  settings: [[12, 12, 3], 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z'],
  github: ['M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1-.3-3.5 1.5-2.6-.5-5.4-.5-8 0C6 2 5 2.3 5 2.3c-.28 1.15-.28 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65S8.93 17.38 9 18v4', 'M9 18c-4.51 2-5-2-7-2'],
  moon: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z'],
  lock: ['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  sun: [[12, 12, 4], 'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4'],
  user: [[12, 7, 4], 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2'],
  plus: ['M5 12h14M12 5v14'],
  save: ['M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z', 'M17 21v-8H7v8M7 3v5h8'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3'],
  dots: [[12, 5, 1.3], [12, 12, 1.3], [12, 19, 1.3]],
  info: [[12, 12, 9], 'M12 16v-4M12 8h.01'],
  check: ['M20 6 9 17l-5-5'],
  book: ['M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20'],
  copy: ['M8 8h12v12H8z', 'M16 8V4H4v12h4'],
  external: ['M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  zoomIn: [[11, 11, 7], 'm21 21-4.3-4.3M11 8v6M8 11h6'],
  zoomOut: [[11, 11, 7], 'm21 21-4.3-4.3M8 11h6'],
  type: ['M4 7V4h16v3M9 20h6M12 4v16'],
  alert: ['M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01'],
  close: ['M18 6 6 18M6 6l12 12'],
  // the icons of the built-in operations and of common choices; a manifest names them (`icon: 'twist'`), kebab-case or camelCase
  resize: ['M3 17 17 3l4 4L7 21zM8 12l2 2M11 9l2 2M14 6l2 2'],
  rotate: ['M21 12a9 9 0 1 1-3-6.7M21 4v5h-5'],
  emboss: ['M5 6V4h14v2M12 4v16M9 20h6'],
  emboss_svg: ['M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.9L12 16.4 6.8 19.2l1-5.9L3.5 9.2l5.9-.9z'],
  decimate: ['M12 3 3 20h18zM12 3v17M7.5 11.5h9'],
  overhang: ['M12 3 2 20h20zM12 10v5M12 17.5v.5'],
  auto_orient: ['M12 20V5M6 11l6-6 6 6M5 20h14'],
  twist: ['M7 3c6 2 6 4 0 6s-6 4 0 6 6 4 0 6M17 3c-6 2-6 4 0 6s6 4 0 6-6 4 0 6'],
  bend: ['M5 21c0-9 3-14 14-14', 'M15 3l4 4-4 4'],
  wave: ['M2 12c3-8 5-8 8 0s5 8 8 0 3-5 4-4'],
  ripple: [[12, 12, 2], [12, 12, 6], [12, 12, 10]],
  taper: ['M5 4h14l-4 16H9zM9 20h6'],
  smooth: ['M3 17c3 0 3-10 6-10s3 10 6 10 3-10 6-10', 'M3 20h18'],
  texture: ['M3 17l3-3 3 3 3-3 3 3 3-3 3 3M3 12l3-3 3 3 3-3 3 3 3-3 3 3M3 7l3-3 3 3 3-3 3 3 3-3 3 3'],
  low_poly: ['M12 2 3 8l9 14 9-14zM3 8h18M12 2 8 8l4 14 4-14-4-6'],
  voronoi: ['M12 2l8 5v10l-8 5-8-5V7zM12 2v8M20 7l-8 3M4 7l8 3M12 10v12'],
  hollow: ['M4 4h16v16H4z', 'M9 9h6v6H9z'],
  printability: ['M9 4h6v3H9z', 'M9 5.5H6a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6.5a1 1 0 0 0-1-1h-3', 'm9 14 2 2 4-4'],
  hole: ['M3 7h18v10H3z', [12, 12, 3]],
  hole_round: [[12, 12, 6]],
  hole_slot: ['M8 7h8a5 5 0 0 1 0 10H8A5 5 0 0 1 8 7z'],
  hole_square: ['M6 6h12v12H6z'],
  cheese: ['M3 14 21 7v10H3z', [8, 14, 1.4], [14, 13, 1.1], [18, 12, 0.9]],
  repair_mesh: ['M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.2-.5-.5-2.2z'],
  delete_part: ['M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'],
  keep_part: ['M12 2 3 7v10l9 5 9-5V7zM3 7l9 5 9-5M12 12v10', 'M8 16l2.5 2.5L16 13'],
  box: ['M12 2 3 7v10l9 5 9-5V7zM3 7l9 5 9-5M12 12v10'],
  arrowUp: ['m5 12 7-7 7 7M12 19V5'],
  arrowDown: ['M12 5v14m7-7-7 7-7-7'],
  arrowLeft: ['m12 19-7-7 7-7M19 12H5'],
  arrowRight: ['M5 12h14m-7-7 7 7-7 7'],
  raised: ['m18 9-6-6-6 6M12 3v14M5 21h14'],
  engraved: ['M12 17V3m-6 6 6 6 6-6M19 21H5'],
  ruler: ['M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.4 2.4 0 0 1 0-3.4l2.6-2.6a2.4 2.4 0 0 1 3.4 0ZM14.5 12.5 16 11M11.5 9.5 13 8M8.5 6.5 10 5M17.5 15.5 19 14'],
  move: ['M12 2v20M2 12h20m-17-5-3 5 3 5M19 7l3 5-3 5M7 5l5-3 5 3M7 19l5 3 5-3'],
  // the icons of the example gallery (lucide, ISC licence)
  share: [[18, 5, 3], [6, 12, 3], [18, 19, 3], 'M8.59 13.51l6.83 3.98', 'M15.41 6.51l-6.82 3.98'],
  flag: ['M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z', 'M4 22v-7'],
  link: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'],
  sliders: ['M21 4h-7', 'M10 4H3', 'M21 12h-9', 'M8 12H3', 'M21 20h-5', 'M12 20H3', 'M14 2v4', 'M8 10v4', 'M16 18v4'],
  clock: [[12, 12, 10], 'M12 6v6l4 2'],
  refresh: ['M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16', 'M8 16H3v5'],
  puzzle: ['M19.4 12.6a2 2 0 0 1 0 2.8l-.6.6a2 2 0 0 0 0 2.8l-1.2 1.2a2 2 0 0 1-2.8 0l-.6-.6a2 2 0 0 0-2.8 0l-.6.6a2 2 0 0 1-2.8 0L6.8 19.4a2 2 0 0 1 0-2.8l.6-.6a2 2 0 0 0 0-2.8l-.6-.6a2 2 0 0 1 0-2.8l1.2-1.2a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 0 2.8 0l.6-.6a2 2 0 0 1 2.8 0l1.2 1.2a2 2 0 0 1 0 2.8Z'],
}

export type IconName = keyof typeof ICONS

/** A name from a manifest (`zoom-in`, `zoomIn`, `low_poly`) to the key of the set, or undefined when the set does not have it. */
export function iconKey(name: string | undefined): string | undefined {
  if (!name) return undefined
  if (ICONS[name]) return name
  const camel = name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
  return ICONS[camel] ? camel : undefined
}

/** An icon by the name a manifest gives; nothing when the set does not know it (a hint is never an error). */
export function NamedIcon({ name, size = 16 }: { name: string | undefined; size?: number }): ReactElement | null {
  const k = iconKey(name)
  return k ? <Icon name={k} size={size} /> : null
}

/** A picture a plugin draws itself: the `d` of an SVG path on a 24 x 24 grid, as an outline like the built-in icons (round line ends and joins). The manifest check lets only path data through. */
export function ShapeIcon({ d, size = 24, fill = false }: { d: string; size?: number; fill?: boolean }): ReactElement {
  return (
    <svg className="am-icon am-shape" viewBox="0 0 24 24" width={size} height={size} fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={d} /></svg>
  )
}

export function Icon({ name, size = 20 }: { name: IconName; size?: number }): ReactElement {
  return (
    <svg className="am-icon" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {(ICONS[name] ?? []).map((s, i) => (typeof s === 'string' ? <path key={i} d={s} /> : <circle key={i} cx={s[0]} cy={s[1]} r={s[2]} />))}
    </svg>
  )
}
