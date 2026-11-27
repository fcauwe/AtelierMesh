// The look for stored pictures. Kept apart from the viewer so a host can read it without loading the viewer chunk.
import type { ViewerOptions } from './viewer'

/** The cheap version of `STILL_LOOK` for a device that draws in software: the same light and finish, a small soft shadow, no multisampling. */
export const STILL_LOOK_LIGHT = { environment: 'studio', shadow: true, toneMapping: 'neutral', finish: 'satin', quality: 'draft', antialias: false } as const satisfies ViewerOptions
/** The look for a stored picture: studio light, a soft shadow, neutral tone mapping, satin plastic and a fine shadow map. */
export const STILL_LOOK = { environment: 'studio', shadow: true, toneMapping: 'neutral', finish: 'satin', quality: 'high' } as const satisfies ViewerOptions

/** The names a software renderer gives itself (SwiftShader in Chromium, llvmpipe and lavapipe on Linux, Apple's and Microsoft's software renderers). */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render|mesa offscreen/i

let software: boolean | undefined
/**
 * `true` when the browser has WebGL but only in software (no graphics card: a CI runner, an old phone, a virtual machine). Two signals, either is enough: the renderer names itself
 * (`WEBGL_debug_renderer_info`: SwiftShader, llvmpipe, ...), or the browser refuses a context asked for with `failIfMajorPerformanceCaveat`. The second alone is not enough: a
 * current Chromium hands out that context on SwiftShader too (found in the Atelier's CI, 0.4.3). Where the browser hides the name and does not refuse, the answer is `false`: use
 * `quality: 'light'` to ask for the light picture without the check. `false` also when WebGL is missing (the caller finds that out itself). The answer is remembered.
 */
export function isSoftwareWebGL(): boolean {
  if (software !== undefined) return software
  software = false
  try {
    const get = (o: WebGLContextAttributes): WebGLRenderingContext | null => { const c = document.createElement('canvas'); return (c.getContext('webgl2', o) ?? c.getContext('webgl', o)) as WebGLRenderingContext | null }
    const fast = get({ failIfMajorPerformanceCaveat: true }), gl = fast ?? get({})
    if (!gl) return software
    const info = gl.getExtension('WEBGL_debug_renderer_info')
    const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : ''
    software = !fast || SOFTWARE_RENDERER.test(name)   // refused the fast one, or names itself a software renderer
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  } catch { software = false }
  return software
}
