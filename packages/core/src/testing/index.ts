// Test helpers: small meshes with known measurements, and a plugin that exercises the engine.
export { boxMesh, cylinderMesh, lBracketMesh, sphereMesh } from './meshes'
export { createTestPlugin, testManifest, TEST_PLUGIN_ID } from './plugin'
export type { TestPlugin } from './plugin'
export { createShapesPlugin, shapesManifest, SHAPES_PLUGIN_ID } from './shapes'
