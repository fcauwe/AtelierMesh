// The plugin module: one default export with a `run` function for all the plugin's operations.
import { MeshError } from '@ateliermesh/core'
import type { PluginModule } from '@ateliermesh/core'
import { mirror } from './src/mirror'
import type { MirrorParams } from './src/mirror'

export default {
  async run(op, ctx) {
    if (op !== 'mirror') throw new MeshError('step.unknown_op', { op })
    if (!ctx.mesh) throw new MeshError('input.missing_mesh', { op })
    ctx.progress('mirror', 0)
    const r = mirror(ctx.mesh, ctx.params as unknown as MirrorParams, () => ctx.signal.aborted)
    ctx.progress('mirror', 1)
    return r
  },
} satisfies PluginModule
