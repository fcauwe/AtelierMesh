// The one place where the engine's coordinates meet three.js. The engine is Z-up, in millimetres (SPEC section 5).
// three.js is Y-up. The view rotates the model by -90 degrees about X: view = (x, z, -y). It is a rotation, so triangle winding and
// normals keep their meaning. Nothing else in this package, or in a host, converts axes.
export type Vec3 = [number, number, number]

export const toView = (p: Vec3): Vec3 => [p[0], p[2], 0 - p[1]]
export const fromView = (p: Vec3): Vec3 => [p[0], 0 - p[2], p[1]]
