// The settings as one dialog with tabs: General, Plugins (the plugin manager) and Catalogues. The tab bar is the same in each; switching swaps what is shown, so the plugin manager keeps its own screens.
import { useState } from 'react'
import type { ReactElement } from 'react'
import { PluginManager, SettingsDialog } from './Dialogs'
import type { CatalogueCard, CatalogueCheck, PluginManagerProps, SettingsDialogProps, SettingsTab } from './Dialogs'
import type { T } from './common'

export interface SettingsShellProps {
  t: T
  /** The tab to show first. */
  initial: SettingsTab
  settings: Omit<SettingsDialogProps, 't' | 'tabs' | 'onClose' | 'onPlugins' | 'catalogues'>
  plugins: Omit<PluginManagerProps, 't' | 'onClose' | 'tabs'>
  catalogues: CatalogueCard[]
  /** Adding and removing catalogues (see `SettingsDialogProps`). */
  catalogueActions?: { onCheck: (name: string, address: string) => Promise<CatalogueCheck>; onAdd: NonNullable<SettingsDialogProps['onAddCatalogue']>; onRemove: (id: string) => void }
  onClose: () => void
}

export function SettingsShell({ t, initial, settings, plugins, catalogues, catalogueActions, onClose }: SettingsShellProps): ReactElement {
  const [tab, setTab] = useState<SettingsTab>(initial)
  if (tab === 'plugins') return <PluginManager t={t} {...plugins} tabs={{ onSelect: setTab }} onClose={onClose} />
  return <SettingsDialog t={t} {...settings} catalogues={catalogues} {...(catalogueActions ? { onCheckCatalogue: catalogueActions.onCheck, onAddCatalogue: catalogueActions.onAdd, onRemoveCatalogue: catalogueActions.onRemove } : {})} tabs={{ current: tab, onSelect: setTab }} onClose={onClose} />
}
