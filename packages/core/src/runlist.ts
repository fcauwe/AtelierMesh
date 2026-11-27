// Running a step list headlessly: no document, no history, no keyboard. A host that shows a preview, a customer overlay or makes the quote files runs "this list on this
// model with this store" and wants the same behaviour as the editor: the same preparation of steps, the rollback marker, the budgets. `createRunner` is that glue once;
// the editor's session hook (`useProjectSession` in @ateliermesh/react) runs through it too.
import { applyColourMap } from './colours'
import type { ColourMap } from './colours'
import { MemoryCache } from './cache'
import type { ResultCache } from './cache'
import { followEarlierSteps } from './placement'
import type { PluginHost } from './host'
import type { Registry } from './registry'
import { runWorkflow } from './runner'
import type { WorkflowResult } from './runner'
import type { StepList } from './stack'
import { DEFAULT_STORE_LIMITS } from './store'
import type { ProjectStore, StoreLimits } from './store'
import type { AssetResolver, Mesh, Quality } from './types'
import type { FontService } from './host'

export interface RunnerRuntime {
  registry: Registry
  host: PluginHost
  /** Default: a new `MemoryCache` for this runner. Share one cache between runners that run the same lists. */
  cache?: ResultCache
  assets: AssetResolver
  fonts?: FontService
  /** The most triangles a step may start from. */
  maxTriangles: number
  /** The budget of the store. Default: `DEFAULT_STORE_LIMITS` (20 items, 10 MB). */
  storeLimits?: StoreLimits
  /** Plugins that are still loading: a run waits for this before it starts, so a step of a plugin that is not there yet does not fail with `step.unknown_plugin`. */
  ready?: Promise<unknown>
}

export interface RunListOptions {
  /** What the steps start from. Absent when the first step is a generator. */
  source?: Mesh | null
  /** The project's store, for the steps that take a stored item. */
  store?: ProjectStore
  /** The steps after this one are not run (the editor's "up to this step"). */
  rollback?: string | null
  /** Default `export`: the full-quality result. The editor's live view asks for `preview`. */
  quality?: Quality
  /**
   * Several colours: apply a colour map to the final mesh (`applyColourMap`) and give each slot the colour the host chose (`{ slotId: { color } }`). Previews, the customer's screen, pictures
   * and files use the default mode `preview`, where every part is in a slot: with no map or the default one the whole model is one segment, painted in the viewer's body colour. The editor
   * asks for `edit`, where parts no slot has stay visible as their own. The per-step results (and the cache) are the steps' own and are not changed.
   */
  colours?: { map: ColourMap; colours?: Record<string, { color: string }>; mode?: 'edit' | 'preview' }
  signal?: AbortSignal
  onProgress?: (stepId: string, stage: string, fraction: number) => void
}

export interface Runner {
  runList(list: StepList, o?: RunListOptions): Promise<WorkflowResult>
  readonly cache: ResultCache
}

export function createRunner(rt: RunnerRuntime): Runner {
  const cache = rt.cache ?? new MemoryCache()
  return {
    cache,
    async runList(list, o = {}) {
      if (rt.ready) await rt.ready
      const at = o.rollback ? list.steps.findIndex(s => s.id === o.rollback) : -1
      const visible = at >= 0 ? { ...list, steps: list.steps.slice(0, at + 1) } : list
      const result = await runWorkflow(visible, {
        registry: rt.registry, host: rt.host, cache, assets: rt.assets, ...(rt.fonts ? { fonts: rt.fonts } : {}), prepareStep: followEarlierSteps(),
        source: o.source ?? null, store: o.store ?? {}, quality: o.quality ?? 'export', ...(o.signal ? { signal: o.signal } : {}), ...(o.onProgress ? { onProgress: o.onProgress } : {}),
        limits: { maxTriangles: rt.maxTriangles, ...(rt.storeLimits ?? DEFAULT_STORE_LIMITS) },
      })
      if (!o.colours || !result.mesh) return result
      const mesh = applyColourMap(result.mesh, o.colours.map, { mode: o.colours.mode ?? 'preview', ...(o.colours.colours ? { colours: o.colours.colours } : {}) })
      return { ...result, mesh, ...(result.payload === result.mesh ? { payload: mesh } : {}) }
    },
  }
}
