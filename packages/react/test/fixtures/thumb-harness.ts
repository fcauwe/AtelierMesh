import * as THREE from 'three'
import { renderPreviewPng } from '../../src/thumbnails'
import { gridBox } from '../../../plugins/test/parts'

/** Average colour of the opaque pixels of a PNG made with the given model colour. */
;(window as unknown as { __colour: (c?: string) => Promise<number[] | null> }).__colour = async c => {
  const png = await renderPreviewPng(THREE as never, gridBox(20, 20, 20, 1, 1, 1), { width: 160, height: 120, ...(c ? { color: c } : {}) })
  if (!png) return null
  const bmp = await createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' }))
  const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height
  const g = cv.getContext('2d')!; g.drawImage(bmp, 0, 0)
  const d = g.getImageData(0, 0, cv.width, cv.height).data
  let r = 0, gg = 0, b = 0, n = 0
  for (let i = 0; i < d.length; i += 4) if ((d[i + 3] as number) > 200) { r += d[i] as number; gg += d[i + 1] as number; b += d[i + 2] as number; n++ }
  return n === 0 ? [0, 0, 0] : [r / n, gg / n, b / n]
}

import { isSoftwareWebGL } from '@ateliermesh/ui'
type Auto = { software: boolean; sizes: number[][]; many: number }
/** `auto` on this device, two pictures asked at once, and many pictures one after the other (each must let go of its context). */
;(window as unknown as { __auto: () => Promise<Auto> }).__auto = async () => {
  const size = async (png: Uint8Array | null): Promise<number[]> => { if (!png) return []; const b = await createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' })); return [b.width, b.height] }
  const mesh = gridBox(20, 20, 20, 1, 1, 1)
  const [a, b] = await Promise.all([renderPreviewPng(THREE as never, mesh, { quality: 'auto' }), renderPreviewPng(THREE as never, mesh, { quality: 'auto', width: 200, height: 100 })])
  let many = 0
  for (let i = 0; i < 24; i++) if (await renderPreviewPng(THREE as never, mesh, { width: 64, height: 48 })) many++
  return { software: isSoftwareWebGL(), sizes: [await size(a), await size(b), await size(await renderPreviewPng(THREE as never, mesh, { quality: 'light' }))], many }
}
