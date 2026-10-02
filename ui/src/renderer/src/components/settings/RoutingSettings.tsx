import { useEffect, useState } from 'react'
import type { HoustonClient } from '../../houston/client'
import type { RoleRoute } from '../../houston/generated/RoleRoute'
import { BTN_GHOST } from '../buttonChrome'
import { Select } from '../Select'

export function RoutingSettings({ client, workspace }: { client: HoustonClient | null; workspace: string | null }): React.JSX.Element {
  const [routes, setRoutes] = useState<RoleRoute[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setLoaded(false)
    setRoutes([])
    if (!client || !workspace) return
    const off = client.subscribe('workspace_routing', (message) => {
      if (message.workspace !== workspace) return
      setRoutes(message.routes)
      setLoaded(true)
    })
    client.workspaceRoutingGet(workspace)
    return off
  }, [client, workspace])
  if (!workspace) return <p>Select a workspace to edit its routing table.</p>
  if (!loaded) return <p>Asking the daemon…</p>
  return <div className="flex flex-col gap-2" aria-label="Workspace routing">
    {routes.map((route, index) => <div key={index} className="flex flex-wrap gap-2"><input aria-label={`Role pattern ${index + 1}`} className="min-w-0 flex-1 bg-[var(--content-bg)]" value={route.pattern} onChange={(event) => setRoutes(routes.map((value, i) => i === index ? { ...value, pattern: event.target.value } : value))} /><input aria-label={`Model ${index + 1}`} className="min-w-0 flex-1 bg-[var(--content-bg)]" value={route.model} onChange={(event) => setRoutes(routes.map((value, i) => i === index ? { ...value, model: event.target.value } : value))} /><Select value={route.effort ?? ''} options={[{ value: '', label: 'Default effort' }, ...['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value, label: value }))]} onChange={(effort) => setRoutes(routes.map((value, i) => i === index ? { ...value, effort: effort === '' ? null : effort as RoleRoute['effort'] } : value))} /><button className={`btn ${BTN_GHOST}`} aria-label={`Remove route ${index + 1}`} onClick={() => setRoutes(routes.filter((_, i) => i !== index))}>Remove</button></div>)}
    {!routes.length && <p>No routes. Agents use their default model.</p>}
    <div className="flex gap-2"><button className={`btn ${BTN_GHOST}`} onClick={() => setRoutes([...routes, { pattern: '', model: '', effort: null }])}>Add route</button><button className={`btn ${BTN_GHOST}`} onClick={() => {
      const invalid = routes.find((route) => !route.pattern.trim() || !route.model.trim())
      if (invalid) { setError(`Cannot save route ${JSON.stringify(invalid)}: expected a non-empty role pattern and model`); return }
      setError(null)
      client?.workspaceRoutingSet(workspace, routes)
    }}>Save routing</button></div>{error && <p role="alert">{error}</p>}
  </div>
}
