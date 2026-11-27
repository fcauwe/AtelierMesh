// Opening a model or a project, as a hook: read the file with progress, read an STL, 3MF or .amproj, ask the unit of an STL, offer to simplify a model that is too big,
// check that it is a closed solid and offer Repair, handle running out of memory, and hand the result to the host. The standalone app and the Atelier both use it, so they
// open a file in the same way and a fix is made once. The host keeps what is its own: where the model goes next, storage, and what to do about a project that needs
// plugins or fonts it does not have (`onProject`).
import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { DEFAULT_STORE_LIMITS, addStep, boundingSize, convertToMm, emptyStepList, loadProject, makeStep, measureMeshAsync, parseStlAsync, read3mf, unitHint } from '@ateliermesh/core'
import type { AssetUse, ColourMap, LoadProjectFonts, Mesh, PluginLockEntry, ProjectAsset, ProjectStore, Registry, StepList, Unit } from '@ateliermesh/core'
import { REPAIR_PLUGIN_ID, REPAIR_PLUGIN_VERSION, refreshSvgDrawings, repairManifest } from '@ateliermesh/plugins'
import type { T } from './common'
import { SimplifiedDialog, SimplifyingDialog } from './Loading'
import type { useLoading } from './Loading'
import { LoadCheckDialog, UnitsDialog } from './Pages'
import { isAbort, readFileBytes } from './readFile'

/** What the person opened. */
export interface OpenedModel {
  mesh: Mesh
  fileName: string
  /** The file as it was read (the STL, 3MF or .amproj bytes), for hosts that keep the original (`source.stl`, an upload). */
  bytes: Uint8Array
  /** The model is a closed solid. */
  closed: boolean
  /** The model is not closed and the person chose "Repair it": start with `repairFirstList()`. */
  repairFirst: boolean
  /** The model was simplified to fit the limit: the number of triangles before and after. */
  simplified?: { from: number; to: number }
  /** Set when an .amproj was opened: its steps, rollback marker, store, the files the steps use, and what it needs that the host does not have. */
  project?: {
    name: string
    list: StepList
    rollback: string | null
    store?: ProjectStore
    /** The colour slots, when the design uses them. */
    colours?: ColourMap
    /** Stored drawings that were extracted again from their SVG because another version of the importer had made them (the SVG is the source of truth). */
    rebuilt?: string[]
    /** Stored drawings whose SVG can no longer be imported: they keep the drawing they had. */
    storeFailed?: Array<{ name: string; error: unknown }>
    assets: ProjectAsset[]
    lock: PluginLockEntry[]
    missingPlugins: string[]
    missingFonts: AssetUse[]
    versionDiffs: Array<{ id: string; saved: string; installed: string }>
  }
}

/** What an opened project needs that this host does not have: the host decides whether to open it anyway. */
export type ProjectNeeds = Pick<NonNullable<OpenedModel['project']>, 'missingPlugins' | 'missingFonts' | 'versionDiffs'>

export interface UseOpenFileOptions {
  t: T
  /** The plugins the host has, so a project that needs another one reports it in `missingPlugins`. Without it nothing is reported. */
  registry?: Registry
  /** The loader page's state (`useLoading()`), which the host renders. */
  loading: ReturnType<typeof useLoading>
  /** `edit`: the most triangles the editor takes (more is offered a simplification). `read`: the most a file may have to be read at all. */
  limits: { edit: number; read: number }
  /** The fonts the host can serve, so a project that needs another one is reported in `missingFonts`. */
  fonts?: LoadProjectFonts
  /** A project needs plugins or fonts this host does not have. Return `'refuse'` to stop (the Atelier does for fonts and plugins); anything else opens it, and the steps that cannot run say so. */
  onProject?: (needs: ProjectNeeds) => 'open' | 'refuse' | void
  onOpened: (m: OpenedModel) => void
  /** A project has no model in it. Without this the person is told the file cannot be read; give your own message here (the Atelier's `fdm.project_noModel`). */
  onNoModel?: () => void
  /** The page ran out of memory (a file too big for this device). Without it the person is told the file cannot be read. */
  onOutOfMemory?: () => void
}

export const isMemoryError = (e: unknown): boolean => e instanceof RangeError || /out of memory|allocation failed|Array buffer allocation/i.test(e instanceof Error ? e.message : String(e))

/** The step list of a model that is opened with Repair: one Repair mesh step, which the status line then judges. */
export function repairFirstList(): StepList {
  const op = repairManifest.operations[0] as (typeof repairManifest.operations)[number]
  return addStep(emptyStepList(), makeStep({ id: 's1', plugin: { id: REPAIR_PLUGIN_ID, version: REPAIR_PLUGIN_VERSION }, op: op.id, params: Object.fromEntries(op.params.map(p => [p.name, p.default])) }))
}

export function useOpenFile(o: UseOpenFileOptions): { open: (file: File) => Promise<void>; openProject: (bytes: Uint8Array, name?: string, signal?: AbortSignal) => Promise<void>; modal: ReactNode } {
  const { t, registry, loading, limits } = o
  const [modal, setModal] = useState<ReactNode>(null)
  const ask = useCallback(<V,>(render: (done: (v: V) => void) => ReactNode): Promise<V> => new Promise<V>(resolve => { setModal(render(v => { setModal(null); resolve(v) })) }), [])

  // the decimation is one call that cannot be interrupted: Stop hides the dialog and the result is thrown away, which goes back to the start
  const simplify = useCallback(async (mesh: Mesh, target: number): Promise<Mesh | null> => {
    let stopped = false
    setModal(<SimplifyingDialog t={t} onStop={() => { stopped = true; setModal(null) }} />)
    await new Promise(r => setTimeout(r, 30))   // let the dialog draw before the heavy work starts
    try {
      const { decimate, decimateBodies, decimateWasm, wasmAvailable } = await import('@ateliermesh/plugins')
      const opts = { targetTriangles: target }
      const r = wasmAvailable() ? await decimateWasm(mesh, opts).catch(() => null) : null
      const out = (r ?? (mesh.groups && mesh.groups.length > 0 ? await decimateBodies(mesh, opts, (m, oo) => decimate(m, oo)) : decimate(mesh, opts))).mesh
      return stopped ? null : out
    } finally { if (!stopped) setModal(null) }
  }, [t])

  // a model over the limit is offered a simplification, a project's model too (its steps stay): null means the person stopped, or chose another file
  const fitToLimit = useCallback(async (mesh: Mesh): Promise<{ mesh: Mesh; simplified?: { from: number; to: number } } | null> => {
    const tris = mesh.indices.length / 3
    if (tris <= limits.edit) return { mesh }
    const target = Math.floor(limits.edit * 0.9)
    const go = await ask<'simplify' | 'other'>(done => <LoadCheckDialog t={t} kind="triangles" count={tris} max={limits.edit} target={target} onSimplify={() => done('simplify')} onOther={() => done('other')} />)
    if (go === 'other') return null
    const simpler = await simplify(mesh, target)
    if (!simpler) return null   // Stop: back to the start
    const simplified = { from: tris, to: simpler.indices.length / 3 }
    const opened = await ask<boolean>(done => <SimplifiedDialog t={t} from={simplified.from} to={simplified.to} onOpen={() => done(true)} onOther={() => done(false)} />)
    return opened ? { mesh: simpler, simplified } : null
  }, [ask, limits.edit, simplify, t])

  const unreadable = useCallback(async (e: unknown): Promise<void> => {
    loading.end()
    if (isMemoryError(e)) { if (o.onOutOfMemory) { o.onOutOfMemory(); return } }
    const err = e as { code?: string; params?: { triangles?: number } }
    if (err?.code === 'budget.triangles') await ask<void>(done => <LoadCheckDialog t={t} kind="toolarge" count={err.params?.triangles ?? limits.read} max={limits.edit} target={limits.edit} onOther={() => done()} />)
    else await ask<void>(done => <LoadCheckDialog t={t} kind="unreadable" onOther={() => done()} />)
  }, [ask, limits.edit, limits.read, loading, o, t])

  const openProject = useCallback(async (bytes: Uint8Array, name = '', signal?: AbortSignal): Promise<void> => {
    try {
      loading.set('unpack', 0.3)
      const p = await loadProject(bytes, { ...(registry ? { registry } : {}), storeKinds: ['mesh', 'drawing'], limits: { maxTriangles: limits.read, ...DEFAULT_STORE_LIMITS }, ...(o.fonts ? { fonts: o.fonts } : {}), ...(signal ? { signal } : {}), onProgress: f => loading.set(f < 0.5 ? 'unpack' : 'parse', 0.3 + 0.6 * f) })
      loading.set('prepare', 0.95)
      if (!p.base) { loading.end(); if (o.onNoModel) { o.onNoModel(); return } throw new Error('no mesh') }
      const needs = { missingPlugins: p.missingPlugins, missingFonts: p.missingFonts, versionDiffs: p.versionDiffs }
      if (o.onProject?.(needs) === 'refuse') { loading.end(); return }
      loading.end()
      const fitted = await fitToLimit(p.base)   // a project saved under a higher limit is offered the same simplification as a model
      if (!fitted) return
      const closed = (await measureMeshAsync(fitted.mesh, signal ? { signal } : {})).watertight
      const fresh = p.store ? refreshSvgDrawings(p.store) : null
      o.onOpened({ mesh: fitted.mesh, fileName: name, bytes, closed, repairFirst: false, ...(fitted.simplified ? { simplified: fitted.simplified } : {}), project: { name: p.name, list: p.list, rollback: p.rollback, ...(p.colours ? { colours: p.colours } : {}), ...(fresh ? { store: fresh.store } : {}), ...(fresh && fresh.rebuilt.length > 0 ? { rebuilt: fresh.rebuilt } : {}), ...(fresh && fresh.failed.length > 0 ? { storeFailed: fresh.failed } : {}), assets: p.assets, lock: p.lock, ...needs } })
    } catch (e) {
      if (isAbort(e)) return
      console.warn('could not open the project', e)
      await unreadable(e)
    }
  }, [fitToLimit, limits.read, loading, o, registry, unreadable])

  const open = useCallback(async (file: File): Promise<void> => {
    const signal = loading.begin('read')
    try {
      const bytes = await readFileBytes(file, (done, total) => loading.set('read', 0.25 * (done / Math.max(1, total)), { done, total }), signal)
      if (/\.amproj$/i.test(file.name)) { await openProject(bytes, file.name, signal); return }
      const is3mf = /\.3mf$/i.test(file.name)
      let mesh: Mesh
      try {
        const parse = { signal, onProgress: (f: number): void => loading.set(is3mf && f < 0.15 ? 'unpack' : 'parse', 0.25 + 0.6 * f) }
        mesh = is3mf ? (await read3mf(bytes, { limits: { maxTriangles: limits.read }, ...parse })).mesh : (await parseStlAsync(bytes, { maxTriangles: limits.read, ...parse })).mesh
      } catch (e) {
        if (isAbort(e)) return
        await unreadable(e)
        return
      }
      loading.end()
      if (!is3mf) {
        const hint = unitHint(mesh)
        const raw = mesh
        const unit = await ask<Unit | null>(done => <UnitsDialog t={t} suspect={!!hint.suspect} size={u => boundingSize(convertToMm(raw, u)) as [number, number, number]} onContinue={u => done(u)} onBack={() => done(null)} />)
        if (unit === null) return
        if (unit !== 'mm') mesh = convertToMm(mesh, unit)
      }
      const fitted = await fitToLimit(mesh)
      if (!fitted) return
      mesh = fitted.mesh
      const simplified = fitted.simplified
      const checkSignal = loading.begin('check')
      const measured = await measureMeshAsync(mesh, { signal: checkSignal, onProgress: f => loading.set('check', 0.85 + 0.1 * f) })
      const closed = measured.watertight
      const touching = !closed && measured.boundaryEdges === 0 && measured.badOrientationEdges === 0   // only edges that three or more triangles share, no openings
      loading.end()
      let repairFirst = false
      if (!closed) {
        const go = await ask<'open' | 'repair' | 'other'>(done => <LoadCheckDialog t={t} kind="manifold" touching={touching} onRepair={() => done('repair')} onOpenAnyway={() => done('open')} onOther={() => done('other')} />)
        if (go === 'other') return
        repairFirst = go === 'repair'
      }
      o.onOpened({ mesh, fileName: file.name, bytes, closed, repairFirst, ...(simplified ? { simplified } : {}) })
    } catch (e) {
      if (isAbort(e)) return
      if (isMemoryError(e)) { await unreadable(e); return }
      loading.end()
      throw e
    } finally { loading.end() }
  }, [ask, fitToLimit, limits.read, loading, o, openProject, t, unreadable])

  return { open, openProject, modal }
}
