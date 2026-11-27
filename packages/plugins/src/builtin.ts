// Every first-party plugin in one place, so a host (the Atelier, the standalone app, a worker, a server) registers them with one call
// and does not need to know the list. A new first-party plugin is added here and nowhere else in the host.
import { STORE_PLUGIN_ID, STORE_PLUGIN_VERSION, storePlugin } from '@ateliermesh/core'
import type { PluginEntry, Registry } from '@ateliermesh/core'
import { CORE_PLUGIN_ID, CORE_PLUGIN_VERSION, corePlugin } from './core-plugin'
import { DEFORM_PLUGIN_ID, DEFORM_PLUGIN_VERSION, deformPlugin } from './deform-plugin'
import { HOLES_PLUGIN_ID, HOLES_PLUGIN_VERSION, holesPlugin } from './holes-plugin'
import { HOLLOW_PLUGIN_ID, HOLLOW_PLUGIN_VERSION, hollowPlugin } from './hollow-plugin'
import { LOWPOLY_PLUGIN_ID, LOWPOLY_PLUGIN_VERSION, lowpolyPlugin } from './lowpoly-plugin'
import { PARTS_PLUGIN_ID, PARTS_PLUGIN_VERSION, partsPlugin } from './parts-plugin'
import { PRINTCHECK_PLUGIN_ID, PRINTCHECK_PLUGIN_VERSION, printcheckPlugin } from './printcheck-plugin'
import { REPAIR_PLUGIN_ID, REPAIR_PLUGIN_VERSION, repairPlugin } from './repair-plugin'
import { TEXTURE_PLUGIN_ID, TEXTURE_PLUGIN_VERSION, texturePlugin } from './texture-plugin'
import { VORONOI_PLUGIN_ID, VORONOI_PLUGIN_VERSION, voronoiPlugin } from './voronoi-plugin'

export interface BuiltInPlugin { id: string; version: string; entry: () => PluginEntry }

/** The first-party plugins, in the order they are registered (and therefore listed in the "Add a step" menu groups). */
export const BUILT_IN_PLUGINS: readonly BuiltInPlugin[] = [
  { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION, entry: corePlugin },
  { id: STORE_PLUGIN_ID, version: STORE_PLUGIN_VERSION, entry: storePlugin },
  { id: REPAIR_PLUGIN_ID, version: REPAIR_PLUGIN_VERSION, entry: repairPlugin },
  { id: PARTS_PLUGIN_ID, version: PARTS_PLUGIN_VERSION, entry: partsPlugin },
  { id: DEFORM_PLUGIN_ID, version: DEFORM_PLUGIN_VERSION, entry: deformPlugin },
  { id: LOWPOLY_PLUGIN_ID, version: LOWPOLY_PLUGIN_VERSION, entry: lowpolyPlugin },
  { id: VORONOI_PLUGIN_ID, version: VORONOI_PLUGIN_VERSION, entry: voronoiPlugin },
  { id: TEXTURE_PLUGIN_ID, version: TEXTURE_PLUGIN_VERSION, entry: texturePlugin },
  { id: HOLLOW_PLUGIN_ID, version: HOLLOW_PLUGIN_VERSION, entry: hollowPlugin },
  { id: HOLES_PLUGIN_ID, version: HOLES_PLUGIN_VERSION, entry: holesPlugin },
  { id: PRINTCHECK_PLUGIN_ID, version: PRINTCHECK_PLUGIN_VERSION, entry: printcheckPlugin },
]

export interface BuiltInOptions {
  /** Register only these plugin ids. */
  only?: readonly string[]
  /** Register every plugin except these ids (a host that does not want a heavy plugin yet). Use the same options on the page and in the worker. */
  except?: readonly string[]
}

/** The plugins an options object selects. */
export function selectBuiltInPlugins(opts: BuiltInOptions = {}): BuiltInPlugin[] {
  return BUILT_IN_PLUGINS.filter(p => (!opts.only || opts.only.includes(p.id)) && !(opts.except ?? []).includes(p.id))
}

/** Registers every first-party plugin on the registry and returns it. Use the same call in the page and in the worker. */
export function registerBuiltInPlugins<R extends Registry>(registry: R, opts: BuiltInOptions = {}): R {
  for (const p of selectBuiltInPlugins(opts)) registry.register(p.entry())
  return registry
}
