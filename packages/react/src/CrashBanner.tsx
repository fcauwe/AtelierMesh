// The banner for a plugin that stopped working: it names the plugin, says what happened (the first line of the error) and offers
// "Switch on again" and "Manage plugins…". The engine has already switched the plugin off; this only tells the designer and lets them undo it.
import { useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import type { Registry } from '@ateliermesh/core'
import { tx } from './common'
import type { T } from './common'

/** The registry's change counter as React state: a component that calls this renders again when a plugin is added, removed, switched off or on. */
export function useRegistryVersion(registry: Registry): number {
  return useSyncExternalStore(cb => registry.subscribe(cb), () => registry.version, () => registry.version)
}

export function CrashBanner({ t, registry, onManage }: { t: T; registry: Registry; onManage?: () => void }): ReactElement | null {
  useRegistryVersion(registry)
  const crashed = Object.entries(registry.disabledPlugins()).filter(([, d]) => d.crashed)
  if (crashed.length === 0) return null
  return (
    <div className="am-crashes">
      {crashed.map(([id, d]) => {
        const name = registry.manifest(id)?.name ?? id
        return (
          <div key={id} className="am-problem am-error am-crash" role="alert">
            <p>{tx(t, 'mesh.plugin.crashed', 'The plugin “{{plugin}}” stopped working and was switched off. {{message}}', { plugin: name, message: d.reason })}</p>
            <div className="am-row">
              <button type="button" onClick={() => registry.setEnabled(id, true)}>{tx(t, 'fix.switchOnAgain', 'Switch on again')}</button>
              {onManage ? <button type="button" onClick={onManage}>{tx(t, 'fix.managePlugins', 'Manage plugins…')}</button> : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}
