// Small render images of meshes (for sample cards and lists): one hidden viewer draws them one after the other, so a page of twelve samples
// costs one WebGL context, not twelve. A host without WebGL gets no images and shows the names only.
import { useEffect, useState } from 'react'
import type { Mesh } from '@ateliermesh/core'
import { loadViewer } from '@ateliermesh/ui'
import { STILL_LOOK, STILL_LOOK_LIGHT, isSoftwareWebGL } from '@ateliermesh/ui'
import type { Finish, ThreeModule, ViewerOptions } from '@ateliermesh/ui'

export interface ThumbnailSource {
  id: string
  /** The model to draw; may be calculated (a sample with its steps applied). `null`: no image. */
  mesh: () => Mesh | null | Promise<Mesh | null>
  /** Identifies what the image shows (a hash of the sample's definition). With a `cache` in the options, an image drawn before for this key is used instead of drawing again. */
  key?: string
}

/** Somewhere to remember finished images between visits (the standalone keeps them in IndexedDB). Both calls may fail: that only means no cache. */
export interface ThumbnailCache { get(key: string): Promise<Blob | undefined>; set(key: string, png: Blob): Promise<void> }

/** `color`: the colour of the model as `#rrggbb` (default the viewer's grey). A cache key should include it when it changes. */
export interface ThumbnailOptions { width?: number; height?: number; color?: string; finish?: Finish; /** `auto`: `high` on a device with a graphics card, and on one that draws in software (no card) the same picture with a small shadow and no multisampling. */ quality?: 'draft' | 'high' | 'auto' | 'light'; isCancelled?: () => boolean; cache?: ThumbnailCache }

type Viewer = ReturnType<Awaited<ReturnType<typeof loadViewer>>['createViewer']>

// one hidden viewer at a time: a second picture waits for the first, so quick repeated calls (a Save pressed twice) never hold two contexts and two shadow maps
let queue: Promise<unknown> = Promise.resolve()
const alone = <R>(f: () => Promise<R>): Promise<R> => { const run = queue.then(f, f); queue = run.catch(() => undefined); return run }
const yieldToPage = (): Promise<void> => new Promise(r => setTimeout(r, 0))

/** One hidden viewer, kept out of sight, for as long as `f` runs. A host without WebGL gets `null` and shows names only. */
const withHiddenViewer = <R>(three: ThreeModule, w: number, h: number, look: Pick<ThumbnailOptions, 'color' | 'finish' | 'quality'>, f: (viewer: Viewer) => Promise<R>): Promise<R | null> => alone(() => hiddenViewer(three, w, h, look, f))
async function hiddenViewer<R>(three: ThreeModule, w: number, h: number, look: Pick<ThumbnailOptions, 'color' | 'finish' | 'quality'>, f: (viewer: Viewer) => Promise<R>): Promise<R | null> {
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:${w}px;height:${h}px;pointer-events:none`
  document.body.append(host)
  let viewer: Viewer | null = null
  try {
    const high: ViewerOptions = look.quality === 'high' || (look.quality === 'auto' && !isSoftwareWebGL()) ? STILL_LOOK : look.quality === 'auto' || look.quality === 'light' ? STILL_LOOK_LIGHT : {}   // studio light, a soft shadow, tone mapping: for pictures drawn once
    viewer = (await loadViewer()).createViewer(three, host, { background: null, plate: false, axes: false, maxPixelRatio: 1, ...high, ...(look.color ? { color: look.color } : {}), ...(look.finish ? { finish: look.finish } : {}) })
    return await f(viewer)
  } catch { return null } finally { viewer?.dispose(); host.remove() }
}

const draw = async (viewer: Viewer, m: Mesh, view: 'iso' | 'front' | 'top' = 'iso'): Promise<Blob> => { viewer.setMesh(m, { fit: true }); viewer.setView(view); viewer.resize(); return viewer.snapshot('image/png') }

/** Draws the sources one after the other and hands every PNG over as soon as it exists. */
export async function renderThumbnailBlobs(three: ThreeModule, items: ThumbnailSource[], opts: ThumbnailOptions & { onImage?: (id: string, png: Blob) => void } = {}): Promise<Record<string, Blob>> {
  const out: Record<string, Blob> = {}
  const emit = (id: string, png: Blob): void => { out[id] = png; opts.onImage?.(id, png) }
  const pending: ThumbnailSource[] = []
  for (const it of items) {   // what was drawn before comes straight from the cache
    let hit: Blob | undefined
    if (opts.cache && it.key) { try { hit = await opts.cache.get(it.key) } catch { hit = undefined } }
    if (hit) emit(it.id, hit); else pending.push(it)
  }
  if (pending.length === 0) return out
  await withHiddenViewer(three, opts.width ?? 320, opts.height ?? 220, opts, async viewer => {
    for (const it of pending) {
      if (opts.isCancelled?.()) break
      let m: Mesh | null = null
      try { m = await it.mesh() } catch { m = null }
      if (!m || opts.isCancelled?.()) continue
      const png = await draw(viewer, m)
      emit(it.id, png)
      await yieldToPage()   // the page can paint and answer between two pictures
      if (opts.cache && it.key) { try { await opts.cache.set(it.key, png) } catch { /* no cache, no problem */ } }
    }
  })
  return out
}

/** The same as `renderThumbnailBlobs`, as object URLs (the caller revokes them). */
export async function renderThumbnails(three: ThreeModule, items: ThumbnailSource[], opts: ThumbnailOptions & { onImage?: (id: string, url: string) => void } = {}): Promise<Record<string, string>> {
  const { onImage, ...rest } = opts
  const out: Record<string, string> = {}
  await renderThumbnailBlobs(three, items, { ...rest, onImage: (id, png) => { const url = URL.createObjectURL(png); out[id] = url; onImage?.(id, url) } })
  return out
}

/** The preview picture for a project: the isometric view of `mesh`, transparent, plate and axes off, as PNG bytes (480 x 320 unless told otherwise). `color` (`#rrggbb`) paints the model, for example the chosen filament. `null` without WebGL.
 *  `quality: 'auto'` is `high` where the device has a graphics card and a lighter version of it (same size and framing, a small shadow, no multisampling) where it draws in software; `quality: 'light'` always draws the lighter one, without the check.
 *  `quality: 'high'` draws it with studio light, a soft shadow on the floor, neutral tone mapping and satin plastic, and 1024 x 683 unless told otherwise; `finish` (`matte`, `satin`, `gloss`) sets the surface. Without them the picture is the same as in 0.2.3. */
export async function renderPreviewPng(three: ThreeModule, mesh: Mesh, size: { width?: number; height?: number; color?: string; finish?: Finish; quality?: 'draft' | 'high' | 'auto' | 'light'; /** The side it is seen from: the isometric view (default), the front or the top. */ view?: 'iso' | 'front' | 'top' } = {}): Promise<Uint8Array | null> {
  const high = size.quality === 'high' || size.quality === 'auto' || size.quality === 'light'
  const png = await withHiddenViewer(three, size.width ?? (high ? 1024 : 480), size.height ?? (high ? 683 : 320), size, viewer => draw(viewer, mesh, size.view))
  return png ? new Uint8Array(await png.arrayBuffer()) : null
}

/** The images appear one by one as soon as the list is drawn; `null` three (not loaded yet) gives none. */
export function useThumbnails(three: ThreeModule | null, items: ThumbnailSource[], key: string, cache?: ThumbnailCache): Record<string, string> {
  const [images, setImages] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!three || items.length === 0) return
    let gone = false
    let made: Record<string, string> = {}
    void renderThumbnails(three, items, { isCancelled: () => gone, ...(cache ? { cache } : {}), onImage: (id, url) => { if (!gone) setImages(prev => ({ ...prev, [id]: url })) } }).then(r => { made = r; if (gone) { for (const u of Object.values(r)) URL.revokeObjectURL(u) } })
    return () => { gone = true; for (const u of Object.values(made)) URL.revokeObjectURL(u) }
  }, [three, key])
  return images
}
