// Recipes in the editor: a recipe is an export of the steps you have. "Save as a recipe" keeps all the current steps (a name, in this browser or as a
// file); "Apply a recipe" adds the steps of a saved recipe after the current ones, in their own order. The normal step list reorders and shows the order
// hints afterwards.
import { useState } from 'react'
import type { ReactElement } from 'react'
import { applyRecipe, makeRecipe, recipeProblems } from '@ateliermesh/core'
import type { Recipe, Registry, StepList, StructuredError } from '@ateliermesh/core'
import { Dialog, tx } from './common'
import type { T } from './common'
import { Icon } from './icons'

/** A recipe in the list of saved recipes. */
export interface RecipeEntry { id: string; name: string; steps: number; created?: string | number }

export interface RecipesHost {
  entries: RecipeEntry[]
  /** The whole recipe of an entry. */
  load: (id: string) => Promise<Recipe | null>
  /** Keep a recipe in the browser (the host's storage) or hand it to the user as a file. */
  save: (recipe: Recipe, where: 'browser' | 'file') => Promise<void> | void
  remove?: (id: string, name: string) => Promise<void> | void
  /** Let the user choose a `.amrecipe` file; the host reads and checks it (`parseRecipe`). `null`: cancelled. */
  openFile?: () => Promise<{ recipe: Recipe } | { errors: StructuredError[] } | null>
  /** The words for a recipe error (`recipe.*`), else a generic one. */
  describeError?: (e: StructuredError) => string
}

// ---------------------------------------------------------------------------------------------------- save
export interface SaveRecipeDialogProps {
  t: T; list: StepList; defaultName?: string
  host: Pick<RecipesHost, 'save'>
  onClose: () => void
}

export function SaveRecipeDialog({ t, list, defaultName = '', host, onClose }: SaveRecipeDialogProps): ReactElement {
  const [name, setName] = useState(defaultName)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const save = async (where: 'browser' | 'file'): Promise<void> => {
    setBusy(true); setNote(null)
    try { await host.save(makeRecipe({ name: name.trim() || tx(t, 'recipe.untitled', 'My recipe'), list }), where); onClose() }
    catch (e) { setNote(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  return (
    <Dialog title={tx(t, 'recipe.saveTitle', 'Save the steps as a recipe')} onClose={onClose} t={t}>
      <p className="am-help">{tx(t, 'recipe.saveLead', 'A recipe keeps the {{count}} steps you have now, in this order, without the model. Add it to another model later.', { count: list.steps.length })}</p>
      <div className="am-field"><label htmlFor="am-recipe-name">{tx(t, 'recipe.name', 'Name')}</label><input id="am-recipe-name" type="text" maxLength={120} value={name} placeholder={tx(t, 'recipe.untitled', 'My recipe')} onChange={e => setName(e.target.value)} /></div>
      {note ? <p className="am-error-text" role="alert">{note}</p> : null}
      <div className="am-actions">
        <button type="button" disabled={busy || list.steps.length === 0} onClick={() => void save('file')}><Icon name="download" size={16} /> {tx(t, 'recipe.download', 'Download file')}</button>
        <button type="button" className="am-primary" disabled={busy || list.steps.length === 0} onClick={() => void save('browser')}><Icon name="save" size={16} /> {tx(t, 'recipe.saveBrowser', 'Save in this browser')}</button>
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------------------------------- apply
export interface ApplyRecipeDialogProps {
  t: T; registry: Registry
  /** The steps the model has now. */
  target: StepList
  host: RecipesHost
  /** The new list and the ids of the steps that were added. */
  onApply: (list: StepList, added: string[]) => void
  onClose: () => void
}

export function ApplyRecipeDialog({ t, registry, target, host, onApply, onClose }: ApplyRecipeDialogProps): ReactElement {
  const [waiting, setWaiting] = useState<{ recipe: Recipe; missing: string[] } | null>(null)   // a recipe with a plugin that is not here: ask first
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const describe = (e: StructuredError): string => host.describeError?.(e) ?? tx(t, 'recipe.badFile', 'This file is not a usable recipe.')
  const use = (recipe: Recipe, force = false): void => {
    const p = recipeProblems(recipe, registry)
    const missing = [...new Set([...p.missingPlugins.map(x => x.id), ...p.unknownOps.map(x => x.plugin)])]
    if (missing.length > 0 && !force) { setWaiting({ recipe, missing }); return }
    const out = applyRecipe(target, recipe, { skipMissing: true, registry })
    if (out.added.length === 0) { setError(tx(t, 'recipe.nothing', 'None of the steps of this recipe can run here.')); setWaiting(null); return }
    onApply(out.list, out.added)
  }
  const choose = async (id: string): Promise<void> => {
    setLoading(true); setError(null)
    try { const r = await host.load(id); if (!r) setError(tx(t, 'recipe.gone', 'This recipe could not be found.')); else use(r) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setLoading(false) }
  }
  const openFile = async (): Promise<void> => {
    setError(null)
    const r = await host.openFile?.()
    if (!r) return
    if ('errors' in r) setError(describe(r.errors[0] as StructuredError)); else use(r.recipe)
  }
  if (waiting) {
    return (
      <Dialog title={waiting.recipe.name} onClose={onClose} t={t}>
        <p className="am-problem am-warning" role="note">{tx(t, 'recipe.missingPlugins', 'This recipe uses plugins that are not installed here: {{plugins}}. Those steps are left out.', { plugins: waiting.missing.join(', ') })}</p>
        <div className="am-actions">
          <button type="button" onClick={() => setWaiting(null)}>{tx(t, 'recipe.back', 'Back')}</button>
          <button type="button" className="am-primary" onClick={() => use(waiting.recipe, true)}>{tx(t, 'recipe.addTheRest', 'Add the other steps')}</button>
        </div>
      </Dialog>
    )
  }
  return (
    <Dialog title={tx(t, 'recipe.applyTitle', 'Apply a recipe')} onClose={onClose} t={t}>
      <p className="am-help">{tx(t, 'recipe.applyLead', 'The steps of a recipe are added after your steps, in their own order.')}</p>
      {error ? <p className="am-error-text" role="alert">{error}</p> : null}
      {host.entries.length === 0 ? <p className="am-help">{tx(t, 'recipe.noneSaved', 'Nothing saved yet. Use “Save as a recipe…” in the Add a step menu.')}</p> : (
        <ul className="am-list">
          {host.entries.map(e => (
            <li key={e.id}>
              <div className="am-grow"><strong>{e.name}</strong><span>{tx(t, 'recipe.stepCount', '{{count}} steps', { count: e.steps })}{e.created ? ` · ${new Date(e.created).toLocaleDateString()}` : ''}</span></div>
              <button type="button" className="am-primary" aria-label={`${tx(t, 'recipe.use', 'Use')} ${e.name}`} disabled={loading} onClick={() => void choose(e.id)}>{tx(t, 'recipe.use', 'Use')}</button>
              {host.remove ? <button type="button" className="am-danger" aria-label={`${t('editor.delete')} ${e.name}`} onClick={() => void host.remove?.(e.id, e.name)}>{t('editor.delete')}</button> : null}
            </li>
          ))}
        </ul>
      )}
      <div className="am-actions">
        {host.openFile ? <button type="button" onClick={() => void openFile()}><Icon name="folder" size={16} /> {tx(t, 'recipe.openFile', 'Open a recipe file…')}</button> : null}
        <button type="button" onClick={onClose}>{tx(t, 'recipe.cancel', 'Cancel')}</button>
      </div>
    </Dialog>
  )
}
