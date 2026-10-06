import { useEffect, useState } from 'react'
import type { HoustonClient } from '../../houston/client'
import type { RoleRoute } from '../../houston/generated/RoleRoute'
import { Button } from '../ui/Button'
import { TextInput } from '../ui/TextInput'
import { Select } from '../ui/Select'
import { Table } from '../ui/Table'

type RouteRow = RoleRoute & { rowId: string }

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

  const rows: RouteRow[] = routes.map((route, index) => ({ ...route, rowId: String(index) }))
  return <div className="grid gap-[var(--space-2)]" aria-label="Workspace routing">
    {routes.length > 0 && <Table<RouteRow>
      aria-label="Workspace routes"
      rows={rows}
      getRowId={(route) => route.rowId}
      columns={[
        { key: 'pattern', header: 'Role pattern', render: (_, route) => <TextInput variant="unstyled" aria-label={`Role pattern ${Number(route.rowId) + 1}`} className="min-w-0 w-full" value={route.pattern} onChange={(event) => setRoutes(routes.map((value, i) => i === Number(route.rowId) ? { ...value, pattern: event.target.value } : value))} /> },
        { key: 'model', header: 'Model', render: (_, route) => <TextInput variant="unstyled" aria-label={`Model ${Number(route.rowId) + 1}`} className="min-w-0 w-full" value={route.model} onChange={(event) => setRoutes(routes.map((value, i) => i === Number(route.rowId) ? { ...value, model: event.target.value } : value))} /> },
        { key: 'effort', header: 'Effort', render: (_, route) => <Select aria-label={`Effort ${Number(route.rowId) + 1}`} value={route.effort ?? ''} options={[{ value: '', label: 'Default effort' }, ...['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value, label: value }))]} onChange={(effort) => setRoutes(routes.map((value, i) => i === Number(route.rowId) ? { ...value, effort: effort === '' ? null : effort as RoleRoute['effort'] } : value))} /> },
        { key: 'rowId', header: '', render: (_, route) => <Button variant="legacy-ghost" aria-label={`Remove route ${Number(route.rowId) + 1}`} onClick={() => setRoutes(routes.filter((_, i) => i !== Number(route.rowId)))}>Remove</Button> }
      ]}
    />}
    {!routes.length && <p>No routes. Agents use their default model.</p>}
    <div className="flex gap-[var(--space-2)]"><Button variant="legacy-ghost" onClick={() => setRoutes([...routes, { pattern: '', model: '', effort: null }])}>Add route</Button><Button variant="legacy-ghost" onClick={() => {
      const invalid = routes.find((route) => !route.pattern.trim() || !route.model.trim())
      if (invalid) { setError(`Cannot save route ${JSON.stringify(invalid)}: expected a non-empty role pattern and model`); return }
      setError(null)
      client?.workspaceRoutingSet(workspace, routes)
    }}>Save routing</Button></div>{error && <p role="alert">{error}</p>}
  </div>
}
