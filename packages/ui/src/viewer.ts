// The viewer. It receives the host's own three.js module, so there is never a second copy in the bundle.
// It shows an engine mesh (Z-up, mm), orbits, fits, colours segments, answers pick requests (point, normal, triangle, segment),
// draws highlights and host overlays, and takes a PNG snapshot. Rendering happens on demand, not every frame.
import type * as THREE from 'three'
import { buildBvh, segmentTable } from '@ateliermesh/core'
import type { Bvh, Mesh } from '@ateliermesh/core'
import { fromView, toView } from './coords'
import { BODY_COLOR, triangleColors } from './colors'
import { creaseNormals } from './normals'
import type { Vec3 } from './coords'

/** From this many triangles a click uses a spatial index instead of testing every triangle. */
const BVH_FROM = 50_000

function triangleNormal(m: Mesh, t: number): Vec3 {
  const P = m.positions, T = m.indices
  const a = 3 * (T[3 * t] as number), b = 3 * (T[3 * t + 1] as number), c = 3 * (T[3 * t + 2] as number)
  const ux = (P[b] as number) - (P[a] as number), uy = (P[b + 1] as number) - (P[a + 1] as number), uz = (P[b + 2] as number) - (P[a + 2] as number)
  const vx = (P[c] as number) - (P[a] as number), vy = (P[c + 1] as number) - (P[a + 1] as number), vz = (P[c + 2] as number) - (P[a + 2] as number)
  const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx
  const l = Math.hypot(x, y, z) || 1
  return [x / l, y / l, z / l]
}

export type ThreeModule = typeof THREE

export interface ViewerOptions {
  /** CSS colour of the model body (segment 0). Default a light grey. */
  color?: string
  /** CSS colour of the background, or null for a transparent canvas. */
  background?: string | null
  /** Pixel ratio cap. Default 2. */
  maxPixelRatio?: number
  /** Draw the build plate: a grid (10 mm squares, 50 mm for big parts) under the lowest point of the model. Default true. */
  plate?: boolean
  /** Draw the small X / Y / Z gizmo in the corner (X red, Y green, Z blue; Z is up). Default true. */
  axes?: boolean
  /**
   * Draw a ruler along the X and the Y direction on the build plate, in millimetres. It starts at the front left corner of the model's footprint (0 mm), runs to the far edge of the
   * plate, and has a number at every few ticks (X red, Y green, as in the gizmo). It measures the model, not the coordinates of the file. Default false. Change it later with `setGuides`.
   */
  ruler?: boolean
  /** Smooth shading: curved surfaces look smooth, edges sharper than `creaseAngle` stay crisp. Default true (flat shading above two million triangles). */
  smooth?: boolean
  /** Edges sharper than this many degrees stay sharp when smooth shading is on. Default 35. */
  creaseAngle?: number
  /** Image-based lighting. `'studio'` is a small photo studio built in code (soft boxes above and at the sides, no download); plastic then gets soft gradients and highlights that move when the model is turned. A host can pass its own texture (equirectangular or a ready cube map). Default none: the two plain lights of 0.2.x. If the device cannot make it, the viewer carries on without. */
  environment?: 'studio' | THREE.Texture | null
  /** How shiny the surface is: `matte`, `satin` or `gloss` (a physical material with a clear coat). Default none: the plain material of 0.2.x. Change it later with `setFinish`. */
  finish?: Finish
  /** A soft shadow on the plate under the model. It is drawn on a transparent canvas too (only the shadow shows). Default false. */
  shadow?: boolean
  /** Keeps bright light from washing out the filament colour. `neutral` leaves colours as they are until they get very bright; `aces` is the film look. Default `none`. */
  toneMapping?: 'none' | 'neutral' | 'aces'
  /** `high` is for stills drawn once: a finer shadow. Default `draft` (light enough for a phone). */
  quality?: 'draft' | 'high'
  /** Smooth the edges with multisampling. Default true; a still picture on a device without a graphics card draws without it (much cheaper there). */
  antialias?: boolean
}

export type Finish = 'matte' | 'satin' | 'gloss'

const FINISHES: Record<Finish, { roughness: number; clearcoat: number; clearcoatRoughness: number }> = {
  matte: { roughness: 0.85, clearcoat: 0, clearcoatRoughness: 0.5 },
  satin: { roughness: 0.5, clearcoat: 0.15, clearcoatRoughness: 0.45 },
  gloss: { roughness: 0.28, clearcoat: 0.8, clearcoatRoughness: 0.08 },
}

export interface PickResult {
  /** Where the ray hit, in engine coordinates (mm, Z up). */
  point: Vec3
  /** Face normal at the hit, in engine coordinates, unit length. */
  normal: Vec3
  /** Index of the triangle in `mesh.indices`. */
  triangle: number
  /** Name of the segment of that triangle, or null when the mesh has none. */
  segment: string | null
  distance: number
}

/** What an overlay builder gets: the host's three module and the one conversion from engine to view coordinates. */
export interface OverlayApi {
  three: ThreeModule
  toView: (p: Vec3) => Vec3
}

export interface HandleCallbacks {
  /** While the handle is held: what lies under the pointer (null off the model). */
  onDrag(hit: PickResult | null, ev: PointerEvent): void
  onEnd?(): void
}

export interface Handle {
  /** Engine coordinates. */
  position: Vec3
  cb: HandleCallbacks
  /** Move the grip; pass the surface normal too when the grip lies flat on the surface (see `addHandle`). */
  setPosition(p: Vec3, normal?: Vec3): void
  remove(): void
}

export interface Viewer {
  setMesh(mesh: Mesh | null, opts?: { fit?: boolean }): void
  fit(): void
  /** Look at the model from a fixed side: the usual 3D angle, the front (from -Y), the top or the right-hand side. Keeps the model in frame. */
  /** Show or hide the build plate, the axes gizmo and the ruler. */
  setGuides(guides: { plate?: boolean; axes?: boolean; ruler?: boolean }): void
  setView(name: 'iso' | 'front' | 'top' | 'side'): void
  /** Move the camera closer (factor < 1) or further away (factor > 1). */
  zoom(factor: number): void
  setColor(css: string): void
  /** Change how shiny the surface is (see `ViewerOptions.finish`). `null` goes back to the plain material. */
  setFinish(finish: Finish | null): void
  /** Ask what lies under a screen position (client coordinates). */
  pick(clientX: number, clientY: number): PickResult | null
  /** Where an engine point is on the screen, in client coordinates; null when it is behind the camera. */
  project(p: Vec3): { x: number; y: number } | null
  /** Called for a click that was not a drag. Returns the function that removes the listener. */
  onPick(cb: (hit: PickResult | null, ev: PointerEvent) => void): () => void
  /** Colour these triangles on top of the model. Pass null to clear. */
  highlight(triangles: ArrayLike<number> | null, css?: string): void
  /** Add a host object to the scene, built in view coordinates through `api.toView`. Returns the function that removes it. */
  addOverlay(build: (api: OverlayApi) => THREE.Object3D): () => void
  /** A round grip that stays the same size on screen and can be dragged by mouse or finger (24 px reach). It is picked before the model, so orbit does not start. */
  addHandle(position: Vec3, cb: HandleCallbacks, opts?: { color?: string; opacity?: number; normal?: Vec3 }): Handle
  /** A picture of the canvas as it is now (a PNG by default). The ruler is not in it. */
  snapshot(type?: string): Promise<Blob>
  resize(): void
  requestRender(): void
  dispose(): void
  readonly camera: THREE.PerspectiveCamera
  readonly scene: THREE.Scene
  readonly renderer: THREE.WebGLRenderer
}


/** A small photo studio for reflections: a dim room with a big soft box above and smaller ones at the sides and in front (y is up). */
function studioRoom(T: ThreeModule): THREE.Scene {
  const room = new T.Scene()
  room.add(new T.Mesh(new T.BoxGeometry(20, 20, 20), new T.MeshBasicMaterial({ color: new T.Color().setScalar(0.28), side: T.BackSide })))
  const box = (w: number, h: number, x: number, y: number, z: number, intensity: number): void => {
    const m = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ color: new T.Color().setScalar(intensity), side: T.DoubleSide }))
    m.position.set(x, y, z); m.lookAt(0, 0, 0); room.add(m)
  }
  box(12, 12, 0, 9.5, 0, 2.4)     // top
  box(6, 10, -9.5, 2, 3, 3)       // left key
  box(4, 8, 9.5, 1, -2, 1.6)      // right fill
  box(10, 3, 0, 0, 9.5, 1.6)      // front strip
  box(8, 2, 0, 3, -9.5, 2.5)      // back rim
  return room
}

export function createViewer(three: ThreeModule, container: HTMLElement, options: ViewerOptions = {}): Viewer {
  const T = three
  const renderer = new T.WebGLRenderer({ antialias: options.antialias !== false, alpha: options.background === null })
  renderer.setPixelRatio(Math.min(options.maxPixelRatio ?? 2, globalThis.devicePixelRatio || 1))
  if (options.background !== null) renderer.setClearColor(new T.Color(options.background ?? '#f4f4f5'), 1)
  else renderer.setClearColor(0x000000, 0)
  const canvas = renderer.domElement
  canvas.style.display = 'block'
  canvas.style.touchAction = 'none'
  container.appendChild(canvas)

  const scene = new T.Scene()
  const camera = new T.PerspectiveCamera(40, 1, 0.1, 10000)
  const studio = options.environment !== undefined && options.environment !== null
  const hemi = new T.HemisphereLight(0xffffff, 0x888899, studio ? 0.25 : 1.2)
  const headlight = new T.DirectionalLight(0xffffff, studio ? 0.7 : 2.2)
  scene.add(hemi, headlight, headlight.target)
  const tm = { none: T.NoToneMapping, neutral: T.NeutralToneMapping, aces: T.ACESFilmicToneMapping }[options.toneMapping ?? 'none']
  renderer.toneMapping = tm
  const overlays = new T.Group()
  scene.add(overlays)
  const handles = new Set<Handle>()
  const handleMeshes = new Map<Handle, THREE.Mesh>()

  let bodyColor = options.color ?? BODY_COLOR
  const makeMaterial = (f: Finish | null): THREE.MeshStandardMaterial => f
    ? new T.MeshPhysicalMaterial({ vertexColors: true, metalness: 0, side: T.DoubleSide, ...FINISHES[f] })
    : new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.65, metalness: 0.05, side: T.DoubleSide })
  let material = makeMaterial(options.finish ?? null)
  const highlightMaterial = new T.MeshBasicMaterial({ color: 0xffd400, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: T.DoubleSide })
  let model: THREE.Mesh | null = null
  let bvh: Bvh | null = null
  let current: Mesh | null = null
  let highlightMesh: THREE.Mesh | null = null
  let radius = 50
  const target = new T.Vector3()
  let yaw = Math.PI / 4, pitch = Math.PI / 5, dist = 150
  let dirty = true, raf = 0, disposed = false

  const requestRender = (): void => {
    if (dirty && raf !== 0) return
    dirty = true
    if (raf === 0 && !disposed) raf = requestAnimationFrame(draw)
  }
  function placeCamera(): void {
    const cp = Math.cos(pitch)
    camera.position.set(target.x + dist * cp * Math.sin(yaw), target.y + dist * Math.sin(pitch), target.z + dist * cp * Math.cos(yaw))
    camera.lookAt(target)
    headlight.position.copy(camera.position)
    headlight.target.position.copy(target)
  }
  function render(): void {
    placeCamera()
    for (const [h, m] of handleMeshes) { const v = toView(h.position); m.position.set(v[0], v[1], v[2]); m.scale.setScalar(dist * 0.022) } // constant size on screen
    camera.near = Math.max(0.01, dist - radius * 4)
    camera.far = dist + radius * 8
    camera.updateProjectionMatrix()
    renderer.render(scene, camera)
    if (showAxes) drawGizmo()
  }
  function draw(): void { raf = 0; dirty = false; if (!disposed) render() }

  function resize(): void {
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight)
    renderer.setSize(w, h, false)
    canvas.style.width = '100%'; canvas.style.height = '100%'
    camera.aspect = w / h
    requestRender()
  }

  function colorsFor(mesh: Mesh): Float32Array {
    const nt = mesh.indices.length / 3
    const out = new Float32Array(nt * 9)
    const { palette, index } = triangleColors(mesh, bodyColor)
    const colours = palette.map(c => new T.Color(c))
    for (let t = 0; t < nt; t++) {
      const c = colours[index[t] as number] as THREE.Color
      for (let k = 0; k < 3; k++) { out[9 * t + 3 * k] = c.r; out[9 * t + 3 * k + 1] = c.g; out[9 * t + 3 * k + 2] = c.b }
    }
    return out
  }

  function geometryFor(mesh: Mesh, triangles?: ArrayLike<number>): THREE.BufferGeometry {
    const n = triangles ? triangles.length : mesh.indices.length / 3
    const pos = new Float32Array(n * 9)
    for (let i = 0; i < n; i++) {
      const t = triangles ? (triangles[i] as number) : i
      for (let k = 0; k < 3; k++) {
        const v = mesh.indices[3 * t + k] as number
        const p = toView([mesh.positions[3 * v] as number, mesh.positions[3 * v + 1] as number, mesh.positions[3 * v + 2] as number])
        pos[9 * i + 3 * k] = p[0]; pos[9 * i + 3 * k + 1] = p[1]; pos[9 * i + 3 * k + 2] = p[2]
      }
    }
    const g = new T.BufferGeometry()
    g.setAttribute('position', new T.BufferAttribute(pos, 3))
    if (options.smooth !== false && mesh.indices.length / 3 <= 2_000_000 && !triangles) {
      // one normal per corner from the faces around the vertex (within the crease angle); the engine's coordinates are turned into the view's like the positions
      const nrm = creaseNormals(mesh.positions, mesh.indices, options.creaseAngle ?? 35)
      for (let i = 0; i < nrm.length; i += 3) { const v = toView([nrm[i] as number, nrm[i + 1] as number, nrm[i + 2] as number]); nrm[i] = v[0]; nrm[i + 1] = v[1]; nrm[i + 2] = v[2] }
      g.setAttribute('normal', new T.BufferAttribute(nrm, 3))
    } else g.computeVertexNormals() // non-indexed: flat normals, one per triangle
    return g
  }

  function clearModel(): void {
    clearHighlight()
    bvh = null
    if (model) { scene.remove(model); model.geometry.dispose(); model = null }
  }
  function clearHighlight(): void {
    if (highlightMesh) { scene.remove(highlightMesh); highlightMesh.geometry.dispose(); highlightMesh = null }
  }

  /**
   * A new model without a re-fit (an edit of the one on screen): the camera stays where it is, but the zoom limits follow the model's size. When the size
   * changed a lot (the first mesh was a small original and the result is much bigger, or the other way round) the view is framed again, so the whole model
   * is in view and can be zoomed out and in.
   */
  function keepFraming(): void {
    if (!model) return
    model.geometry.computeBoundingSphere()
    const s = model.geometry.boundingSphere
    if (!s) return
    const r = Math.max(s.radius, 1e-3)
    if (r > radius * 2 || r < radius / 2) { fit(); return }
    radius = r
  }

  function fit(): void {
    if (!model) return
    model.geometry.computeBoundingSphere()
    const s = model.geometry.boundingSphere
    if (!s) return
    target.copy(s.center)
    radius = Math.max(s.radius, 1e-3)
    dist = radius / Math.sin((camera.fov * Math.PI) / 360) * 1.1 * (showRuler ? RULER_ROOM : 1)   // the ruler lies outside the model: some room for it
    placeShadow()
    requestRender()
  }

  // -------------------------------------------------------------------- pointer: orbit, pan, zoom, click
  const raycaster = new T.Raycaster()
  const listeners = new Set<(hit: PickResult | null, ev: PointerEvent) => void>()
  let drag: { x: number; y: number; startX: number; startY: number; t0: number; button: number; shift: boolean } | null = null
  // touch: two fingers pinch to zoom and pan; one finger orbits; a handle can be grabbed first
  const pointers = new Map<number, { x: number; y: number }>()
  let pinch: { d: number; mx: number; my: number } | null = null
  let grabbed: Handle | null = null

  const screenOf = (p: Vec3): { x: number; y: number } | null => {
    const r = canvas.getBoundingClientRect()
    const v = new T.Vector3(...toView(p)).project(camera)
    if (v.z > 1) return null
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }
  }
  const panBy = (dx: number, dy: number): void => {
    const h = Math.max(1, container.clientHeight)
    const k = (2 * dist * Math.tan((camera.fov * Math.PI) / 360)) / h
    const right = new T.Vector3().setFromMatrixColumn(camera.matrix, 0), up = new T.Vector3().setFromMatrixColumn(camera.matrix, 1)
    target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k)
  }
  const grabAt = (x: number, y: number): Handle | null => {
    let best: Handle | null = null, bestD = 24 // pixels: a finger is not precise
    for (const h of handles) { const s = screenOf(h.position); if (s) { const d = Math.hypot(s.x - x, s.y - y); if (d < bestD) { bestD = d; best = h } } }
    return best
  }

  const onDown = (e: PointerEvent): void => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    try { canvas.setPointerCapture(e.pointerId) } catch { /* not supported for synthetic events */ }
    if (pointers.size === 2) {
      const [p, q] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }]
      pinch = { d: Math.hypot(p.x - q.x, p.y - q.y), mx: (p.x + q.x) / 2, my: (p.y + q.y) / 2 }
      drag = null; grabbed = null
      return
    }
    const h = e.button === 0 ? grabAt(e.clientX, e.clientY) : null
    if (h) { grabbed = h; h.cb.onDrag(pick(e.clientX, e.clientY), e); return }
    drag = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, t0: e.timeStamp, button: e.button, shift: e.shiftKey }
  }
  const onMove = (e: PointerEvent): void => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinch && pointers.size >= 2) {
      const [p, q] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }]
      const d = Math.hypot(p.x - q.x, p.y - q.y), mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2
      if (pinch.d > 0 && d > 0) dist = Math.max(radius * 0.2, Math.min(radius * 40, dist * (pinch.d / d)))
      panBy(mx - pinch.mx, my - pinch.my)
      pinch = { d, mx, my }
      requestRender()
      return
    }
    if (grabbed) { grabbed.cb.onDrag(pick(e.clientX, e.clientY), e); return }
    if (!drag) return
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y
    drag.x = e.clientX; drag.y = e.clientY
    if (drag.button === 2 || drag.shift) panBy(dx, dy)
    else {
      yaw -= dx * 0.008
      pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitch + dy * 0.008))
    }
    requestRender()
  }
  const onUp = (e: PointerEvent): void => {
    pointers.delete(e.pointerId)
    if (pointers.size < 2) pinch = null
    if (grabbed) { const g = grabbed; grabbed = null; g.cb.onEnd?.(); return }
    const d = drag
    drag = null
    if (!d) return
    const moved = Math.hypot(e.clientX - d.startX, e.clientY - d.startY)
    if (moved < 4 && e.timeStamp - d.t0 < 600 && d.button === 0 && listeners.size > 0) {
      const hit = pick(e.clientX, e.clientY)
      for (const cb of [...listeners]) cb(hit, e)
    }
  }
  const onCancel = (e: PointerEvent): void => { pointers.delete(e.pointerId); pinch = null; drag = null; if (grabbed) { const g = grabbed; grabbed = null; g.cb.onEnd?.() } }
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    dist = Math.max(radius * 0.2, Math.min(radius * 40, dist * Math.exp(e.deltaY * 0.001)))
    requestRender()
  }
  const noMenu = (e: Event): void => e.preventDefault()
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointercancel', onCancel)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('contextmenu', noMenu)

  function pick(clientX: number, clientY: number): PickResult | null {
    if (!model || !current) return null
    const r = canvas.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return null
    const ndc = new T.Vector2(((clientX - r.left) / r.width) * 2 - 1, -(((clientY - r.top) / r.height) * 2 - 1))
    placeCamera(); camera.updateMatrixWorld(); camera.updateProjectionMatrix()
    raycaster.setFromCamera(ndc, camera)
    let point: Vec3, nrm: Vec3, triangle: number, distance: number
    if (current.indices.length / 3 >= BVH_FROM) {
      // big mesh: a spatial index, built on the first click and kept until the mesh changes (three.js would test every triangle)
      bvh ??= buildBvh(current)
      const ray = raycaster.ray
      const o = fromView([ray.origin.x, ray.origin.y, ray.origin.z]), d = fromView([ray.direction.x, ray.direction.y, ray.direction.z])
      const hit = bvh.raycast(o, d)
      if (!hit) return null
      triangle = hit.triangle; distance = hit.distance
      point = [o[0] + d[0] * distance, o[1] + d[1] * distance, o[2] + d[2] * distance]
      nrm = triangleNormal(current, triangle)
    } else {
      const hit = raycaster.intersectObject(model, false)[0]
      if (!hit || hit.faceIndex == null || !hit.face) return null
      const n = hit.face.normal
      triangle = hit.faceIndex; distance = hit.distance
      nrm = fromView([n.x, n.y, n.z])
      point = fromView([hit.point.x, hit.point.y, hit.point.z])
    }
    return {
      point,
      normal: nrm,
      triangle,
      segment: current.segments ? (segmentTable(current)[current.segments.labels[triangle] as number]?.name ?? null) : null,
      distance,
    }
  }

  // ---- the build plate (a grid under the lowest point, where a slicer puts the part) and the axes gizmo in the corner
  let showPlate = options.plate !== false, showAxes = options.axes !== false, showRuler = options.ruler === true
  const RULER_ROOM = 1.3
  const plate = new T.Group(); plate.visible = false; scene.add(plate)
  // the ruler: two lines with ticks and numbers on the plate, along X (red, in front of the model) and Y (green, left of it), from the front left corner of the footprint
  const ruler = new T.Group(); ruler.visible = false; scene.add(ruler)
  const rulerTextures = new Map<string, THREE.CanvasTexture>()   // one picture per text, kept while the viewer lives
  let plateInfo: { x0: number; y0: number; cx: number; cy: number; size: number; step: number } | null = null
  const rulerText = (text: string, color: string): THREE.CanvasTexture => {
    const key = `${color}|${text}`
    let tex = rulerTextures.get(key)
    if (!tex) {
      const cv = document.createElement('canvas'); cv.width = 128; cv.height = 64
      const g = cv.getContext('2d')
      if (g) {
        g.font = 'bold 34px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round'
        g.lineWidth = 7; g.strokeStyle = 'rgba(255,255,255,0.92)'; g.strokeText(text, 64, 34)   // a light edge keeps the number readable on the plate and on the model
        g.fillStyle = color; g.fillText(text, 64, 34)
      }
      tex = new T.CanvasTexture(cv); rulerTextures.set(key, tex)
    }
    return tex
  }
  function clearRuler(): void {
    for (const c of [...ruler.children]) { ruler.remove(c); const o = c as unknown as { geometry?: { dispose(): void }; material?: { dispose(): void } }; o.geometry?.dispose(); o.material?.dispose() }
  }
  function buildRuler(): void {
    clearRuler()
    if (!plateInfo) { ruler.visible = false; return }
    const { x0, y0, cx, cy, size, step } = plateInfo
    const xEnd = cx + size / 2, yEnd = cy + size / 2   // the far edges of the plate
    const m = size * 0.03, minor = m * 0.6, major = m * 1.2
    const lh = size * 0.04, lw = lh * 2
    const ticks = Math.max(1, Math.floor(Math.max(xEnd - x0, yEnd - y0) / step))
    const every = Math.max(1, Math.ceil(ticks / 8))   // a number at most at eight places
    const local = (ex: number, ey: number): [number, number, number] => [ex - cx, 0.06, -(ey - cy)]
    const axis = (dir: 'x' | 'y', color: string, textColor: string, name: string): void => {
      const start = dir === 'x' ? x0 : y0, end = dir === 'x' ? xEnd : yEnd
      const base = (dir === 'x' ? y0 : x0) - m   // the line lies just outside the footprint
      const pts: number[] = []
      const at = (along: number, across: number): [number, number, number] => (dir === 'x' ? local(along, across) : local(across, along))
      pts.push(...at(start, base), ...at(end, base))
      for (let i = 0; start + i * step <= end + 1e-6; i++) {
        const along = start + i * step, long = i % every === 0
        pts.push(...at(along, base), ...at(along, base - (long ? major : minor)))
        if (long) {
          const s = new T.Sprite(new T.SpriteMaterial({ map: rulerText(String(i * step), textColor), depthTest: true, depthWrite: false, transparent: true }))
          const p = dir === 'x' ? at(along, base - major - lh * 0.6) : at(along, base - major - lw * 0.55)
          s.position.set(p[0], p[1], p[2]); s.scale.set(lw, lh, 1); s.renderOrder = 10; ruler.add(s)
        }
      }
      const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(pts, 3))
      const lines = new T.LineSegments(g, new T.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false }))
      lines.renderOrder = 9; ruler.add(lines)
      const n = new T.Sprite(new T.SpriteMaterial({ map: rulerText(`${name} mm`, textColor), depthTest: true, depthWrite: false, transparent: true }))
      // the name stands at the origin end, next to the 0 (the far end can be outside the frame)
      const np = dir === 'x' ? at(start - lw * 0.75, base - major - lh * 0.6) : at(start - lh * 0.9, base - major - lw * 0.55 - lh * 0.1)
      n.position.set(np[0], np[1], np[2]); n.scale.set(lw, lh, 1); n.renderOrder = 10; ruler.add(n)
    }
    axis('x', '#e5484d', '#b4232a', 'X'); axis('y', '#30a46c', '#17693f', 'Y')
    ruler.position.copy(plate.position)   // the same place as the plate: its centre, at the lowest point of the model
    ruler.visible = showRuler
  }
  function rebuildPlate(mesh: Mesh | null): void {
    for (const c of [...plate.children]) { plate.remove(c); const o = c as unknown as { geometry?: { dispose(): void }; material?: { dispose(): void } }; o.geometry?.dispose(); o.material?.dispose() }
    if (!mesh || mesh.positions.length === 0) { plate.visible = false; plateInfo = null; clearRuler(); ruler.visible = false; return }
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i] as number, y = mesh.positions[i + 1] as number, z = mesh.positions[i + 2] as number
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z
    }
    const ext = Math.max(x1 - x0, y1 - y0, 1), step = ext > 200 ? 50 : ext > 40 ? 10 : 5
    const size = Math.max(2, Math.ceil((ext * 1.6) / step)) * step
    const grid = new T.GridHelper(size, size / step, 0x8a8f98, 0xb4b8bf)
    const gm = grid.material as THREE.Material; gm.transparent = true; gm.opacity = 0.7; gm.depthWrite = false
    const fill = new T.Mesh(new T.PlaneGeometry(size, size), new T.MeshBasicMaterial({ color: 0x9ca3af, transparent: true, opacity: 0.18, side: T.DoubleSide, depthWrite: false }))
    fill.rotation.x = -Math.PI / 2; fill.position.y = -0.02
    plate.add(fill, grid)
    const c = toView([(x0 + x1) / 2, (y0 + y1) / 2, z0])
    plate.position.set(c[0], c[1], c[2])
    plate.visible = showPlate
    floor.set(c[0], c[1], c[2])
    plateInfo = { x0, y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, size, step }
    if (showRuler) buildRuler(); else { clearRuler(); ruler.visible = false }
  }

  // ---- looks: studio light, a soft shadow on the floor. Each part is optional and a device that cannot do it simply goes without.
  const floor = new T.Vector3()
  let envTexture: THREE.Texture | null = null, ownEnv = false
  if (options.environment !== undefined && options.environment !== null) {
    try {
      const pmrem = new T.PMREMGenerator(renderer)
      if (options.environment === 'studio') {
        const room = studioRoom(T)
        envTexture = pmrem.fromScene(room, 0.03).texture; ownEnv = true
        room.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose() })
      } else if (options.environment.mapping === T.EquirectangularReflectionMapping || options.environment.mapping === T.EquirectangularRefractionMapping) {
        envTexture = pmrem.fromEquirectangular(options.environment).texture; ownEnv = true
      } else envTexture = options.environment
      pmrem.dispose()
      scene.environment = envTexture
      scene.environmentIntensity = 1
    } catch { envTexture = null; scene.environment = null; hemi.intensity = 1.2; headlight.intensity = 2.2 }
  }
  let keyLight: THREE.DirectionalLight | null = null, catcher: THREE.Mesh | null = null
  if (options.shadow) {
    try {
      const size = options.quality === 'high' ? 4096 : 1024
      renderer.shadowMap.enabled = true
      renderer.shadowMap.type = T.VSMShadowMap
      keyLight = new T.DirectionalLight(0xffffff, 0.6)
      keyLight.castShadow = true
      keyLight.shadow.mapSize.set(size, size)
      keyLight.shadow.radius = options.quality === 'high' ? 18 : 6
      keyLight.shadow.blurSamples = options.quality === 'high' ? 25 : 12
      keyLight.shadow.bias = -0.0004
      catcher = new T.Mesh(new T.PlaneGeometry(1, 1), new T.ShadowMaterial({ color: 0x000000, opacity: 0.32, toneMapped: false }))
      catcher.rotation.x = -Math.PI / 2; catcher.receiveShadow = true; catcher.visible = false
      scene.add(keyLight, keyLight.target, catcher)
    } catch { keyLight = null; catcher = null; renderer.shadowMap.enabled = false }
  }
  /** Puts the shadow light above the model and the floor catcher under it, sized to the model. */
  function placeShadow(): void {
    if (!keyLight || !catcher || !model) return
    const r = radius, c = target
    keyLight.position.set(c.x - r * 0.7, c.y + r * 4, c.z + r * 0.8)
    keyLight.target.position.copy(c)
    const cam = keyLight.shadow.camera
    cam.left = -r * 2.2; cam.right = r * 2.2; cam.top = r * 2.2; cam.bottom = -r * 2.2; cam.near = r * 0.5; cam.far = r * 9
    cam.updateProjectionMatrix()
    catcher.scale.setScalar(r * 6)
    catcher.position.set(floor.x, floor.y + 0.01, floor.z)
    catcher.visible = true
  }
  const gizmoScene = new T.Scene()
  const gizmoCamera = new T.PerspectiveCamera(35, 1, 0.1, 20)
  const label = (text: string, color: string): THREE.Sprite => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 64
    const g = cv.getContext('2d')
    if (g) { g.font = 'bold 44px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = color; g.fillText(text, 32, 34) }
    const sp = new T.Sprite(new T.SpriteMaterial({ map: new T.CanvasTexture(cv), depthTest: false, transparent: true }))
    sp.scale.set(0.5, 0.5, 0.5); return sp
  }
  for (const [dir, color, name] of [[[1, 0, 0], '#e5484d', 'X'], [[0, 0, -1], '#30a46c', 'Y'], [[0, 1, 0], '#3b82f6', 'Z']] as Array<[number[], string, string]>) {
    const v = new T.Vector3(dir[0], dir[1], dir[2])
    gizmoScene.add(new T.ArrowHelper(v, new T.Vector3(0, 0, 0), 1, new T.Color(color).getHex(), 0.25, 0.14))
    const l = label(name, color); l.position.copy(v.clone().multiplyScalar(1.32)); gizmoScene.add(l)
  }
  function drawGizmo(): void {
    const w = container.clientWidth, h = container.clientHeight
    const s = Math.round(Math.min(110, Math.max(64, Math.min(w, h) * 0.22)))
    gizmoCamera.position.copy(camera.position).sub(target).normalize().multiplyScalar(5.6)
    gizmoCamera.up.copy(camera.up); gizmoCamera.lookAt(0, 0, 0)
    const auto = renderer.autoClear
    renderer.autoClear = false; renderer.clearDepth()
    renderer.setScissorTest(true); renderer.setViewport(10, 10, s, s); renderer.setScissor(10, 10, s, s)
    renderer.render(gizmoScene, gizmoCamera)
    renderer.setScissorTest(false); renderer.setViewport(0, 0, w, h); renderer.autoClear = auto
  }

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null
  ro?.observe(container)
  resize()

  return {
    setMesh(mesh, opts = {}) {
      clearModel()
      current = mesh
      rebuildPlate(mesh)
      if (mesh && mesh.indices.length > 0) {
        const g = geometryFor(mesh)
        g.setAttribute('color', new T.BufferAttribute(colorsFor(mesh), 3))
        model = new T.Mesh(g, material)
        model.castShadow = true
        scene.add(model)
        if (opts.fit !== false) fit()
        else keepFraming()
      }
      requestRender()
    },
    fit,
    setGuides(g) {
      if (g.plate !== undefined) { showPlate = g.plate; plate.visible = showPlate && plate.children.length > 0 }
      if (g.axes !== undefined) showAxes = g.axes
      if (g.ruler !== undefined && g.ruler !== showRuler) {
        showRuler = g.ruler
        if (showRuler) buildRuler(); else { clearRuler(); ruler.visible = false }
        if (plateInfo) dist = Math.min(Math.max(dist * (showRuler ? RULER_ROOM : 1 / RULER_ROOM), radius * 0.2), radius * 40)   // the ruler lies outside the model: step back a little, and back again
      }
      requestRender()
    },
    setView(name) {
      const v = { iso: [Math.PI / 4, Math.PI / 5], front: [0, 0], top: [0, Math.PI / 2 - 0.001], side: [Math.PI / 2, 0] }[name] as [number, number]
      yaw = v[0]; pitch = v[1]; fit()
    },
    zoom(factor) { dist = Math.min(Math.max(dist * factor, radius * 0.2), radius * 40); requestRender() },
    setFinish(f) {
      const old = material
      material = makeMaterial(f)
      if (model) model.material = material
      old.dispose()
      requestRender()
    },
    setColor(css) {
      bodyColor = css
      if (model && current) { model.geometry.setAttribute('color', new T.BufferAttribute(colorsFor(current), 3)); requestRender() }
    },
    pick,
    project(p) { placeCamera(); camera.updateMatrixWorld(); camera.updateProjectionMatrix(); return screenOf(p) },
    onPick(cb) { listeners.add(cb); return () => { listeners.delete(cb) } },
    highlight(triangles, css = '#ffd400') {
      clearHighlight()
      if (triangles && triangles.length > 0 && current) {
        highlightMaterial.color.set(css)
        highlightMesh = new T.Mesh(geometryFor(current, triangles), highlightMaterial)
        scene.add(highlightMesh)
      }
      requestRender()
    },
    addOverlay(build) {
      const obj = build({ three: T, toView })
      overlays.add(obj)
      requestRender()
      return () => { overlays.remove(obj); requestRender() }
    },
    addHandle(position, cb, opts = {}) {
      // with a surface normal the grip is a flat disc lying on the surface (it is hidden by what is in front of it); without one it is a sphere drawn on top
      const flat = opts.normal !== undefined
      const mesh = new T.Mesh(
        flat ? new T.CircleGeometry(1, 40) : new T.SphereGeometry(1, 16, 12),
        new T.MeshBasicMaterial({ color: opts.color ?? '#ff7a00', toneMapped: false, depthTest: flat, transparent: true, opacity: opts.opacity ?? 0.9, side: T.DoubleSide, ...(flat ? { depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 } : {}) }),
      )
      mesh.renderOrder = 10
      const face = (n: Vec3 | undefined): void => { if (!flat || !n) return; const v = toView(n); mesh.quaternion.setFromUnitVectors(new T.Vector3(0, 0, 1), new T.Vector3(v[0], v[1], v[2]).normalize()) }
      face(opts.normal)
      scene.add(mesh)
      const h: Handle = {
        position, cb,
        setPosition(p, n) { h.position = p; face(n); requestRender() },
        remove() { handles.delete(h); handleMeshes.delete(h); scene.remove(mesh); mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); requestRender() },
      }
      handles.add(h); handleMeshes.set(h, mesh); requestRender()
      return h
    },
    snapshot(type = 'image/png') {
      // the ruler is a tool for the screen, not part of the picture: leave it out, and the room made for it, so the picture is the same with or without it
      const withRuler = ruler.visible, before = dist
      if (withRuler) { ruler.visible = false; dist = dist / RULER_ROOM }
      render() // draw now, so the canvas holds the current image when it is read
      const blob = new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('snapshot failed'))), type))   // the canvas is read now
      if (withRuler) { ruler.visible = true; dist = before; requestRender() }
      return blob
    },
    resize,
    requestRender,
    dispose() {
      disposed = true
      if (raf !== 0) cancelAnimationFrame(raf)
      ro?.disconnect()
      canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onCancel); canvas.removeEventListener('wheel', onWheel); canvas.removeEventListener('contextmenu', noMenu)
      clearModel(); rebuildPlate(null); for (const t of rulerTextures.values()) t.dispose(); rulerTextures.clear(); material.dispose(); highlightMaterial.dispose()
      if (ownEnv) envTexture?.dispose()
      if (catcher) { catcher.geometry.dispose(); (catcher.material as THREE.Material).dispose() }
      keyLight?.shadow.map?.dispose()
      renderer.dispose(); renderer.forceContextLoss(); canvas.remove()   // the browser keeps about 16 contexts: let go of this one now, not when the garbage collector comes
    },
    camera, scene, renderer,
  }
}
