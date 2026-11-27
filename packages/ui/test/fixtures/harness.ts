// Runs in the browser. Exposes a small API on window for the test to call.
import * as THREE from 'three'
import { assignSegment } from '@ateliermesh/core'
import { lBracketMesh } from '@ateliermesh/core/testing'
import { createViewer } from '../../src/viewer'
import type { Viewer } from '../../src/viewer'

let viewer: Viewer | null = null
let lastClick: unknown = 'none'

const api = {
  start(): { webgl: boolean } {
    const el = document.createElement('div')
    el.style.cssText = 'width:400px;height:300px;position:absolute;left:0;top:0'
    document.body.style.margin = '0'
    document.body.appendChild(el)
    viewer = createViewer(THREE, el, { background: '#ffffff' })
    // an asymmetric part; the first top-facing triangles are labelled "text" and coloured red
    let m = lBracketMesh()
    const flags = new Uint8Array(m.indices.length / 3)
    for (let t = 0; t < flags.length; t++) {
      const z = [0, 1, 2].map(k => m.positions[3 * (m.indices[3 * t + k] as number) + 2] as number)
      if (z.every(v => v === 10)) flags[t] = 1
    }
    m = assignSegment(m, 'text', flags, '#cc2222')
    viewer.setMesh(m)
    viewer.camera.updateMatrixWorld()
    viewer.renderer.render(viewer.scene, viewer.camera)
    viewer.snapshot() // a first draw
    return { webgl: viewer.renderer.getContext() !== null }
  },
  /** Pick at the canvas centre and at a corner (the sky). */
  picks() {
    const v = viewer as Viewer
    // look straight down so the top face is under the centre
    return { centre: v.pick(200, 150), corner: v.pick(2, 2) }
  },
  /** A flat sheet of 120 000 triangles (above the viewer's spatial-index threshold), looked at from above. */
  bigPick() {
    const v = viewer as Viewer
    const n = 245, size = 60
    const positions = new Float64Array(3 * (n + 1) * (n + 1)), indices = new Uint32Array(6 * n * n)
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { const k = 3 * (j * (n + 1) + i); positions[k] = (i / n) * size; positions[k + 1] = (j / n) * size; positions[k + 2] = 5 }
    let q = 0
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1; indices.set([a, b, d, a, d, c], q); q += 6 }
    v.setMesh({ positions, indices })
    const c = v.renderer.domElement
    const fire = (type: string, x: number, y: number): void => { c.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, pointerId: 1 })) }
    fire('pointerdown', 200, 150); fire('pointermove', 200, 550); fire('pointerup', 200, 550)
    const t0 = performance.now(); const first = v.pick(200, 150); const tFirst = performance.now() - t0
    const t1 = performance.now(); for (let i = 0; i < 20; i++) v.pick(150 + i, 120 + i); const tNext = (performance.now() - t1) / 20
    // the same clicks through three.js's own raycaster, for comparison
    const g = new THREE.BufferGeometry()
    const view = new Float32Array(positions.length); for (let k = 0; k < positions.length; k += 3) { view[k] = positions[k] as number; view[k + 1] = positions[k + 2] as number; view[k + 2] = -(positions[k + 1] as number) }
    g.setAttribute('position', new THREE.BufferAttribute(view, 3)); g.setIndex(new THREE.BufferAttribute(indices, 1))
    const ref = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
    const rc = new THREE.Raycaster(); const r = c.getBoundingClientRect()
    const t2 = performance.now(); let same = true
    for (let i = 0; i < 20; i++) {
      const x = 150 + i, y = 120 + i
      rc.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -(((y - r.top) / r.height) * 2 - 1)), v.camera)
      const h = rc.intersectObject(ref, false)[0], mine = v.pick(x, y)
      if (!h || !mine || Math.abs(h.point.y - (mine.point[2] as number)) > 1e-3 || Math.abs(h.point.x - (mine.point[0] as number)) > 1e-3) same = false
    }
    const tThreeAll = (performance.now() - t2) / 20
    return { hit: first, triangles: indices.length / 3, tFirst, tNext, tThreeAll, same }
  },
  lookDown() {
    const v = viewer as Viewer
    // the orbit state is internal; use pointer drags to rotate, like a user
    const c = v.renderer.domElement
    const fire = (type: string, x: number, y: number): void => { c.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, pointerId: 1 })) }
    fire('pointerdown', 200, 150); fire('pointermove', 200, 150 + 400); fire('pointerup', 200, 150 + 400)
  },
  click() {
    const v = viewer as Viewer
    v.onPick(hit => { lastClick = hit })
    const c = v.renderer.domElement
    const fire = (type: string): void => { c.dispatchEvent(new PointerEvent(type, { clientX: 200, clientY: 150, button: 0, bubbles: true, pointerId: 2 })) }
    fire('pointerdown'); fire('pointerup')
    return lastClick
  },
  /** Two fingers moving apart: the camera comes closer. Returns the distance before and after. */
  async pinch() {
    const v = viewer as Viewer
    const c = v.renderer.domElement
    const d = (): number => v.camera.position.length()
    const before = d()
    const fire = (type: string, id: number, x: number, y: number): void => { c.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, pointerId: id, pointerType: 'touch' })) }
    fire('pointerdown', 11, 180, 150); fire('pointerdown', 12, 220, 150)
    fire('pointermove', 11, 100, 150); fire('pointermove', 12, 300, 150)
    fire('pointerup', 11, 100, 150); fire('pointerup', 12, 300, 150)
    await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    return { before, after: d() }
  },
  /** Grab a handle placed on the model and drag it: the callbacks get the surface under the finger, orbit does not start. */
  async handle() {
    const v = viewer as Viewer
    const c = v.renderer.domElement
    const log: Array<string | null> = []
    const spot: [number, number, number] = [30, 5, 10]
    const h = v.addHandle(spot, { onDrag: hit => { log.push(hit ? `hit z=${hit.point[2].toFixed(1)}` : 'none') }, onEnd: () => { log.push('end') } })
    const camBefore = v.camera.position.toArray().join(',')
    const p = new THREE.Vector3(spot[0], spot[2], -spot[1]).project(v.camera)
    const r = c.getBoundingClientRect()
    const x = r.left + ((p.x + 1) / 2) * r.width, y = r.top + ((1 - p.y) / 2) * r.height
    const fire = (type: string, px: number, py: number): void => { c.dispatchEvent(new PointerEvent(type, { clientX: px, clientY: py, button: 0, bubbles: true, pointerId: 21, pointerType: 'touch' })) }
    fire('pointerdown', x + 8, y - 6)      // a finger a few pixels off
    fire('pointermove', x - 40, y + 5)
    fire('pointerup', x - 40, y + 5)
    await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    h.remove()
    return { log, orbitMoved: camBefore !== v.camera.position.toArray().join(',') }
  },
  highlight() { (viewer as Viewer).highlight([0, 1, 2]); return true },
  overlay() {
    const v = viewer as Viewer
    const off = v.addOverlay(({ three, toView }) => {
      const g = new three.Mesh(new three.SphereGeometry(1), new three.MeshBasicMaterial({ color: 0x00ff00 }))
      const p = toView([20, 10, 10]); g.position.set(p[0], p[1], p[2])
      return g
    })
    const group = v.scene.children.find(c => c.type === 'Group') as THREE.Group
    const n = group.children.length
    off()
    return { added: n, after: group.children.length }
  },
  async snapshot() {
    const v = viewer as Viewer
    const blob = await v.snapshot()
    const buf = new Uint8Array(await blob.arrayBuffer())
    // count non-white pixels of the 2D copy to prove something was drawn
    const bmp = await createImageBitmap(blob)
    const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height
    const cx = cv.getContext('2d') as CanvasRenderingContext2D
    cx.drawImage(bmp, 0, 0)
    const d = cx.getImageData(0, 0, cv.width, cv.height).data
    let drawn = 0, red = 0
    for (let i = 0; i < d.length; i += 4) { if (d[i]! < 250 || d[i + 1]! < 250 || d[i + 2]! < 250) drawn++; if (d[i]! > 150 && d[i + 1]! < 80 && d[i + 2]! < 80) red++ }
    return { size: buf.length, magic: Array.from(buf.slice(0, 4)), width: bmp.width, height: bmp.height, drawn, red }
  },
  dispose() { (viewer as Viewer).dispose(); return document.querySelectorAll('canvas').length },
}
;(window as unknown as { __t: typeof api }).__t = api
