// The standalone app (journey A). It is a host for the shared screens of @ateliermesh/react: it owns the files, the storage, the engine run,
// three.js, the language and the undo history. Everything runs in this page; nothing is sent anywhere.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  MemoryCache, groupNames, Registry, WorkerHost, buildPackage, canApplyPermanently, emptyStepList, fromWebWorker, measureMesh,
  applyColourMap, colourMapFromMesh, runWorkflow, segmentTable, stepPersonalisable, write3mfCompressed, writeStlBinary,
  parseRecipe, serializeRecipe,
} from '@ateliermesh/core'
import type { ColourMap, Mesh, PaletteEntry, ProjectStore, StepList, WorkflowResult } from '@ateliermesh/core'
import { CORE_PLUGIN_ID, registerBuiltInPlugins, createFontService } from '@ateliermesh/plugins'
import { fetchPluginBytes, packageEntry, probePackage, readPluginPackage, withPackageAssets, workerFactory } from '@ateliermesh/loader'
import type { LoadedPackage, TrustedKey as LoaderKey } from '@ateliermesh/loader'
import { buildApproval, compareUpdate, dropImage, imageUrlFor, forgetPlugin, isApprovedBefore, loadErrorText, pluginTexts, restoreStoredPlugins, setStoredEnabled, storePackage, storedBytes } from './pluginstore'
import type { NotStarted, StoredInfo } from './pluginstore'
import { allowHttpFor, fetchCatalog, pinnedPackageUrl, resolveCatalogAddress, saveCatalogAddress, storedCatalogAddress, updatesFor, DEFAULT_CATALOG_PATH } from './catalog'
import type { Catalog } from './catalog'
import { pluginListAddress, probeCatalogue, readCatalogues, saveCatalogues } from './catalogues'
import type { AddedCatalogue } from './catalogues'
import type { ThreeModule, Viewer } from '@ateliermesh/ui'
import {
  CannotRunView, Dialog, LoadingView, useLoading, EditorPage, Icon, ThemeToggle, useTheme, PersonaliseOverlay, ProjectListDialog, UploadPage,
  ApprovalDialog, SettingsShell, fileAccept, renderPreviewPng, renderThumbnailBlobs, useOpenFile, repairFirstList, useProjectSession, useRegistryVersion, useStoreHost, useThumbnails, slotShownColour,
} from '@ateliermesh/react'
import type { GalleryPlugin } from './galleryData'
import type { CatalogueCard, ProjectDoc, PictureLibrary, PluginManagerProps, PluginCatalogHost, PluginApproval, PluginRow, RecipeEntry, RecipesHost, SavedItem } from '@ateliermesh/react'
import { Intro } from './Intro'
import { Welcome } from './Welcome'
import { Gallery } from './Gallery'
import { ShareDialog, SharedList } from './Share'
import { readShared, refreshShared, saveShared, sendPlugin, sendShare, withdrawShared } from './shared'
import type { SharedRecord } from './shared'
import { catalogueBase, catalogueFromHash, countOpen, designFromHash, fetchProject } from './galleryData'
import { PLUGIN_EXAMPLES, SAMPLES, sampleHash, sampleImageUrl, sampleName, sampleSteps } from './samples'
import type { Sample } from './samples'
import { LANGS, initialLang, makeT, rememberLang } from './i18n'
import type { Lang } from './i18n'
import { deleteProject, deleteRecipe, getProject, getRecipe, listProjects, listRecipes, putProject, putRecipe } from './library'
import type { StoredRecipe } from './library'
import type { StoredProject } from './library'
import { ASSET_ACCEPT, assetKind, isPicture } from './assetkind'
import type { AssetKind } from './assetkind'
import staticThumbs from '../public/samples/thumbs.json'
import { thumbCache } from './thumbcache'

// ------------------------------------------------------------------ the engine (one per page)
const registry = registerBuiltInPlugins(new Registry())
// plugins the engine switched off after a crash (or the user switched off) stay off after a reload, until the user switches them on again
/** The public source of the project; the link at the top right of every screen. */
const GITHUB_URL = 'https://github.com/fcauwe/AtelierMesh'
const DISABLED_KEY = 'am.disabledPlugins'
try {
  const saved = JSON.parse(localStorage.getItem(DISABLED_KEY) ?? '{}') as Record<string, { reason?: string; crashed?: boolean }>
  for (const [id, d] of Object.entries(saved)) registry.setEnabled(id, false, d.reason ?? '', d.crashed === true)
} catch { /* private window or a damaged value: every plugin starts on */ }
registry.subscribe(() => { try { localStorage.setItem(DISABLED_KEY, JSON.stringify(registry.disabledPlugins())) } catch { /* private window */ } })
// for the tests: the page's engine, so a test can take a plugin away the way a browser that never had it would look
;(window as unknown as { __am?: Record<string, unknown> }).__am = { ...((window as unknown as { __am?: Record<string, unknown> }).__am ?? {}), registry }
const cache = new MemoryCache()
const assets = new Map<string, Uint8Array>()
const packages = new Map<string, LoadedPackage>()
const host = new WorkerHost(workerFactory(() => fromWebWorker(new Worker('worker.js') as unknown as Parameters<typeof fromWebWorker>[0]), packages), { graceMs: 300 })
const devMode = new URLSearchParams(location.search).has('dev')
const loadingDelay = ((): number | undefined => { const v = new URLSearchParams(location.search).get('loadingDelay'); return v !== null && /^\d+$/.test(v) ? Number(v) : undefined })()   // for tests
interface LibraryPicture { id: string; name: string; category: string; file: string }
const libraryFiles = new Map<string, string>()   // built-in picture id -> file (public/textures), loaded the first time a step needs the bytes
const thumbUrls = new Map<string, string>()      // uploaded picture id -> object URL for its thumbnail
const fontFiles = new Map<string, string>()   // asset id -> file, filled when fonts.json is read; the bytes load the first time a step needs them
const appAssets = async (id: string): Promise<Uint8Array> => {
  const b = assets.get(id); if (b) return b
  const file = fontFiles.get(id) ?? libraryFiles.get(id)
  if (file) { const bytes = new Uint8Array(await (await fetch(file)).arrayBuffer()); assets.set(id, bytes); return bytes }
  throw new Error(`asset ${id} is not loaded`)
}
const resolveAsset = withPackageAssets(appAssets, packages)
const fontService = createFontService(resolveAsset)   // ctx.fonts.outline for plugins that ask for letter outlines
const limits = { edit: 2_000_000, read: 6_000_000 }
{ const lim = /[?&]editLimit=(\d+)/.exec(location.search)?.[1]; if (lim) { limits.edit = Number(lim); limits.read = Number(lim) * 3 } }   // for tests

// The sample cards show the sample with its steps applied. The pictures are drawn ahead of time (`npm run samples:thumbs`, public/samples/) and the page
// uses one as soon as its hash says it still shows the current sample; otherwise the engine runs in this page, once, and the picture is remembered in IndexedDB.
const sampleMesh = async (x: Sample): Promise<Mesh | null> => {
  const am = window as unknown as { __am?: Record<string, unknown> }
  am.__am = { ...(am.__am ?? {}), thumbsDrawn: (((am.__am?.['thumbsDrawn']) as number | undefined) ?? 0) + 1 }   // counted for the tests
  let base: Mesh
  try { base = await x.mesh() } catch { return null }
  if (x.steps.length === 0) return base
  const r = await runWorkflow(sampleSteps(registry, x), { registry, source: base, quality: 'preview', assets: resolveAsset, fonts: fontService })
  return r.ok && r.mesh ? r.mesh : base
}
const hashes = new Map(SAMPLES.map(x => [x.id, sampleHash(x)]))
const noStatic = /[?&]nostatic\b/.test(location.search)   // for tests: draw the pictures here even when files exist
const hasStatic = (x: Sample): boolean => !noStatic && (staticThumbs as Record<string, string>)[x.id] === hashes.get(x.id)
const liveSources = SAMPLES.filter(x => !hasStatic(x)).map(x => ({ id: x.id, key: hashes.get(x.id) as string, mesh: () => sampleMesh(x) }))

// `?thumbs=1`: the script that writes the pictures asks the page to draw every sample (see scripts/make-sample-thumbs.mjs)
if (new URLSearchParams(location.search).has('thumbs')) {
  ;(window as unknown as { __am?: Record<string, unknown> }).__am = {
    ...((window as unknown as { __am?: Record<string, unknown> }).__am ?? {}),
    renderSampleThumbs: async (): Promise<Record<string, { hash: string; png: string }>> => {
      const three = (await import('three')) as unknown as ThreeModule
      const blobs = await renderThumbnailBlobs(three, SAMPLES.map(x => ({ id: x.id, mesh: () => sampleMesh(x) })))
      const out: Record<string, { hash: string; png: string }> = {}
      for (const [id, blob] of Object.entries(blobs)) {
        const bytes = new Uint8Array(await blob.arrayBuffer()); let bin = ''
        for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192))
        out[id] = { hash: hashes.get(id) as string, png: btoa(bin) }
      }
      return out
    },
  }
}

// `?thumbs=1` also draws the example pictures of the built-in plugins (see scripts/make-plugin-images.mjs): 640 x 420, transparent
if (new URLSearchParams(location.search).has('thumbs')) {
  const am = window as unknown as { __am?: Record<string, unknown> }
  am.__am = {
    ...(am.__am ?? {}),
    renderPluginImages: async (): Promise<Record<string, string>> => {
      const three = (await import('three')) as unknown as ThreeModule
      const blobs = await renderThumbnailBlobs(three, PLUGIN_EXAMPLES.map(x => ({ id: x.plugin, mesh: () => sampleMesh(x.sample) })), { width: 640, height: 420 })
      const out: Record<string, string> = {}
      for (const [id, blob] of Object.entries(blobs)) {
        const bytes = new Uint8Array(await blob.arrayBuffer()); let bin = ''
        for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192))
        out[id] = btoa(bin)
      }
      return out
    },
  }
}

const hasWebGl = (): boolean => { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') ?? c.getContext('webgl')) } catch { return false } }
/** The address a plugin is saved with in a project: https only, without a fragment (the catalog's checksum pin) or credentials. A plugin from a file or a built-in one has none. */
const savedOrigin = (o?: string): string | undefined => { if (!o) return undefined; try { const u = new URL(o); if (u.protocol !== 'https:') return undefined; u.hash = ''; u.username = ''; u.password = ''; return u.href } catch { return undefined } }
/** The plugin lists of several catalogues as one, in order: the first catalogue that has a plugin gives it. */
const mergeCatalogs = (first: Catalog | undefined, more: Catalog[]): Catalog | undefined => {
  const all = [first, ...more].filter((c): c is Catalog => !!c)
  if (all.length === 0) return undefined
  const seen = new Set<string>(), plugins: Catalog['plugins'] = []
  for (const c of all) for (const e of c.plugins) if (!seen.has(e.id)) { seen.add(e.id); plugins.push({ ...e, from: c.host }) }
  return { ...(all[0] as Catalog), plugins }
}
const safe = (name: string): string => (name || 'model').replace(/[^\w.-]+/g, '_')
/** With colour slots: every part in its slot (first slot `body`, the others `slot_<id>`) and the slot's colour, so `extruderPalette` gives each slot its own extruder; without them the mesh as it is. */
const withSlots = (mesh: Mesh, map?: ColourMap): Mesh => (map ? applyColourMap(mesh, map, { mode: 'preview', colours: Object.fromEntries(map.slots.map((x, i) => [x.id, { color: slotShownColour(x, i) }])) }) : mesh)
const extruderPalette = (mesh: Mesh): PaletteEntry[] => segmentTable(mesh).filter(s => s.id !== 0).map((s, i) => ({ segment: s.name, extruder: Math.min(16, i + 2), color: s.color ?? ['#d9534f', '#4c78a8', '#54a24b', '#f2cf5b'][i % 4] as string }))

function download(name: string, bytes: Uint8Array, type: string): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}

type Doc = ProjectDoc   // the project: model, steps, and the store of drawings and models (the hook `useProjectSession` owns it)
type Cannot = 'webgl' | 'memory' | 'worker'
interface FontEntry { family: string; file: string; weightRange?: string; /** Not offered in the pickers, still loaded: saved projects that use it keep their look. */ hidden?: boolean; licence?: string }
const timeText = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function App(): ReactElement {
  const [lang, setLang] = useState<Lang>(initialLang())
  const regVersion = useRegistryVersion(registry)
  const t = useMemo(() => makeT(lang, pluginTexts), [lang, regVersion])
  useEffect(() => { document.documentElement.lang = lang }, [lang])
  const [cannot, setCannot] = useState<Cannot | null>(() => {
    const sim = /[?&]cannot=(webgl|memory|worker)\b/.exec(location.search)?.[1] as Cannot | undefined
    return sim ?? (hasWebGl() ? null : 'webgl')
  })
  const [three, setThree] = useState<ThreeModule | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const loading = useLoading()   // opening a file: the loader page with its stage and progress
  const [notice, setNotice] = useState<string | null>(null)
  const [saved, setSaved] = useState<StoredProject[]>([])
  // recipes: an export of the steps, kept in this browser (IndexedDB) next to the projects
  const [storedRecipes, setStoredRecipes] = useState<StoredRecipe[]>([])
  const refreshRecipes = useCallback(async (): Promise<void> => { try { setStoredRecipes(await listRecipes()) } catch { /* private window */ } }, [])
  const savedItems = useSavedImages(saved)
  const [dialog, setDialog] = useState<null | 'export' | 'save' | 'list' | 'font' | 'apply' | 'share'>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [fonts, setFonts] = useState<FontEntry[]>([])
  const [fontFor, setFontFor] = useState<{ stepId: string; param: string } | null>(null)
  const [showPersonalised, setShowPersonalisedState] = useState<boolean>(() => { try { return localStorage.getItem('am.personaliseOption') === '1' } catch { return false } })
  const [personalised, setPersonalised] = useState(false)
  const [customer, setCustomer] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [pluginNote, setPluginNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [pluginTick, setPluginTick] = useState(0)
  // the project, its undo history, running the steps and Apply are the shared hook's; this app adds storage, files and screens around it
  const session = useProjectSession({ registry, host, cache, assets: resolveAsset, fonts: fontService, maxTriangles: limits.edit, version: pluginTick })
  const store = useStoreHost(session)   // the Stored tab, the picker and Import SVG, and the customer's Change drawing
  const { doc } = session
  const [stored, setStored] = useState<Record<string, StoredInfo>>({})
  const [notStarted, setNotStarted] = useState<NotStarted[]>([])
  const [storage, setStorage] = useState<{ available: boolean }>({ available: true })
  const [approval, setApproval] = useState<{ data: PluginApproval; own: boolean; resolve: (yes: boolean) => void } | null>(null)
  // a project that needs plugins this browser does not have: asked once on opening, then catalog first, then the saved address (after asking)
  const [reload, setReload] = useState<null | { items: { id: string; version: string; origin?: string }[] }>(null)
  const [outside, setOutside] = useState<null | { id: string; host: string; resolve: (yes: boolean) => void }>(null)
  const reloading = useRef(false)
  const [checking, setChecking] = useState<string | null>(null)
  // the plugin catalog: read when the plugin manager opens (never in the background), kept for the session
  const [catalogState, setCatalogState] = useState<{ status: 'loading' | 'ready' | 'unavailable'; catalog?: Catalog }>({ status: 'loading' })
  // the catalogues the person added: kept in this browser; their plugin lists are read when the plugin manager opens and are merged with the default one (the first catalogue that has a plugin wins)
  const [added, setAdded] = useState<AddedCatalogue[]>(readCatalogues)
  const [extraCats, setExtraCats] = useState<Record<string, Catalog>>({})
  const mergedCatalog = mergeCatalogs(catalogState.catalog, added.filter(c => c.plugins).map(c => extraCats[c.id]).filter((x): x is Catalog => !!x))
  const [catalogBusy, setCatalogBusy] = useState<string | null>(null)
  const [catalogAddress, setCatalogAddressState] = useState(storedCatalogAddress)
  // the standalone has no filament list, so a design may use as many colours as it likes (in the Atelier the connector sets the most)
  const catalogFetchedAt = useRef(0)
  const [keys, setKeys] = useState<LoaderKey[]>(() => { try { return JSON.parse(localStorage.getItem('am.trustedKeys') ?? '[]') as LoaderKey[] } catch { return [] } })
  const [exportKind, setExportKind] = useState<'3mf' | 'prusa' | 'bambu' | 'stl'>('prusa')
  const [saveName, setSaveName] = useState('')
  const storedId = useRef<string | null>(null)
  const savedSig = useRef('')
  const viewer = useRef<Viewer | null>(null)
  const lastResult = useRef<WorkflowResult | null>(null)

  const sig = session.signature
  const say = useCallback((text: string): void => { setNotice(text); setTimeout(() => setNotice(n => (n === text ? null : n)), 5000) }, [])

  // three.js is fetched once, when the first model is shown
  useEffect(() => { if (cannot || three) return; void import('three').then(m => setThree(m as unknown as ThreeModule)) }, [cannot, three])
  // the sample cards show a render of the model, drawn once three.js is there
  const sampleImages = useThumbnails(three, liveSources, 'samples', thumbCache)
  // the font cards show their own typeface: one @font-face per font
  useEffect(() => {
    if (fonts.length === 0) return
    const st = document.createElement('style')
    st.textContent = fonts.map(f => `@font-face{font-family:"${f.family}";src:url("${f.file}");font-display:swap;${f.weightRange ? `font-weight:${f.weightRange};` : ''}}`).join('\n')
    document.head.append(st); return () => st.remove()
  }, [fonts])
  const [textures, setTextures] = useState<LibraryPicture[]>([])
  const tx = (tt: typeof t, key: string, fallback: string): string => { const v = tt(key); return v === key ? fallback : v }
  const pictures: PictureLibrary = {
    items: lib => [
      ...(lib === 'textures' ? textures.map(x => ({ id: x.id, name: tx(t, `texture.${x.id.slice(8)}`, x.name), url: x.file, category: tx(t, `texture.group.${x.category}`, x.category) })) : []),
      ...[...assets.keys()].filter(k => k.startsWith('image:')).map(k => {
        let url = thumbUrls.get(k); if (!url) { url = URL.createObjectURL(new Blob([assets.get(k) as Uint8Array<ArrayBuffer>])); thumbUrls.set(k, url) }
        return { id: k, name: k.slice(6), url, category: t('pictures.mine') === 'pictures.mine' ? 'My pictures' : t('pictures.mine') }
      }),
    ],
  }
  const sampleItems = SAMPLES.map(x => ({ id: x.id, name: sampleName(t, x), ...(x.steps.length > 0 ? { note: x.steps.map(st => st.name ?? st.op).join(' · ') } : {}), ...(hasStatic(x) ? { image: sampleImageUrl(x.id) } : sampleImages[x.id] ? { image: sampleImages[x.id] } : {}) }))
  useEffect(() => {
    if (cannot) return
    void (async () => {
      try { const r = await fetch('fonts/fonts.json'); if (r.ok) { const list = await r.json() as FontEntry[]; for (const f of list) fontFiles.set(`font:${f.family}`, f.file); setFonts(list.filter(f => !f.hidden)) } } catch { /* only the built-in font */ }
      try { const r = await fetch('textures/textures.json'); if (r.ok) { const list = await r.json() as LibraryPicture[]; for (const x of list) libraryFiles.set(x.id, x.file); setTextures(list) } } catch { /* no built-in pictures */ }
      try { const f = await fetch('fonts/roboto-regular.woff2'); if (f.ok) { const b = new Uint8Array(await f.arrayBuffer()); assets.set('roboto-regular', b); assets.set('font:Roboto', b) } } catch { /* ignore */ }
      try { setSaved(await listProjects()) } catch { /* private window */ }
      void refreshRecipes()
    })()
  }, [cannot])

  const stop = (kind: Cannot): void => { try { sessionStorage.setItem('am.recover', '1') } catch { /* ignore */ } setCannot(kind) }

  // ---- opening things

  const start = useCallback((mesh: Mesh, name: string, list: StepList = emptyStepList(), rollback: string | null = null, stored: string | null = null, store: ProjectStore = {}, colours?: ColourMap): void => {
    storedId.current = stored
    const d = session.start(mesh, name, { list, rollback, store, ...(colours ? { colours } : {}) })
    savedSig.current = stored ? sig(d) : ''; setSavedAt(null); setCustomer(false)
    if (list.steps.some(stepPersonalisable)) { setShowPersonalisedState(true); setPersonalised(true) } else setPersonalised(false)
  }, [])

  // opening a model or a project (reading with progress, the unit, simplifying a big model, the closed-solid check, Repair, out of memory) is the shared hook's; this app decides what happens next
  const pendingStored = useRef<string | null>(null)
  const opener = useOpenFile({
    t, registry, loading, limits, onOutOfMemory: () => stop('memory'),
    onOpened: m => {
      if (m.project) {
        for (const a of m.project.assets) assets.set(a.id, a.bytes)
        const stored = pendingStored.current; pendingStored.current = null
        start(m.mesh, m.project.name, m.project.list, m.project.rollback, stored, m.project.store ?? {}, m.project.colours)
        if (m.project.missingPlugins.length > 0) {
          // an example already asked about its plugins before the download: "Install and open" goes straight on, "Open anyway" leaves them; a file or a link asks now
          const c = exampleChoice.current; exampleChoice.current = null
          const items = reloadItems(m.project.missingPlugins, m.project.lock)
          if (c === 'install') void runReload(items); else if (c !== 'anyway') setReload({ items })
        }
        const notes = [...m.project.versionDiffs.map(v => `Plugin ${v.id}: saved with ${v.saved}, installed ${v.installed}.`), ...(m.project.rebuilt?.length ? [`Drawings made again from their SVG: ${m.project.rebuilt.join(', ')}.`] : [])]
        if (notes.length > 0) say(notes.join(' '))
      } else start(m.mesh, m.fileName, m.repairFirst ? repairFirstList() : emptyStepList(), null, null, {}, colourMapFromMesh(m.mesh))   // a model painted in several colours starts with its colours in the Colours tab
    },
  })
  const openProjectBytes = (bytes: Uint8Array, stored: string | null, signal?: AbortSignal): Promise<void> => { pendingStored.current = stored; return opener.openProject(bytes, '', signal) }
  const openFile = (file: File): Promise<void> => { pendingStored.current = null; return opener.open(file) }
  // the example gallery: read from the catalogue; when it cannot be reached the built-in samples show as before
  const [galleryOk, setGalleryOk] = useState<boolean | null>(null)
  // designs this browser shared as examples: their state is asked of the catalogue when the start page shows
  const [shared, setShared] = useState<SharedRecord[]>(readShared)
  useEffect(() => {
    if (doc || !shared.some(r => r.state === 'pending' || r.state === 'accepted')) return
    let gone = false
    void refreshShared(shared).then(next => { if (!gone && JSON.stringify(next) !== JSON.stringify(shared)) { saveShared(next); setShared(next) } })
    return () => { gone = true }
  }, [!doc])
  const [galleryWhy, setGalleryWhy] = useState<'missing' | 'down' | 'empty' | null>(null)
  const [galleryKey, setGalleryKey] = useState(0)
  const [opening, setOpening] = useState<null | { name?: string; author?: string; picture: string; shared?: boolean }>(null)   // what the loader page tells about the example being opened
  const [startNote, setStartNote] = useState<null | 'removed'>(null)
  const exampleChoice = useRef<'install' | 'anyway' | null>(null)
  const [exampleAsk, setExampleAsk] = useState<null | { name: string; rows: Array<{ id: string; name: string; fromCatalogue: string | null }>; resolve: (c: 'install' | 'anyway' | null) => void }>(null)
  const galleryBase = useMemo(() => catalogueBase(resolveCatalogAddress(catalogAddress) ?? DEFAULT_CATALOG_PATH), [catalogAddress])
  /** Open an example: a question first when it needs plugins this browser lacks (install and open, open anyway, cancel), then the download with its own page, then the editor. */
  const openExample = async (it: { id: string; project: string; picture: string; base?: string; name?: string; author?: string; plugins?: GalleryPlugin[] }, viaLink = false): Promise<void> => {
    exampleChoice.current = null
    const missing = (it.plugins ?? []).filter(p => !registry.has(p.id))
    if (missing.length > 0) {
      const cat = await ensureCatalogue()
      const choice = await new Promise<'install' | 'anyway' | null>(resolve => setExampleAsk({ name: it.name ?? '', rows: missing.map(p => ({ id: p.id, name: p.name, fromCatalogue: cat?.plugins.find(e => e.id === p.id)?.from ?? null })), resolve }))
      setExampleAsk(null)
      if (choice === null) return
      exampleChoice.current = choice
    }
    setStartNote(null)
    setOpening({ ...(it.name ? { name: it.name } : {}), ...(it.author ? { author: it.author } : {}), picture: it.picture, ...(viaLink ? { shared: true } : {}) })
    const signal = loading.begin('read')
    try {
      const bytes = await fetchProject(it.project, (done, total) => loading.set('read', total > 0 ? done / total : undefined, total > 0 ? { done, total } : undefined), signal)
      if (signal.aborted) return
      countOpen(it.base ?? galleryBase, it.id)
      await openProjectBytes(bytes, null, signal)
    } catch (e) {
      if (!signal.aborted) { if (viaLink && e instanceof Error && e.message === '404') setStartNote('removed'); else say(t('gallery.openFailed')) }
    } finally { loading.end(); setOpening(null) }
  }
  // a shared link (#design=<id>) opens that example straight away
  useEffect(() => { if (galleryOk) loadCatalog() }, [galleryOk])   // the gallery's plugin filter and "needs" chips know the catalogue's plugins
  const landed = useRef(false)
  useEffect(() => {
    if (landed.current || cannot) return
    const id = designFromHash(location.hash)
    if (id === null) return
    landed.current = true
    const named = catalogueFromHash(location.hash), known = [galleryBase, ...added.filter(c => c.designs).map(c => c.base)]   // a link names its catalogue; one the app does not read is not followed
    const from = named !== null && known.includes(catalogueBase(named)) ? catalogueBase(named) : galleryBase
    try { history.replaceState(null, '', location.pathname + location.search) } catch { /* ignore */ }
    void openExample({ id, base: from, project: `${from}gallery.php?project=${id}`, picture: `${from}gallery.php?picture=${id}` }, true)
  }, [cannot, galleryBase, openExample])

  const openSaved = useCallback(async (id: string): Promise<void> => {
    setDialog(null)
    const signal = loading.begin('read')
    try {
      const bytes = await getProject(id)
      if (signal.aborted) return
      if (!bytes) { loading.end(); say('That project is gone.'); setSaved(await listProjects().catch(() => [])); return }
      await openProjectBytes(bytes, id, signal)
    } finally { loading.end() }
  }, [loading, openProjectBytes, say])

  // after a stop, the newest copy kept in this browser is opened again on the next load
  useEffect(() => {
    let flag = false
    try { flag = sessionStorage.getItem('am.recover') === '1'; sessionStorage.removeItem('am.recover') } catch { /* ignore */ }
    if (!flag || cannot) return
    void (async () => {
      try {
        const [latest] = await listProjects()
        const bytes = latest ? await getProject(latest.id) : null
        if (latest && bytes) { await openProjectBytes(bytes, latest.id); say(t('cannot.recovered')) } else say(t('cannot.recoveredNone'))
      } catch { /* nothing to recover */ }
    })()
  }, [])

  // ---- running
  const run = session.run
  const onResult = useCallback((res: WorkflowResult | null): void => {
    lastResult.current = res
    ;(window as unknown as { __am?: Record<string, unknown> }).__am = { ...((window as unknown as { __am?: Record<string, unknown> }).__am ?? {}), result: res ? { ok: res.ok, triangles: res.mesh ? res.mesh.indices.length / 3 : 0, groups: (res.mesh?.groups ?? []).map(g => ({ name: g.name ?? '', count: g.count })) } : null }
  }, [])

  // ---- editing
  const onListChange = session.onListChange

  // ---- saving
  // a picture of the current result goes into every project that is saved; it never stops a save (no WebGL: no picture)
  const threeRef = useRef(three); threeRef.current = three
  const previewRef = useRef<Uint8Array | undefined>(undefined)
  const pvTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const previewOf = async (d: Doc): Promise<Uint8Array | undefined> => {
    const th = threeRef.current, m = lastResult.current?.mesh ?? d.base
    if (!th || !m) return undefined
    try { return (await renderPreviewPng(th, m)) ?? undefined } catch { return undefined }
  }
  const projectBytes = (d: Doc, preview?: Uint8Array): Uint8Array => session.projectBytes(d, {
    ...(preview ? { preview } : {}),
    assets: [...assets].map(([id, b]) => ({ id, bytes: b })),
    plugins: [...packages].map(([id, p]) => ({ id, version: p.manifest.version, fileSha256: p.fileSha256, ...(savedOrigin(p.origin) ? { origin: savedOrigin(p.origin) as string } : {}), signed: p.signed, ...(p.signer ? { signer: p.signer } : {}) })),
  })
  const shareFile = (d: Doc): string => `${safe(d.name)}.stl`
  const shareSize = useMemo(() => (dialog === 'share' && doc ? projectBytes(doc).length : 0), [dialog])   // the size of the file that would be sent, worked out once when the form opens
  const saveFile = async (d: Doc, name: string): Promise<void> => { const preview = await previewOf(d); download(`${safe(name)}.amproj`, projectBytes({ ...d, name }, preview), 'application/zip'); savedSig.current = sig({ ...d, name }); setSavedAt(timeText(Date.now())) }
  const saveBrowser = async (d: Doc, name: string): Promise<void> => {
    try {
      const preview = await previewOf(d)
      if (preview) previewRef.current = preview
      const rec = await putProject(name || 'Untitled', projectBytes({ ...d, name }, preview), storedId.current ?? undefined, preview)
      storedId.current = rec.id; savedSig.current = sig({ ...d, name }); setSavedAt(timeText(rec.updated))
      session.setName(name); setSaved(await listProjects())
      say(t('autosave.saved', { time: timeText(rec.updated) }))
    } catch (e) { say(`${e instanceof Error ? e.message : String(e)}`) }
  }
  // once saved by hand, the browser copy follows every change
  useEffect(() => {
    const id = setInterval(() => {
      const d = docRef.current
      if (!storedId.current || !d || customerRef.current) return
      const s = sig(d)
      if (s === savedSig.current) return
      savedSig.current = s
      // write at once with the last picture, then draw a new one once the editing has stopped for a moment (never in the way of typing)
      const pv = previewRef.current
      void putProject(d.name || 'Untitled', projectBytes(d, pv), storedId.current, pv).then(r => { setSavedAt(timeText(r.updated)); void listProjects().then(setSaved) }, () => { /* the Save button shows the reason */ })
      clearTimeout(pvTimer.current)
      pvTimer.current = setTimeout(() => {
        const cur = docRef.current
        if (!cur || !storedId.current || customerRef.current) return
        void previewOf(cur).then(p => { if (!p || !storedId.current) return; previewRef.current = p; return putProject(cur.name || 'Untitled', projectBytes(cur, p), storedId.current, p).then(() => listProjects().then(setSaved)) }).catch(() => { /* only a picture */ })
      }, 4000)
    }, 2000)
    return () => clearInterval(id)
  }, [])
  const docRef = session.docRef
  ;(window as unknown as { __am?: Record<string, unknown> }).__am = { ...((window as unknown as { __am?: Record<string, unknown> }).__am ?? {}), list: () => docRef.current?.list ?? null }
  const customerRef = useRef(customer); customerRef.current = customer
  const dirty = !!doc && sig(doc) !== savedSig.current && (doc.list.steps.length > 0 || storedId.current !== null)

  const exportNow = async (d: Doc, kind: '3mf' | 'prusa' | 'bambu' | 'stl'): Promise<void> => {
    setBusy(t('export.preparing'))
    try {
      const res = await run(d.list, { signal: new AbortController().signal }, 'export')
      if (!res.ok) { say(t('editor.blocked')); return }
      const mesh = withSlots(res.mesh ?? d.base, d.colours)
      const base = safe(d.name)
      if (kind === 'stl') download(`${base}.stl`, writeStlBinary(mesh), 'model/stl')
      else download(`${base}.3mf`, (await write3mfCompressed(mesh, { title: base, palette: extruderPalette(mesh), ...(kind === 'prusa' || kind === 'bambu' ? { target: kind } : { slicer: 'inline_sidecar' as const }) })).bytes, 'model/3mf')
      setDialog(null)
    } finally { setBusy(null) }
  }
  const savePackage = async (d: Doc): Promise<void> => {
    const res = await run(d.list, { signal: new AbortController().signal }, 'export')
    if (!res.ok) { say(t('editor.blocked')); return }
    const final = withSlots(res.mesh ?? d.base, d.colours)
    let render: Uint8Array | undefined
    if (viewer.current) render = new Uint8Array(await (await viewer.current.snapshot()).arrayBuffer())
    download(`${safe(d.name)}-package.zip`, buildPackage({ source: d.source, final, steps: d.list, ...(render ? { render } : {}), palette: extruderPalette(final), stl: true, title: d.name }), 'application/zip')
  }
  const apply = async (): Promise<void> => {
    try { await session.apply(); setDialog(null) } catch (e) { setDialog(null); say(`${e instanceof Error ? e.message : JSON.stringify(e)}`) }
  }

  // ---- plugins
  // ask the person, inside the plugin manager; resolves with the answer
  const askApproval = (data: PluginApproval): Promise<boolean> => new Promise(resolve => setApproval({ data, own: reloading.current, resolve: yes => { setApproval(null); resolve(yes) } }))
  const say2 = (kind: 'ok' | 'error', text: string): void => setPluginNote({ kind, text })
  /** Start a package once in the sandbox, then swap it in for the one running (the old one stays until the new one has started), and keep it in the browser. */
  const activate = async (pkg: LoadedPackage, bytes: Uint8Array, source: 'file' | 'url', url?: string): Promise<boolean> => {
    const m = pkg.manifest
    const probe = await probePackage(pkg)
    if (!probe.ok) { say2('error', t('plugins.loadFailed', { name: m.name, message: probe.message })); return false }
    const wasOff = registry.disabledPlugins()[m.id]
    if (registry.has(m.id)) { registry.unregister(m.id) }
    { const old = packages.get(m.id); if (old && old.hash !== pkg.hash) dropImage(old) }
    packages.set(m.id, pkg); pluginTexts.set(m.id, pkg.locales.texts); registry.register(packageEntry(pkg)); if (wasOff && !wasOff.crashed) registry.setEnabled(m.id, false, wasOff.reason)
    setNotStarted(list => list.filter(x => x.id !== m.id))
    setPluginTick(n => n + 1)
    const kept = await storePackage(pkg, bytes, source, url)
    if (kept.ok) { setStored(o => ({ ...o, [m.id]: kept.info })); setStorage({ available: true }) }
    else { setStored(o => { const { [m.id]: _gone, ...rest } = o; return rest }); if (kept.key === 'plugins.notStoredHere') setStorage({ available: false }) }
    const base = t('plugins.loaded', { name: m.name, version: m.version, how: pkg.signed ? t('plugins.signed', { signer: pkg.signer ?? '' }) : t('plugins.unsignedShort') })
    say2('ok', kept.ok ? base : `${base} ${t(kept.key, kept.values)}`)
    return true
  }
  const installPackage = async (bytes: Uint8Array, origin: string, source: 'file' | 'url' = 'file', url?: string, expect?: { id: string; version?: string }): Promise<'ok' | 'declined' | 'failed'> => {
    try {
      const pkg = await readPluginPackage(bytes, { trustedKeys: keys, origin })
      const m = pkg.manifest
      // from the catalog: the file must be the plugin and version the catalog promised (its checksum was pinned while downloading)
      if (expect && (m.id !== expect.id || (expect.version !== undefined && m.version !== expect.version))) { say2('error', expect.version !== undefined ? t('plugins.catalog.mismatch', { id: expect.id, version: expect.version }) : t('plugins.reload.wrongFile', { id: expect.id })); return 'failed' }
      const running = registry.manifest(m.id)
      if (running && !packages.has(m.id)) { say2('error', t('plugins.clashBuiltIn', { name: m.name })); return 'failed' }
      // the same file approved before (same checksum) is not asked about again; a changed file with the same id is a new install and is asked, offering "Replace"
      const same = running && packages.get(m.id)?.fileSha256 === pkg.fileSha256
      if (same) { say2('ok', t('plugins.alreadyInstalled', { name: m.name, version: m.version })); return 'ok' }
      const approvedBefore = !running && (await isApprovedBefore(m.id, pkg.fileSha256))
      if (!approvedBefore) {
        const yes = await askApproval(buildApproval(pkg, running ? { version: running.version, pkg: packages.get(m.id) } : undefined, origin, expect && running ? 'update' : 'install'))
        if (!yes) { dropImage(pkg); return 'declined' }
      }
      return (await activate(pkg, bytes, source, url)) ? 'ok' : 'failed'
    } catch (e) { say2('error', t('plugins.cannotLoad', { message: loadErrorText(t, e) })); return 'failed' }
  }
  /** Fetch the package again from its address and ask. Only runs when the person clicks. */
  const checkUpdate = async (id: string): Promise<void> => {
    const inst = packages.get(id)
    const addr = inst?.manifest.package_url ?? stored[id]?.url
    if (!inst || !addr) return
    setChecking(id); setPluginNote(null)
    try {
      const r = await fetchPluginBytes(addr, { allowHttp: devMode })
      const pkg = await readPluginPackage(r.bytes, { trustedKeys: keys, origin: r.url })
      const what = compareUpdate({ id, version: inst.manifest.version, fileSha256: inst.fileSha256 }, pkg)
      if (what === 'different_plugin') { say2('error', t('plugins.differentPlugin', { name: pkg.manifest.name })); return }
      if (what === 'up_to_date' || what === 'older') { say2('ok', t('plugins.upToDate', { name: inst.manifest.name, version: inst.manifest.version })); return }
      const yes = await askApproval(buildApproval(pkg, { version: inst.manifest.version, pkg: inst }, r.url, 'update'))
      if (!yes) { dropImage(pkg); return }
      const before = pkg.manifest.version
      if (await activate(pkg, r.bytes, 'url', r.url)) say2('ok', t('plugins.updated', { name: pkg.manifest.name, from: inst.manifest.version, to: before }))
    } catch (e) { say2('error', t('plugins.updateFailed', { message: loadErrorText(t, e) })) }
    finally { setChecking(null) }
  }
  /** Read the catalog (when the plugin manager opens, or on "Try again"); a result younger than a minute is reused. */
  const loadCatalog = (force = false): void => {
    if (!force && catalogState.status === 'ready' && Date.now() - catalogFetchedAt.current < 60_000) return
    setCatalogState(s => (s.catalog ? { status: 'loading', catalog: s.catalog } : { status: 'loading' }))
    void fetchCatalog(catalogAddress).then(r => {
      if (r.ok) { catalogFetchedAt.current = Date.now(); setCatalogState({ status: 'ready', catalog: r.catalog }) } else setCatalogState({ status: 'unavailable' })
    })
    for (const c of added.filter(x => x.plugins)) void fetchCatalog(pluginListAddress(c.base)).then(r => { if (r.ok) setExtraCats(o => ({ ...o, [c.id]: r.catalog })) })
  }
  /** Install or update from the catalog: download the version the catalog names with its checksum pinned, then the usual checks and approval. */
  const installFromCatalog = async (id: string, from: Catalog | undefined = mergedCatalog): Promise<'ok' | 'declined' | 'failed'> => {
    const entry = from?.plugins.find(e => e.id === id)
    const v = entry?.versions.find(x => x.version === entry.latest)
    if (!entry || !v) return 'failed'
    setCatalogBusy(id); setPluginNote(null)
    try {
      const r = await fetchPluginBytes(pinnedPackageUrl(v), { allowHttp: allowHttpFor(v.url), maxBytes: Math.min(20 * 1024 * 1024, v.size + 4096) })
      // the address is not kept as the plugin's update address: the catalog (not a fixed file) says when there is something newer
      return await installPackage(r.bytes, r.url, 'url', undefined, { id: entry.id, version: v.version })
    } catch (e) { say2('error', t('plugins.catalog.installFailed', { message: loadErrorText(t, e) })); return 'failed' }
    finally { setCatalogBusy(null) }
  }
  const removePlugin = (id: string): void => {
    dropImage(packages.get(id)); registry.unregister(id); packages.delete(id); pluginTexts.remove(id)
    setStored(o => { const { [id]: _gone, ...rest } = o; return rest }); setNotStarted(list => list.filter(x => x.id !== id))
    void forgetPlugin(id)
    setPluginTick(n => n + 1)
  }
  const reloadItems = (ids: string[], lock: ReadonlyArray<{ id: string; version: string; origin?: string }>): Array<{ id: string; version: string; origin?: string }> =>
    ids.map(id => { const l = lock.find(e => e.id === id); const origin = savedOrigin(l?.origin); return { id, version: l?.version ?? '', ...(origin ? { origin } : {}) } })
  /** The catalogue's plugin list, read now when it is not (the plugin manager reads it only when it opens). */
  const ensureCatalogue = async (): Promise<Catalog | undefined> => {
    let def = catalogState.status === 'ready' ? catalogState.catalog : undefined
    if (!def) {
      const r = await fetchCatalog(catalogAddress)
      if (r.ok) { catalogFetchedAt.current = Date.now(); setCatalogState({ status: 'ready', catalog: r.catalog }); def = r.catalog } else setCatalogState({ status: 'unavailable' })
    }
    const extras: Catalog[] = []
    for (const c of added.filter(x => x.plugins)) {
      let cc = extraCats[c.id]
      if (!cc) { const r = await fetchCatalog(pluginListAddress(c.base)); if (r.ok) { cc = r.catalog; setExtraCats(o => ({ ...o, [c.id]: r.catalog })) } }
      if (cc) extras.push(cc)
    }
    return mergeCatalogs(def, extras)
  }
  const askOutside = (id: string, host: string): Promise<boolean> => new Promise(resolve => setOutside({ id, host, resolve: yes => { setOutside(null); resolve(yes) } }))
  /** Catalog first; a plugin the catalog cannot give is fetched from the address saved in the project, but only after the person says yes. Every file still gets the usual checks and approval. */
  const runReload = async (items: { id: string; version: string; origin?: string }[]): Promise<void> => {
    setReload(null); reloading.current = true
    const got: string[] = [], missed: string[] = []
    try {
      const cat = await ensureCatalogue()
      for (const it of items) {
        let r: 'ok' | 'declined' | 'failed' = 'failed'
        if (cat?.plugins.some(e => e.id === it.id)) r = await installFromCatalog(it.id, cat)
        if (r === 'failed' && it.origin) {
          if (await askOutside(it.id, new URL(it.origin).host)) {
            try { const f = await fetchPluginBytes(it.origin, { allowHttp: false }); r = await installPackage(f.bytes, f.url, 'url', f.url, { id: it.id }) }
            catch (e) { say2('error', t('plugins.cannotFetch', { message: loadErrorText(t, e) })) }
          }
        }
        ;(r === 'ok' ? got : missed).push(it.id)
      }
    } finally { reloading.current = false }
    say([got.length ? t('plugins.reload.done', { list: got.join(', ') }) : '', missed.length ? t('plugins.reload.notLoaded', { list: missed.join(', ') }) : ''].filter(Boolean).join(' '))
  }
  /** Send a stored plugin to the catalogue (the first one in the list): an admin checks it before it is listed. */
  const sharePlugin = (id: string): void => {
    const name = packages.get(id)?.manifest.name ?? id
    if (!confirm(t('plugins.shareAsk', { name }))) return
    void storedBytes(id).then(async r => {
      if (!r) return
      const res = await sendPlugin(galleryBase, r.bytes)
      if (res.ok) say2('ok', t('plugins.shareSent', { name }))
      else say2('error', res.error === 'exists' ? t('plugins.shareExists', { name }) : res.error === 'package' ? t('plugins.shareRefused', { reason: res.errors?.[0] ?? '' }) : res.error === 'rate' ? t('share.error.rate') : t('share.error.other'))
    })
  }
  const downloadPlugin = (id: string): void => {
    void storedBytes(id).then(r => { if (r) download(`${id}-${r.version}.amplugin`, r.bytes, 'application/zip') })
  }
  // every stored plugin is loaded again in the background, after the start page is on screen: checked, started once in the sandbox, then registered
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current) return
    restored.current = true
    const id = window.setTimeout(() => {
      let disabled: Record<string, { reason?: string; crashed?: boolean }> = {}
      try { disabled = JSON.parse(localStorage.getItem(DISABLED_KEY) ?? '{}') as typeof disabled } catch { /* damaged value */ }
      void restoreStoredPlugins({ registry, packages, keys, disabled, onOne: () => setPluginTick(n => n + 1) }).then(r => {
        setStored(r.stored); setNotStarted(r.notStarted); setStorage({ available: r.available }); setPluginTick(n => n + 1)
      })
    }, 0)
    return () => window.clearTimeout(id)
  }, [])
  const [pluginView, setPluginView] = useState<'list' | 'gallery'>(() => { try { return localStorage.getItem('am.pluginView') === 'list' ? 'list' : 'gallery' } catch { return 'gallery' } })
  const pluginRows = useMemo((): PluginRow[] => {
    const used = (id: string): number => (doc ? doc.list.steps.filter(x => x.plugin.id === id).length : 0)
    const running = registry.list().map((m): PluginRow => {
      const pkg = packages.get(m.id)
      const off = registry.disabledPlugins()[m.id]
      const keep = stored[m.id]
      const addr = m.package_url ?? keep?.url
      const image = pkg ? imageUrlFor(pkg) : (m.image ? { url: m.image.file, alt: m.image.alt } : undefined)
      const ops = m.operations.map(o => o.title ?? o.id)
      return { id: m.id, ...(image ? { image } : {}), operations: ops, ...(off ? { disabled: { reason: off.reason, crashed: off.crashed } } : {}), name: m.name, version: m.version, builtIn: !pkg, usedBy: used(m.id),
        ...(m.description ? { description: m.description } : {}), ...(m.license ? { license: m.license } : {}), ...(m.contact ? { contact: m.contact } : {}),
        ...(pkg ? { signed: pkg.signed, ...(pkg.signer ? { signer: pkg.signer } : {}), ...(pkg.origin ? { origin: pkg.origin } : {}), ...(addr ? { packageUrl: addr } : {}), ...(keep ? { stored: { size: keep.size, added: keep.added } } : {}) } : {}) }
    })
    const idle = notStarted.filter(n => !registry.has(n.id)).map((n): PluginRow => ({ id: n.id, name: n.name, version: n.version, builtIn: false, usedBy: used(n.id), notStarted: n.reason, stored: { size: n.size, added: n.added } }))
    return [...running, ...idle]
  }, [doc, pluginTick, regVersion, stored, notStarted])
  const catalogHost: PluginCatalogHost = (() => {
    const cat = mergedCatalog
    const installed: Record<string, string> = {}
    for (const r of pluginRows) if (!r.builtIn) installed[r.id] = r.version
    const updates: Record<string, string> = {}
    if (cat) for (const [id, e] of Object.entries(updatesFor(installed, cat))) updates[id] = e.latest
    return {
      status: catalogState.status, ...(cat ? { source: cat.host } : {}), busy: catalogBusy, updates,
      items: (cat?.plugins ?? []).map(e => { const v = e.versions.find(x => x.version === e.latest); return { id: e.id, name: e.name, version: e.latest, description: e.description, license: e.license, ...(e.contact ? { contact: e.contact } : {}), ...(e.image ? { image: e.image } : {}), ...(v ? { size: v.size } : {}), ...(e.downloads !== undefined ? { downloads: e.downloads } : {}), ...(e.replaces ? { replaces: e.replaces } : {}) } }),
      onInstall: id => void installFromCatalog(id), onOpen: () => loadCatalog(), onRetry: () => loadCatalog(true),
    }
  })()
  const saveKeys = (k: LoaderKey[]): void => { setKeys(k); try { localStorage.setItem('am.trustedKeys', JSON.stringify(k)) } catch { /* private window: keys last for this session only */ } }

  // ---- fonts and other assets
  const onAsset = (stepId: string, param: string, def: { type?: string; accept?: string } | unknown): void => {
    if ((def as { type?: string }).type === 'payload') { pickDrawing(stepId, param); return }   // a stored drawing (or model): import an SVG into the project store
    const d = def as { widget?: string; accept?: string[] | string }
    const kind = assetKind(d)
    if (kind !== 'font') { pickAssetFile(stepId, param, kind); return }
    if (fonts.length === 0) { pickAssetFile(stepId, param, 'font'); return }
    setFontFor({ stepId, param }); setDialog('font')
  }
  const setStepParam = (stepId: string, param: string, value: string): void => {
    const l = docRef.current?.list; if (!l) return
    onListChange({ ...l, steps: l.steps.map(s => (s.id === stepId ? { ...s, params: { ...s.params, [param]: value } } : s)) }, 'edit')
  }
  /** A setting that takes a stored drawing: pick an SVG, turn it into a drawing once, keep it in the project's store under a name from the file, and point the step at it. */
  const pickDrawing = (stepId: string, param: string): void => {
    const el = document.createElement('input'); el.type = 'file'; { const acc = fileAccept('.svg,image/svg+xml'); if (acc) el.accept = acc }
    el.onchange = async () => {
      const f = el.files?.[0]; if (!f) return
      // the SVG is kept as the project's source of truth; the drawing is extracted from it and checked now
      const r = session.importStoredSvg(f.name, await f.text())
      if (!r.ok) {
        const key = `mesh.${r.error.code}`
        say(t(key) !== key ? t(key) : t('panel.notSvg')); return
      }
      setStepParam(stepId, param, r.name)
    }
    el.click()
  }
  const pickAssetFile = (stepId: string, param: string, kind: AssetKind): void => {
    const el = document.createElement('input'); el.type = 'file'; { const a = fileAccept(ASSET_ACCEPT[kind]); if (a) el.accept = a }
    el.onchange = async () => {
      const f = el.files?.[0]; if (!f) return
      const bytes = new Uint8Array(await f.arrayBuffer())
      // the picker has no type list on every device, so the file is checked here: a picture setting never takes a font, and the other way round
      if (kind === 'image' && !isPicture(bytes)) { say(t('panel.notPicture')); return }
      if (kind === 'svg' && !/<svg[\s>]/i.test(new TextDecoder().decode(bytes.subarray(0, 2048)))) { say(t('panel.notSvg')); return }
      const id = `${kind}:${f.name}`; assets.set(id, bytes); setStepParam(stepId, param, id)
    }
    el.click()
  }
  const chooseFont = async (f: FontEntry): Promise<void> => {
    const id = `font:${f.family}`
    if (!assets.has(id)) assets.set(id, new Uint8Array(await (await fetch(f.file)).arrayBuffer()))
    if (fontFor) setStepParam(fontFor.stepId, fontFor.param, id)
    setDialog(null)
  }

  // ---- screens
  // one pill that shows the chosen language; a native select, so a phone, a tablet and a screen reader give their own list to choose from
  const langPills = (
    <span className="am-langs">
      <select className="am-langselect" aria-label="Language" value={lang} onChange={e => { const l = e.target.value as typeof lang; setLang(l); rememberLang(l) }}>
        {LANGS.map(l => <option key={l} value={l}>{l.toUpperCase()}</option>)}
      </select>
    </span>
  )
  const githubLink = <a className="am-ib am-github" href={GITHUB_URL} target="_blank" rel="noopener noreferrer" aria-label={t('app.github')} title={t('app.github')}><Icon name="github" /></a>
  const theme = useTheme()
  const themeToggle = <ThemeToggle t={t} mode={theme.mode} onToggle={theme.toggle} />
  const brand = (name: string | null): ReactElement => <><img src="brand/ateliermesh-mark-white.svg" alt="" width={32} height={32} /><span><b>{t('app.name')}</b><small>{name ? `${name}${savedAt ? ` · ${t('autosave.saved', { time: savedAt })}` : ''}` : t('app.by')}</small></span></>

  if (cannot) return <CannotRunView t={t} kind={cannot} onAction={() => { if (cannot === 'webgl') return navigator.clipboard?.writeText(location.href).catch(() => undefined); location.reload() }} />

  // ---- recipes
  const recipeEntries: RecipeEntry[] = storedRecipes.map(r => ({ id: r.id, name: r.name, steps: r.steps, created: r.updated }))
  const pickRecipeFile = (): Promise<File | null> => new Promise(resolve => {
    const i = document.createElement('input'); i.type = 'file'; { const a = fileAccept('.amrecipe,application/json'); if (a) i.accept = a }
    i.onchange = () => resolve(i.files?.[0] ?? null); i.oncancel = () => resolve(null); i.click()
  })
  const recipeError = (e: { code: string; params?: Record<string, unknown> }): string => { const k = `mesh.${e.code}`; const v = t(k, (e.params ?? {}) as Record<string, string | number>); return v === k ? t('recipe.badFile') : v }
  const recipesHost: RecipesHost = {
    entries: recipeEntries,
    load: async id => { const rec = await getRecipe(id); if (!rec) return null; const p = parseRecipe(rec.text); return p.ok ? p.recipe : null },
    save: async (recipe, where) => {
      if (where === 'file') { download(`${safe(recipe.name)}.amrecipe`, new TextEncoder().encode(serializeRecipe(recipe)), 'application/json'); say(t('recipe.downloaded')); return }
      await putRecipe({ name: recipe.name, steps: recipe.steps.steps.length, text: serializeRecipe(recipe) })
      await refreshRecipes(); say(t('recipe.saved'))
    },
    remove: async (id, name) => { if (confirm(t('recipe.deleteAsk', { name }))) { await deleteRecipe(id); await refreshRecipes() } },
    openFile: async () => { const f = await pickRecipeFile(); if (!f) return null; const r = parseRecipe(await f.text()); return r.ok ? { recipe: r.recipe } : { errors: r.errors } },
    describeError: recipeError,
  }
  const catalogSetting = { value: catalogAddress, placeholder: DEFAULT_CATALOG_PATH, onChange: (v: string): void => { if (v !== '' && resolveCatalogAddress(v) === null) return; saveCatalogAddress(v); setCatalogAddressState(v); catalogFetchedAt.current = 0; setCatalogState({ status: 'loading' }) } }
  const about = { name: 'AtelierMesh', version: __APP_VERSION__, build: __APP_BUILD__, licence: 'AGPL-3.0-or-later', plugins: registry.list().map(m => ({ name: m.name, version: m.version, builtin: registry.sourceOf(m.id)?.kind === 'builtin' })) }
  // the catalogues the app reads: the default one (this site's or the address the person set) and the ones the person added
  const defaultName = catalogState.catalog?.host ?? location.host
  const catalogueCards: CatalogueCard[] = [
    { id: 'default', name: defaultName, address: resolveCatalogAddress(catalogAddress) ?? DEFAULT_CATALOG_PATH, isDefault: true,
      offers: [{ kind: 'plugins', offered: catalogState.status !== 'unavailable', ...(catalogState.catalog ? { count: catalogState.catalog.plugins.length } : {}) }, { kind: 'designs', offered: galleryOk === true || galleryWhy === 'empty', ...(galleryWhy === 'empty' ? { count: 0 } : {}) }] },
    ...added.map((c): CatalogueCard => ({ id: c.id, name: c.name, address: c.base, isDefault: false, removable: true,
      offers: [{ kind: 'plugins', offered: c.offers.plugins !== undefined && c.plugins, ...(c.offers.plugins !== undefined ? { count: c.offers.plugins } : {}) }, { kind: 'designs', offered: c.offers.designs !== undefined && c.designs, ...(c.offers.designs !== undefined ? { count: c.offers.designs } : {}) }] })),
  ]
  const catalogueActions = {
    onCheck: async (name: string, address: string) => {
      const p = await probeCatalogue(address)
      if (!p.ok) return p
      if (p.base === galleryBase || added.some(c => c.base === p.base)) return { ok: false as const, reason: 'duplicate' as const }
      return { ok: true as const, name: name || p.name, address: p.base, offers: p.offers }
    },
    onAdd: (c: { name: string; address: string; plugins: boolean; designs: boolean; offers: { plugins?: number; designs?: number } }): void => {
      const next = [...added, { id: Math.random().toString(36).slice(2, 10), name: c.name.slice(0, 80), base: c.address, plugins: c.plugins, designs: c.designs, offers: c.offers }]
      saveCatalogues(next); setAdded(next); catalogFetchedAt.current = 0
    },
    onRemove: (id: string): void => { const next = added.filter(c => c.id !== id); saveCatalogues(next); setAdded(next); setExtraCats(o => { const { [id]: _gone, ...rest } = o; return rest }) },
  }
  const gallerySources = [{ base: galleryBase, name: defaultName }, ...added.filter(c => c.designs).map(c => ({ base: c.base, name: c.name }))]
  const settingsProps = { showPersonalised, catalog: catalogSetting, about, catalogues: catalogueCards, catalogueActions, onShowPersonalised: (on: boolean): void => { setShowPersonalisedState(on); try { localStorage.setItem('am.personaliseOption', on ? '1' : '0') } catch { /* private window */ } if (!on) setPersonalised(false) } }
  // "Build your own plugin": only when the build shipped the help (a development build without it hides the entry)
  const buildHelp: PluginManagerProps['build'] | undefined = typeof __PLUGIN_GUIDE_URL__ === 'string'
    ? { guideUrl: __PLUGIN_GUIDE_URL__, ...(__PLUGIN_PROMPT__ ? { promptText: __PLUGIN_PROMPT__ } : {}), ...(__PLUGIN_PROMPT_NO_NPM__ ? { promptTextNoNpm: __PLUGIN_PROMPT_NO_NPM__ } : {}), ...(__PLUGIN_EXAMPLE_URL__ ? { exampleUrl: __PLUGIN_EXAMPLE_URL__ } : {}), ...(__PLUGIN_KIT_URL__ ? { kitUrl: __PLUGIN_KIT_URL__ } : {}) }
    : undefined
  const pluginProps: Omit<PluginManagerProps, 't' | 'onClose'> = { ...(buildHelp ? { build: buildHelp } : {}), plugins: pluginRows, keys, note: pluginNote, onLoadFile: f => void f.arrayBuffer().then(b => installPackage(new Uint8Array(b), f.name)),
          onLoadUrl: u => void fetchPluginBytes(u, { allowHttp: devMode }).then(r => installPackage(r.bytes, r.url, 'url', r.url), (e: unknown) => say2('error', t('plugins.cannotFetch', { message: loadErrorText(t, e) }))),
          onToggle: (id, on) => { registry.setEnabled(id, on); void setStoredEnabled(id, on) },
          onRemove: removePlugin, storage: { available: storage.available, count: Object.keys(stored).length, max: 20 },
          approval: approval && !approval.own ? approval.data : null, onApprove: () => approval?.resolve(true), onCancelApproval: () => approval?.resolve(false),
          view: pluginView, onView: v => { setPluginView(v); try { localStorage.setItem('am.pluginView', v) } catch { /* private window */ } },
          onDownload: downloadPlugin, ...(galleryOk || galleryWhy === 'empty' ? { onShare: sharePlugin } : {}), onCheckUpdate: id => void checkUpdate(id), checking, catalog: catalogHost,
          onTrust: (name, publicKey) => saveKeys([...keys, { name, publicKey }]), onForget: name => saveKeys(keys.filter(k => k.name !== name)) }
  const [homeDialog, setHomeDialog] = useState<null | 'settings' | 'plugins'>(null)
  const overlays = (
    <Fragment>
      {opener.modal}
      <LoadingView t={t} state={loading.state} onStop={loading.stop} {...(loadingDelay !== undefined ? { delay: loadingDelay } : {})} {...(opening ? { intro: (
        <div className="am-loadintro">
          {opening.shared ? <p className="am-help"><Icon name="link" size={14} /> {t('open.shared')}</p> : null}
          <img src={opening.picture} alt="" width={320} height={220} />
          <h2>{opening.name ? t('open.title', { name: opening.name }) : t('page.loading')}</h2>
          {opening.author ? <p className="am-help">{t('gallery.by', { name: opening.author })}</p> : null}
          <p className="am-help">{t('open.copy')}</p>
        </div>) } : {})} />
      {busy ? <div className="am-busyline" role="status"><span>{busy}</span><button type="button" onClick={() => setBusy(null)}>{t('work.stop')}</button></div> : null}
      {notice ? <div className="am-notice" role="status">{notice}</div> : null}
      {dialog === 'list' ? <ProjectListDialog t={t} items={savedItems} error={listError} onOpen={id => void openSaved(id)} onClose={() => setDialog(null)}
        onDelete={(id, name) => { if (confirm(`Delete "${name}" from this browser?`)) void deleteProject(id).then(async () => { if (storedId.current === id) storedId.current = null; setSaved(await listProjects()) }) }} /> : null}
      {exampleAsk ? (
        <Dialog title={exampleAsk.rows.length === 1 ? t('plugins.missingTitleOne') : t('plugins.missingTitle', { count: exampleAsk.rows.length })} onClose={() => exampleAsk.resolve(null)} t={t}>
          <p>{t('plugins.missingText', { name: exampleAsk.name })}</p>
          <ul className="am-list">{exampleAsk.rows.map(r => (
            <li key={r.id}><div className="am-grow"><strong>{r.name}</strong><span>{r.fromCatalogue ? t('plugins.fromCatalogue', { catalog: r.fromCatalogue }) : `${t('plugins.notInCatalogue')}. ${t('plugins.askedSeparately')}`}</span></div></li>
          ))}</ul>
          <p className="am-help">{t('plugins.openWithoutHint')}</p>
          <div className="am-actions">
            <button type="button" onClick={() => exampleAsk.resolve(null)}>{t('open.cancel')}</button>
            <button type="button" onClick={() => exampleAsk.resolve('anyway')}>{t('plugins.openWithout')}</button>
            <button type="button" className="am-primary" data-autofocus onClick={() => exampleAsk.resolve('install')}>{t('plugins.installOpen')}</button>
          </div>
        </Dialog>
      ) : null}
      {reload ? (
        <Dialog title={t('plugins.reload.title')} onClose={() => setReload(null)} t={t}>
          <p>{t('plugins.reload.body')}</p>
          <ul className="am-list">{reload.items.map(i => <li key={i.id}><strong>{i.id}</strong>{i.version ? ` ${i.version}` : ''}<br /><span className="am-help">{i.origin ? t('plugins.reload.saved', { host: new URL(i.origin).host }) : t('plugins.reload.noAddress')}</span></li>)}</ul>
          <div className="am-actions"><button type="button" onClick={() => setReload(null)}>{t('plugins.reload.skip')}</button><button type="button" className="am-primary" data-autofocus onClick={() => void runReload(reload.items)}>{t('plugins.reload.load')}</button></div>
        </Dialog>
      ) : null}
      {outside ? (
        <Dialog title={t('plugins.outsideTitle')} onClose={() => outside.resolve(false)} strict t={t}>
          <p className="am-outsidehost"><code>{outside.host}</code></p>
          <p>{t('plugins.outsideText', { plugin: outside.id, catalog: catalogState.catalog?.host ?? location.host })}</p>
          <p><strong>{t('plugins.outsideTrust')}</strong></p>
          <p className="am-help">{t('plugins.openWithoutHint')}</p>
          <div className="am-actions"><button type="button" className="am-primary" data-autofocus onClick={() => outside.resolve(false)}>{t('plugins.outsideNo')}</button><button type="button" onClick={() => outside.resolve(true)}>{t('plugins.outsideYes')}</button></div>
        </Dialog>
      ) : null}
      {approval?.own ? <ApprovalDialog t={t} a={approval.data} onApprove={() => approval.resolve(true)} onCancel={() => approval.resolve(false)} /> : null}
    </Fragment>
  )

  if (!doc || !three) {
    return (
      <div className="am-shell"><Intro dark={theme.mode === 'dark'} /><Welcome t={t} />
        <header className="am-editor-bar"><div className="am-brand">{brand(null)}</div><span className="am-spacer" /><button type="button" className="am-ib" aria-label={t('settings.open')} title={t('settings.open')} onClick={() => setHomeDialog('settings')}><Icon name="settings" /></button>{themeToggle}{langPills}{githubLink}</header>
        <UploadPage t={t} journey="A" samples={galleryOk ? [] : sampleItems} saved={savedItems} examples={<Gallery key={galleryKey} t={t} lang={lang} sources={gallerySources} installed={registry.list().map(m => ({ id: m.id, name: m.name }))} others={(mergedCatalog?.plugins ?? []).filter(p => !registry.has(p.id)).map(p => ({ id: p.id, name: p.name }))} onAvailable={(ok, why) => { setGalleryOk(ok); setGalleryWhy(ok ? null : why ?? null) }} onOpen={it => void openExample(it)} say={say} />} onFile={f => void openFile(f)} onSample={id => { const x = SAMPLES.find(y => y.id === id); if (x) void (async () => { try { start(await x.mesh(), sampleName(t, x), sampleSteps(registry, x)) } catch (e) { say(e instanceof Error ? e.message : String(e)) } })() }} onOpenSaved={id => void openSaved(id)}
          onShowSaved={() => { setListError(null); setDialog('list') }}>
          <SharedList t={t} records={shared} say={say} onForget={id => { const next = shared.filter(r => r.id !== id); saveShared(next); setShared(next) }} onRemove={async r => { const ok = await withdrawShared(r); if (ok) { const next = shared.filter(x => x.id !== r.id); saveShared(next); setShared(next); say(t('share.gone')) } else say(t('share.error.network')); return ok }} />
          {startNote === 'removed' || galleryWhy === 'down' ? (
            <div className="am-startnote" role="status">
              {startNote === 'removed' ? <p><strong>{t('gallery.removedTitle')}</strong> {t('gallery.removed')}</p> : null}
              {galleryWhy === 'down' ? <p><Icon name="info" size={14} /> {t('gallery.offline')} <button type="button" className="am-link" onClick={() => { setGalleryOk(null); setGalleryWhy(null); setGalleryKey(k => k + 1) }}>{t('gallery.tryAgain')}</button></p> : null}
            </div>
          ) : null}
        </UploadPage>
        {homeDialog ? <SettingsShell t={t} initial={homeDialog === 'plugins' ? 'plugins' : 'general'} settings={settingsProps} plugins={pluginProps} catalogues={catalogueCards} catalogueActions={catalogueActions} onClose={() => setHomeDialog(null)} /> : null}
        {overlays}
      </div>
    )
  }

  const designerList = doc.list
  return (
    <div className="am-shell"><Intro dark={theme.mode === 'dark'} />
      <EditorPage
        t={t} registry={registry} three={three} list={doc.list} onListChange={onListChange} run={run} onResult={onResult} onViewer={v => { viewer.current = v }}
        source={doc.base} file={{ name: doc.name, width: measureMesh(doc.base).size[0] }} mode="standalone"
        baseParts={{ segments: segmentTable(doc.base).map(s => s.name), groups: groupNames(doc.base) }}
        personalised={personalised} onPersonalised={setPersonalised}
        settings={settingsProps}
        plugins={pluginProps}
        store={store}
        colours={{ map: session.doc?.colours ?? null, onChange: session.setColours, maxColours: null }}
        recipes={recipesHost}
        onAsset={onAsset} stepDefaults={(plugin, op) => (plugin === CORE_PLUGIN_ID && op === 'emboss' ? { font: 'font:Roboto' } : {})}
        undo={{ canUndo: session.canUndo, canRedo: session.canRedo, onUndo: session.undo, onRedo: session.redo }}
        dirty={dirty} savedAt={savedAt} onSave={async () => { await saveBrowser(doc, doc.name) }}
        onLeave={() => { session.close(); storedId.current = null }}
        pictures={pictures} fonts={fonts.map(f => ({ id: `font:${f.family}`, family: f.family }))} title={t('app.name')} brand={brand(doc.name)} barEnd={<>{themeToggle}{langPills}{githubLink}</>}
        onApply={() => setDialog('apply')} canApply={canApplyPermanently({ base: doc.base, list: doc.list, rollback: doc.rollback }).ok}
        actions={<>
          {personalised && showPersonalised ? <button type="button" className="am-barbtn" aria-label={t('editor.previewCustomer')} title={t('editor.previewCustomer')} onClick={() => setCustomer(true)}><Icon name="user" /><span className="am-btn-label">{t('editor.previewCustomer')}</span></button> : null}
          <button type="button" className="am-barbtn" aria-label={t('editor.save')} title={t('editor.save')} onClick={() => { setSaveName(doc.name); setDialog('save') }}><Icon name="save" /><span className="am-btn-label">{t('editor.save')}</span></button>
          <button type="button" className="am-barbtn am-primary" aria-label={t('editor.export')} title={t('editor.export')} onClick={() => setDialog('export')}><Icon name="download" /><span className="am-btn-label">{t('editor.export')}</span></button>
        </>}
      />
      {customer ? (
        <PersonaliseOverlay list={designerList} {...(session.doc?.colours ? { colours: { map: session.doc.colours } } : {})} registry={registry} store={store} run={(l, o) => run(l, o)} t={t} three={three} previewAsCustomer
          pictures={pictures} fonts={fonts.map(f => ({ id: `font:${f.family}`, family: f.family }))} onDone={() => setCustomer(false)} onClose={() => setCustomer(false)} />
      ) : null}
      {dialog === 'export' ? (
        <Dialog title={t('export.title')} onClose={() => setDialog(null)} t={t}>
          <div className="am-radio-list">
            {(['prusa', 'bambu', '3mf', 'stl'] as const).map(k => (
              <label key={k} className="am-choice"><input type="radio" name="export-kind" checked={exportKind === k} onChange={() => setExportKind(k)} /><span><strong>{t(`export.${k}`)}</strong><br /><span className="am-help">{t(`export.${k}Hint`)}</span></span></label>
            ))}
          </div>
          <div className="am-actions">
            <button type="button" onClick={() => void savePackage(doc)}>{t('save.fileHint').length > 0 ? 'Package (.zip)' : 'Package'}</button>
            <button type="button" className="am-primary" onClick={() => void exportNow(doc, exportKind)}>{t('export.download', { format: exportKind === 'stl' ? 'STL' : '3MF' })}</button>
          </div>
        </Dialog>
      ) : null}
      {dialog === 'save' ? (
        <Dialog title={t('save.title')} onClose={() => setDialog(null)} t={t}>
          <div className="am-field"><label htmlFor="save-name">{t('save.name')}</label><input id="save-name" type="text" value={saveName} onChange={e => setSaveName(e.target.value)} /></div>
          <div className="am-radio-list">
            <button type="button" className="am-primary" onClick={() => { void saveBrowser(doc, saveName || doc.name); setDialog(null) }}>{t('save.browser')}</button><span className="am-help">{t('save.browserHint')}</span>
            <button type="button" onClick={() => { void saveFile(doc, saveName || doc.name); setDialog(null) }}>{t('save.file')}</button><span className="am-help">{t('save.fileHint')}</span>
            {galleryOk === true || galleryWhy === 'empty' ? <><button type="button" onClick={() => setDialog('share')}><Icon name="share" size={16} /> {t('share.asExample')}</button><span className="am-help">{t('share.asExampleHint')}</span></> : null}
          </div>
          <div className="am-actions"><button type="button" onClick={() => setDialog(null)}>{t('settings.close')}</button></div>
        </Dialog>
      ) : null}
      {dialog === 'share' && gallerySources[0] ? (
        <ShareDialog t={t} name={saveName || doc.name} fileName={shareFile(doc)} size={shareSize} steps={doc.list.steps.length} stored={Object.keys(doc.store ?? {})}
          makePicture={async angle => { const th = threeRef.current, m = lastResult.current?.mesh ?? doc.base; if (!th || !m) return null; try { return await renderPreviewPng(th, m, { view: angle === '3d' ? 'iso' : angle, quality: 'auto' }) } catch { return null } }}
          send={async (fields, picture) => { const base = (gallerySources[0] as { base: string }).base; return sendShare(base, fields, projectBytes({ ...doc, name: fields.name }, picture), picture) }}
          onSent={r => { const rec: SharedRecord = { id: r.id, key: r.key, base: (gallerySources[0] as { base: string }).base, name: r.name, created: new Date().toISOString(), state: 'pending' }; const next = [rec, ...shared]; saveShared(next); setShared(next) }}
          onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'apply' ? (
        <Dialog title={t('apply.title', { step: doc.name })} onClose={() => setDialog(null)} strict t={t}>
          <p>{t('apply.body')}</p>
          <div className="am-actions"><button type="button" data-autofocus onClick={() => setDialog(null)}>{t('apply.cancel')}</button><button type="button" className="am-danger" onClick={() => void apply()}>{t('apply.confirm')}</button></div>
        </Dialog>
      ) : null}
      {dialog === 'font' ? (
        <Dialog title={t('field.font')} onClose={() => setDialog(null)} t={t}>
          <ul className="am-list">{fonts.map(f => <li key={f.family}><button type="button" onClick={() => void chooseFont(f)}>{f.weightRange ? `${f.family} (${f.weightRange})` : f.family}</button></li>)}</ul>
          <div className="am-actions"><button type="button" onClick={() => { setDialog(null); if (fontFor) pickAssetFile(fontFor.stepId, fontFor.param, 'font') }}>{t('plugins.file')}</button><button type="button" onClick={() => setDialog(null)}>{t('settings.close')}</button></div>
        </Dialog>
      ) : null}
      {overlays}
    </div>
  )
}

/** The preview pictures of the saved projects as object URLs for the lists; they are revoked when the list changes. */
function useSavedImages(list: StoredProject[]): SavedItem[] {
  const items = useMemo(() => list.map(x => ({ id: x.id, name: x.name, updated: x.updated, size: x.size, ...(x.preview ? { image: URL.createObjectURL(new Blob([x.preview as BlobPart], { type: 'image/png' })) } : {}) })), [list])
  useEffect(() => () => { for (const i of items) if (i.image) URL.revokeObjectURL(i.image) }, [items])
  return items
}
