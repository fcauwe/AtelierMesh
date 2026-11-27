// "Add a step" (design round 5, docs/proposals/design-handoff-v5-feedback.md): a menu of every operation of every plugin that is switched on.
// Headings, a one-row submenu for a plugin with several operations (a flyout on a desktop, a second screen in the sheet on a phone), search above 12 operations,
// a "More" group for the low-importance ones, the last three steps used, and the recipe and plugin rows at the bottom. The rules are in `addStepModel.ts`.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { operationAvailability } from '@ateliermesh/core'
import type { Registry } from '@ateliermesh/core'
import { CORE_PLUGIN_ID } from '@ateliermesh/plugins'
import { tx, useMediaQuery } from './common'
import { Icon, NamedIcon } from './icons'
import { StepIcon } from './StepListView'
import { useRegistryVersion } from './CrashBanner'
import { buildMenu, headingOf, normalise, searchOps, whereOf } from './addStepModel'
import type { MenuModel, MenuOp, Row } from './addStepModel'
import type { T } from './common'

const CATEGORY_TITLE: Record<string, string> = { prepare: 'Prepare', shape: 'Shape', style: 'Art style', surface: 'On the surface', check: 'Checks' }
const RECENT_KEY = 'am.addstep.recent', MORE_KEY = 'am.addstep.more'
const read = (k: string): string | null => { try { return localStorage.getItem(k) } catch { return null } }
const write = (k: string, v: string): void => { try { localStorage.setItem(k, v) } catch { /* a private window: the choice lasts until the page is closed */ } }
const key = (i: MenuOp): string => `${i.plugin}|${i.op.id}`

export function AddStepMenu({ t, registry, onAdd, onManage, onApplyRecipe, onSaveRecipe, canSaveRecipe = true, kind = null, storeEntries = 0, compact = false, block = false }: { t: T; registry: Registry; onAdd: (pluginId: string, op: string) => void; onManage?: () => void; onApplyRecipe?: () => void; onSaveRecipe?: () => void; canSaveRecipe?: boolean
  /** What the last step produced (`mesh`, `drawing`, ...); null or absent means a mesh. Steps that take another kind are shown disabled. */
  kind?: string | null
  /** How many items the project store holds; `load` is disabled while there are none. */
  storeEntries?: number
  /** Only the plus sign (its name stays for a screen reader): for the one row of tabs and the button in the steps column. */
  compact?: boolean
  /** A full-width button, the first thing of the Steps panel. */
  block?: boolean }): ReactElement {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [sub, setSub] = useState<string | null>(null)
  const [moreOpen, setMoreOpen] = useState(() => read(MORE_KEY) === '1')
  const [recent, setRecent] = useState<string[]>(() => { try { return JSON.parse(read(RECENT_KEY) ?? '[]') as string[] } catch { return [] } })
  const [typing, setTyping] = useState(false)
  const [said, setSaid] = useState('')
  const [anchor, setAnchor] = useState<{ left: number; top: number; maxHeight: number } | null>(null)
  const phone = useMediaQuery('(max-width: 768px)')
  const root = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const flyRef = useRef<HTMLDivElement>(null)
  const [flyAt, setFlyAt] = useState<{ left: number; top: number; maxHeight: number } | null>(null)
  useRegistryVersion(registry)   // a plugin switched off or on changes the menu

  const title = (plugin: string, id: string, fallback: string): string => { const k = `step.op.${plugin === CORE_PLUGIN_ID && id === 'emboss' ? 'text' : plugin === CORE_PLUGIN_ID && id === 'emboss_svg' ? 'svg' : id}`; const v = t(k); return v !== k ? v : fallback }
  const items: MenuOp[] = registry.list().filter(m => registry.isEnabled(m.id)).flatMap(m => m.operations.map(op => ({
    plugin: m.id, pluginName: tx(t, `plugin.${m.id}.name`, m.name.replace(/^AtelierMesh /, '').replace(/^./, c => c.toUpperCase())), ...(m.icon ? { pluginIcon: m.icon } : {}),
    op, title: title(m.id, op.id, op.title ?? op.id), heading: headingOf({ op }), low: op.importance === 'low',
    ...(() => { const a = operationAvailability(m.id, op, { kind, storeEntries }); return a.state === 'disabled' ? { reason: a.reason } : {} })(),
  })))
  const reasonText = (r: string): string => tx(t, `addStep.${r}`, r === 'needs.drawing' ? 'Needs a drawing' : r === 'needs.mesh' ? 'Needs a model' : r === 'needs.stored' ? 'Nothing stored yet' : `Needs ${r.replace(/^needs\./, '')}`)
  const model: MenuModel = useMemo(() => buildMenu(items), [items.map(key).join(',') + items.map(i => i.title).join(',') + items.map(i => i.reason ?? '').join(',')])   // the reasons too: a row is enabled or disabled as the project changes (Load once something is stored)
  const headingTitle = (c: string): string => tx(t, `addStep.cat.${c}`, CATEGORY_TITLE[c] ?? c.replace(/_/g, ' ').replace(/^./, m => m.toUpperCase()))
  const results = useMemo(() => searchOps(items, query), [query, model])
  const searching = model.showSearch && normalise(query) !== ''
  const recentItems = recent.map(k => items.find(i => key(i) === k)).filter((i): i is MenuOp => !!i && !i.reason)   // a step that cannot be added now is left out; it is in the list with its reason

  const close = (refocus = true): void => { setOpen(false); setQuery(''); setSub(null); setFlyAt(null); setTyping(false); if (refocus) (root.current?.querySelector('button[aria-haspopup]') as HTMLElement | null)?.focus() }
  // a submenu: on a desktop it is drawn beside the panel, outside it, at a fixed place worked out from the panel and the row; on a phone it is a second screen in the sheet
  const openSub = (plugin: string, row: Element): void => {
    if (!phone) {
      const pr = (panelRef.current ?? row).getBoundingClientRect(), r = row.getBoundingClientRect(), width = 260
      const left = pr.right + 6 + width <= window.innerWidth - 8 ? pr.right + 6 : Math.max(8, pr.left - 6 - width)
      // level with the row, but moved up when the list would run past the bottom of the window (rows are about 44 px high, plus the padding and the border)
      const height = Number((row as HTMLElement).dataset['count'] ?? 6) * 44 + 12
      const top = Math.max(8, Math.min(r.top, window.innerHeight - height - 8))
      setFlyAt({ left, top, maxHeight: window.innerHeight - top - 8 })
    }
    setSub(plugin)
  }
  const choose = (i: MenuOp): void => {
    if (i.reason) return   // disabled: the reason is already on screen
    const next = [key(i), ...recent.filter(k => k !== key(i))].slice(0, 3)
    setRecent(next); write(RECENT_KEY, JSON.stringify(next))
    setSaid(tx(t, 'addStep.added', 'Added: {{step}}', { step: i.title }))
    close(false); onAdd(i.plugin, i.op.id)
  }
  // on a desktop the panel is drawn at the editor's root, below the button (a step column that scrolls would clip it and scroll sideways). Its place is worked out when the
  // menu is opened, before it is drawn the first time, and again when the window is resized or something scrolls.
  const place = useCallback((): { left: number; top: number; maxHeight: number } | null => {
    const b = root.current?.querySelector('button[aria-haspopup]')?.getBoundingClientRect()
    if (!b) return null
    const width = Math.min(344, window.innerWidth - 16), top = b.bottom + 6
    return { left: Math.max(8, Math.min(b.left, window.innerWidth - width - 8)), top, maxHeight: Math.max(240, Math.min(620, window.innerHeight - top - 8)) }
  }, [])
  const openMenu = (): void => { if (!phone) setAnchor(place()); setOpen(true) }
  useEffect(() => {
    if (!open || phone) { if (!open) setAnchor(null); return }
    const follow = (): void => setAnchor(place())
    window.addEventListener('resize', follow); window.addEventListener('scroll', follow, true)
    return () => { window.removeEventListener('resize', follow); window.removeEventListener('scroll', follow, true) }
  }, [open, phone, place])
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent): void => { const t = e.target as Node; if (root.current && !root.current.contains(t) && !panelRef.current?.contains(t) && !flyRef.current?.contains(t)) close(false) }
    document.addEventListener('mousedown', away)
    if (!phone) setTimeout(() => (field.current ?? panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]'))?.focus(), 0)   // a phone keeps the keyboard down until the person types
    return () => document.removeEventListener('mousedown', away)
  }, [open, phone])

  // the submenu is drawn outside the panel (the panel's list scrolls and would clip it), so keys move within the one that has the focus
  const menuItems = (): HTMLElement[] => { const scope = flyRef.current?.contains(document.activeElement) ? flyRef.current : panelRef.current; return [...(scope?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].filter(e => e.offsetParent !== null || e.getClientRects().length > 0) }
  const keys = (e: KeyboardEvent): void => {
    const all = menuItems(), at = document.activeElement as HTMLElement
    const i = all.indexOf(at)
    const inField = at === field.current
    if (e.key === 'Escape') {
      e.preventDefault()
      if (sub) { setSub(null); return }
      if (inField && query) { setQuery(''); return }
      close(); return
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); all[inField ? 0 : (i + 1) % all.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (i === 0 && field.current) field.current.focus(); else all[(i - 1 + all.length) % all.length]?.focus() }
    else if (e.key === 'Home' && !inField) { e.preventDefault(); all[0]?.focus() }
    else if (e.key === 'End' && !inField) { e.preventDefault(); all[all.length - 1]?.focus() }
    else if (e.key === 'ArrowRight' && at?.dataset['group']) { e.preventDefault(); openSub(at.dataset['group'] as string, at); setTimeout(() => flyRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus(), 0) }
    else if (e.key === 'ArrowLeft' && sub) { e.preventDefault(); const g = sub; setSub(null); setTimeout(() => panelRef.current?.querySelector<HTMLElement>(`[data-group="${g}"]`)?.focus(), 0) }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !inField && model.showSearch && at?.getAttribute('role') === 'menuitem') { field.current?.focus() }   // typing from the list goes to the search field
  }

  const row = (i: MenuOp, where?: string): ReactElement => (
    <button key={key(i)} type="button" role="menuitem" className={i.reason ? 'am-mi-disabled' : undefined} {...(i.reason ? { 'aria-disabled': 'true' as const, 'aria-describedby': `am-reason-${key(i).replace(/\W/g, '_')}` } : {})} onClick={() => choose(i)}>
      <StepIcon op={i.op.id} icon={i.op.icon} />
      <span className="am-mi-text"><span className="am-mi-name">{where !== undefined ? highlight(i.title, query) : i.title}</span>{i.reason ? <span className="am-mi-reason" id={`am-reason-${key(i).replace(/\W/g, '_')}`}>{reasonText(i.reason)}</span> : null}</span>
      {where ? <span className="am-mi-where">{where}</span> : null}
    </button>
  )
  const groupRow = (r: Extract<Row, { kind: 'group' }>): ReactElement => {
    const opened = sub === r.plugin
    return (
      <div key={r.plugin} className="am-mi-groupwrap">
        <button type="button" role="menuitem" data-group={r.plugin} data-count={r.items.length} aria-haspopup="menu" aria-expanded={opened} onClick={e => { if (opened) setSub(null); else openSub(r.plugin, e.currentTarget) }}>
          <NamedIcon name={r.icon} size={18} /><span className="am-mi-name">{r.name}</span><span className="am-mi-count">{r.items.length}</span><Icon name="chevronRight" size={16} />
        </button>
        {opened && !phone && flyAt && host ? createPortal(<div ref={flyRef} className="am-menu am-flyout" role="menu" aria-label={r.name} style={{ left: flyAt.left, top: flyAt.top, maxHeight: flyAt.maxHeight }}>{r.items.map(i => row(i))}</div>, host) : null}
      </div>
    )
  }
  const section = (s: { heading: string; rows: Row[] }, small = false): ReactElement => (
    <div key={`${small ? 'm-' : ''}${s.heading}`} role="group" aria-label={headingTitle(s.heading)}>
      <div role="presentation" className={`am-menu-group${small ? ' am-menu-small' : ''}`}>{headingTitle(s.heading)}</div>
      {s.rows.map(r => (r.kind === 'op' ? row(r.item) : groupRow(r)))}
    </div>
  )
  const subPlugin = phone && sub ? model.main.flatMap(s => s.rows).find((r): r is Extract<Row, { kind: 'group' }> => r.kind === 'group' && r.plugin === sub) : undefined
  const recipeRows = onApplyRecipe || onSaveRecipe || onManage
  const bottom = recipeRows && !(phone && typing) ? (
    <div className={`am-menu-foot${phone ? ' am-menu-foot-phone' : ''}`} role="group" aria-label={tx(t, 'addStep.cat.recipes', 'Recipes')}>
      {onApplyRecipe ? <button type="button" role="menuitem" onClick={() => { close(false); onApplyRecipe() }} aria-label={tx(t, 'recipe.applyMenu', 'Apply a recipe…')}><Icon name="recipe" size={16} /><span>{phone ? tx(t, 'addStep.applyRecipeShort', 'Apply recipe') : tx(t, 'recipe.applyMenu', 'Apply a recipe…')}</span></button> : null}
      {onSaveRecipe ? <button type="button" role="menuitem" disabled={!canSaveRecipe} onClick={() => { close(false); onSaveRecipe() }} aria-label={tx(t, 'recipe.saveMenu', 'Save as a recipe…')}><Icon name="save" size={16} /><span>{phone ? tx(t, 'addStep.saveRecipeShort', 'Save recipe') : tx(t, 'recipe.saveMenu', 'Save as a recipe…')}</span></button> : null}
      {onManage ? <button type="button" role="menuitem" onClick={() => { close(false); onManage() }} aria-label={tx(t, 'addStep.plugins', 'Plugins…')}><Icon name="plug" size={16} /><span>{phone ? tx(t, 'addStep.pluginsShort', 'Plugins') : tx(t, 'addStep.plugins', 'Plugins…')}</span></button> : null}
    </div>
  ) : null

  // the panel is drawn at the editor's root, not inside the step column or the chip row (they scroll and clip): a fixed panel there would be clipped or placed against them
  const host = open ? (root.current?.closest('.am-editor') ?? document.body) : null
  const panel = open ? (
    <Fragment>
      {phone ? <div className="am-menu-backdrop" aria-hidden="true" /> : null}
      <div ref={panelRef} className={`am-menu am-addpanel${phone ? ' am-menu-sheet' : ' am-menu-pop'}`} {...(!phone ? { style: anchor ? { left: anchor.left, top: anchor.top, maxHeight: anchor.maxHeight } : { visibility: 'hidden' as const } } : {})} role="dialog" aria-label={t('addStep.title')} aria-modal={phone ? 'true' : undefined}>
            {phone ? (
              subPlugin ? (
                <div className="am-menu-head"><button type="button" className="am-menu-back" onClick={() => setSub(null)}><Icon name="arrowLeft" size={16} />{tx(t, 'addStep.back', 'Back')}</button><h3>{subPlugin.name}</h3></div>
              ) : (
                <div className="am-menu-head"><h3>{t('addStep.title')}</h3><button type="button" className="am-menu-x" aria-label={tx(t, 'addStep.close', 'Close')} onClick={() => close()}><Icon name="close" size={16} /></button></div>
              )
            ) : <div role="presentation" className="am-menu-title">{t('addStep.title')}</div>}
            {model.showSearch && !subPlugin ? (
              <div className="am-menu-search">
                <Icon name="search" size={16} />
                <input ref={field} type="search" value={query} placeholder={tx(t, 'addStep.search', 'Search steps')} aria-label={tx(t, 'addStep.search', 'Search steps')} aria-controls="am-addmenu-list" autoComplete="off"
                  onFocus={() => setTyping(true)} onBlur={() => setTyping(false)} onChange={e => { setQuery(e.target.value); setSub(null) }}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); const first = results.find(r => !r.reason); if (first) choose(first) } }} />
                {query ? <button type="button" className="am-menu-clear" aria-label={tx(t, 'addStep.clear', 'Clear the search')} onClick={() => { setQuery(''); field.current?.focus() }}><Icon name="close" size={14} /></button> : null}
              </div>
            ) : null}
            {model.showSearch && !subPlugin && !searching && recentItems.length > 0 ? (
              <div className="am-menu-recent"><span className="am-menu-recent-l"><Icon name="history" size={14} />{tx(t, 'addStep.recent', 'Recent')}</span>{recentItems.map(i => <button key={key(i)} type="button" className="am-chip" onClick={() => choose(i)}>{i.title}</button>)}</div>
            ) : null}
            <div className="am-menu-scroll" id="am-addmenu-list" role="menu" aria-label={t('addStep.title')}>
              {subPlugin ? subPlugin.items.map(i => row(i)) : searching ? (
                results.length === 0 ? (
                  <div className="am-menu-empty" role="presentation"><Icon name="search" size={20} /><p>{tx(t, 'addStep.noResults', 'No step matches “{{query}}”', { query })}</p>{onManage ? <p>{tx(t, 'addStep.noResultsHint', 'Check the spelling, or find more steps in')} <button type="button" role="menuitem" className="am-linkbtn" onClick={() => { close(false); onManage() }}>{tx(t, 'addStep.pluginsShort', 'Plugins')}</button></p> : null}</div>
                ) : (
                  <Fragment>
                    <div role="presentation" className="am-menu-count" aria-live="polite">{results.length === 1 ? tx(t, 'addStep.results_one', '1 step') : tx(t, 'addStep.results_other', '{{count}} steps', { count: results.length })}</div>
                    {results.map(i => row(i, whereOf(i, model, headingTitle)))}
                  </Fragment>
                )
              ) : (
                <Fragment>
                  {model.main.map(s => section(s))}
                  {model.moreCount > 0 ? (
                    <div className="am-menu-more">
                      <button type="button" role="menuitem" aria-expanded={moreOpen} aria-controls="am-addmenu-more" onClick={() => { setMoreOpen(!moreOpen); write(MORE_KEY, moreOpen ? '0' : '1') }}>
                        <Icon name="dots" size={16} /><span className="am-mi-name">{tx(t, 'addStep.more', 'More')}</span><span className="am-mi-count">{model.moreCount}</span><Icon name={moreOpen ? 'chevronUp' : 'chevronDown'} size={16} />
                      </button>
                      {moreOpen ? <div id="am-addmenu-more">{model.more.map(s => section(s, true))}</div> : null}
                    </div>
                  ) : null}
                </Fragment>
              )}
            </div>
            {bottom}
      </div>
    </Fragment>
  ) : null

  return (
    <div className={block ? 'am-addmenu am-addmenu-block' : 'am-addmenu'} ref={root} onKeyDown={keys}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} {...(compact ? { 'aria-label': t('addStep.title'), title: t('addStep.title'), className: 'am-addbtn-compact' } : block ? { className: 'am-panelact' } : {})} onClick={() => (open ? close() : openMenu())}><Icon name="plus" size={16} />{compact ? null : t('addStep.title')}</button>
      <span className="am-sr" role="status" aria-live="polite">{said}</span>
      {host && panel ? createPortal(panel, host) : panel}
    </div>
  )
}

/** The text with the part that matched the search in bold. */
function highlight(text: string, query: string): ReactElement {
  const q = normalise(query)
  const flat = text.normalize('NFD')
  // find the match in the unaccented text, then map back by counting base characters
  const plain = normalise(text)
  const at = q ? plain.indexOf(q) : -1
  if (at < 0 || flat.length !== text.length + (flat.length - text.length)) return <>{text}</>
  const chars = [...text]
  if (chars.length !== plain.length) return <>{text}</>
  return <>{chars.slice(0, at).join('')}<strong>{chars.slice(at, at + q.length).join('')}</strong>{chars.slice(at + q.length).join('')}</>
}
