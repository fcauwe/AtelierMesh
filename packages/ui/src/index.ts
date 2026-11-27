// @ateliermesh/ui. The viewer is loaded on demand: `await loadViewer()` fetches it in its own chunk, so a page that never
// shows a model does not pay for it. three.js is never imported here; the host passes its own instance to `createViewer`.
export { toView, fromView } from './coords'
export type { Vec3 } from './coords'
export { STILL_LOOK, STILL_LOOK_LIGHT, isSoftwareWebGL } from './look'
export type { Finish, Viewer, ViewerOptions, PickResult, OverlayApi, ThreeModule, Handle, HandleCallbacks } from './viewer'
export const loadViewer = (): Promise<typeof import('./viewer')> => import('./viewer')
export { partColor, triangleColors, BODY_COLOR } from './colors'
export * from './problems'
export { creaseNormals } from './normals'
