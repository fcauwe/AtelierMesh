// Runs in the browser: the two hooks of @ateliermesh/react with the real engine, no editor page. `window.__h` records what the session hook does (renders, changes) and exposes
// its functions; `window.__o` opens files through `useOpenFile` and records what the host would be told.
import { useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { InProcessHost, MemoryCache, Registry, addStep, emptyStepList, makeStep, saveProject } from '@ateliermesh/core'
import type { Mesh, StepList } from '@ateliermesh/core'
import { sphereMesh } from '@ateliermesh/core/testing'
import { CORE_PLUGIN_ID, CORE_PLUGIN_VERSION, corePlugin } from '@ateliermesh/plugins'
import { LoadingView, useLoading, useOpenFile, useProjectSession } from '../../src'
import type { ChangeWhy, OpenedModel, ProjectSession } from '../../src'
import en from '../../../../apps/standalone/src/locales/en.json'

const flat = (d: unknown, p = ''): Record<string, string> => Object.entries(d as Record<string, unknown>).reduce((o, [k, v]) => (typeof v === 'object' && v !== null ? { ...o, ...flat(v, `${p}${k}.`) } : { ...o, [`${p}${k}`]: String(v) }), {})
const dict = flat(en)
const t = (key: string, values: Record<string, string | number> = {}): string => (dict[key] ?? key).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, n: string) => String(values[n] ?? `{{${n}}}`))

const registry = new Registry().register(corePlugin())
const mesh = (): Mesh => sphereMesh(10, 3)
const step = (id: string): ReturnType<typeof makeStep> => makeStep({ id, plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op: 'resize', params: { mode: 'uniform', percent: 120 } })

interface Cfg { initial?: boolean; shortcuts?: boolean; holdReady?: boolean }
const cfg = ((window as unknown as { __cfg?: Cfg }).__cfg ?? {}) as Cfg
let release: () => void = () => undefined
const ready = cfg.holdReady ? new Promise<void>(r => { release = r }) : undefined

const h = {
  renders: [] as Array<{ hasDoc: boolean; name: string | null }>,
  changes: [] as Array<{ why: ChangeWhy; name: string; steps: number; store: string[] }>,
  session: null as ProjectSession | null,
  release: () => release(),
  /** The editor's change of the steps: one more step at the end. */
  edit: (id: string): void => { const s = h.session!; s.onListChange(addStep(s.docRef.current!.list, step(id)), 'edit') },
  start: (name: string): void => { h.session!.start(mesh(), name) },
  done: false,
  runNow: (): void => { const s = h.session!; void s.run(s.docRef.current!.list, { signal: new AbortController().signal }).then(() => { h.done = true }) },
}
const o = {
  opened: [] as Array<{ fileName: string; closed: boolean; triangles: number; simplified?: { from: number; to: number }; project: boolean; steps: number }>,
  noModel: 0,
  projectBytes: (name: string, base: Mesh | null, list: StepList): Uint8Array => saveProject({ name, base, list, rollback: null, assets: [] }),
  mesh: (): Mesh => mesh(),
  open: null as null | ((bytes: Uint8Array, name: string) => Promise<void>),
}
const w = window as unknown as { __h: typeof h; __o: typeof o }
w.__h = h; w.__o = o

function SessionApp(): null {
  const s = useProjectSession(
    { registry, host: new InProcessHost(registry), cache: new MemoryCache(), assets: async () => new Uint8Array(0), maxTriangles: 1_000_000, ...(ready ? { ready } : {}) },
    { ...(cfg.initial ? { initial: { mesh: mesh(), name: 'first' } } : {}), onChange: (doc, why) => h.changes.push({ why, name: doc.name, steps: doc.list.steps.length, store: Object.keys(doc.store) }), ...(cfg.shortcuts === false ? { shortcuts: false } : {}) },
  )
  h.session = s
  h.renders.push({ hasDoc: !!s.doc, name: s.doc?.name ?? null })
  return null
}

function OpenApp({ edit, read }: { edit: number; read: number }): React.ReactElement {
  const loading = useLoading()
  const opener = useOpenFile({
    t, registry, loading, limits: { edit, read },
    onOpened: (m: OpenedModel) => { o.opened.push({ fileName: m.fileName, closed: m.closed, triangles: m.mesh.indices.length / 3, ...(m.simplified ? { simplified: m.simplified } : {}), project: !!m.project, steps: m.project?.list.steps.length ?? 0 }) },
    onNoModel: () => { o.noModel++ },
  })
  const ref = useRef(opener); ref.current = opener
  useEffect(() => { o.open = (bytes, name) => ref.current.open(new File([bytes as BlobPart], name)) }, [])
  return <><LoadingView t={t} state={loading.state} onStop={loading.stop} />{opener.modal}</>
}

const params = new URLSearchParams(location.search)
const which = (window as unknown as { __which?: string }).__which ?? params.get('which') ?? 'session'
const root = createRoot(document.getElementById('root') as HTMLElement)
if (which === 'open') { const lim = (window as unknown as { __limits?: { edit: number; read: number } }).__limits ?? { edit: 500, read: 5000 }; root.render(<OpenApp edit={lim.edit} read={lim.read} />) }
else root.render(<SessionApp />)
void emptyStepList
