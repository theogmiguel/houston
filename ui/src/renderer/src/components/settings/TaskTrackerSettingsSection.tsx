import { useEffect, useMemo, useRef, useState } from 'react'
import type { HoustonClient } from '../../houston/client'
import type { TaskTrackerProvider, TaskTrackerWorkspaceSettings } from '../../houston/taskDomain'
import { sendTaskWire } from '../../houston/taskDomain'
import { Button, Notice, Select, Text, TextInput, Toggle } from '../ui'
import { SettingsList } from '../ui/settingsPrimitives'
import { SettingsScope } from '../ui/SettingsScope'
import { Row, SubHead } from './shared'

const PROVIDERS: { value: TaskTrackerProvider; label: string }[] = [
  { value: 'github_issues', label: 'GitHub Issues' },
  { value: 'notion', label: 'Notion' }
]

export function mergeTrackerSettings(current: TaskTrackerWorkspaceSettings[], incoming: TaskTrackerWorkspaceSettings[]): TaskTrackerWorkspaceSettings[] {
  const merged = new Map(current.map((setting) => [setting.provider, setting]))
  for (const setting of incoming) merged.set(setting.provider, setting)
  return [...merged.values()]
}

export function TaskTrackerSettingsSection({ client, workspace, workspaceName }: {
  client: HoustonClient | null
  workspace: string | null
  workspaceName: string | null
}): React.JSX.Element {
  const [settings, setSettings] = useState<TaskTrackerWorkspaceSettings[]>([])
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [provider, setProvider] = useState<TaskTrackerProvider>('github_issues')
  const [draft, setDraft] = useState<TaskTrackerWorkspaceSettings | null>(null)
  const [token, setToken] = useState('')
  const [syncState, setSyncState] = useState<{ at: number | null; error: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const receivedSettings = useRef(false)
  const setting = useMemo(() => settings.find((item) => item.provider === provider) ?? (workspace && settingsLoaded ? emptySettings(workspace, provider) : null), [provider, settings, settingsLoaded, workspace])

  useEffect(() => {
    setSettings([])
    setSettingsLoaded(false)
    setSyncState(null)
    setError(null)
    setDraft(null)
    receivedSettings.current = false
    if (!client || !workspace) return
    const off = client.subscribeAll((message) => {
      if (message.type === 'task_tracker_settings') {
        const incoming = message.settings.filter((item) => item.workspace === workspace)
        setSettings((current) => mergeTrackerSettings(current, incoming))
        setSettingsLoaded(true)
        if (!receivedSettings.current && incoming.length > 0) setProvider(incoming[0].provider)
        receivedSettings.current = true
        if (message.refusal) setError(message.refusal)
      }
      if (message.type === 'task_tracker_sync_state' && message.workspace === workspace) setSyncState({ at: message.last_sync_at_ms, error: message.error })
      if (message.type === 'error') setError(message.message)
    })
    sendTaskWire(client, { type: 'task_tracker_settings_get', workspace })
    return off
  }, [client, workspace])

  useEffect(() => setDraft(setting), [setting])
  useEffect(() => setToken(''), [provider])

  if (!workspace) return <>
    <SubHead>Tracker sync</SubHead>
    <SettingsList><Row title="Workspace tracker settings" desc="Select one workspace to view and edit its GitHub or Notion configuration."><SettingsScope workspace={workspaceName} row /></Row></SettingsList>
  </>
  if (!client) return <>
    <SubHead>Tracker sync</SubHead>
    <SettingsList><Row title="Workspace tracker settings" desc="Connect to the Houston daemon to load this workspace’s settings."><SettingsScope workspace={workspaceName} row /></Row></SettingsList>
  </>

  const value = draft ?? setting
  const update = (patch: Partial<TaskTrackerWorkspaceSettings>): void => setDraft((current) => ({ ...(current ?? setting!), ...patch, workspace }))
  const set = (): void => { if (value) sendTaskWire(client, { type: 'task_tracker_settings_set', settings: value }) }
  const setCredential = (): void => {
    if (!token.trim()) return
    sendTaskWire(client, { type: 'task_tracker_credential_set', workspace, provider, token })
    setToken('')
  }
  const clearCredential = (): void => sendTaskWire(client, { type: 'task_tracker_credential_clear', workspace, provider })
  const sync = (): void => sendTaskWire(client, { type: 'task_tracker_sync_now', workspace })
  const lastSync = syncState?.at ?? value?.last_sync_at_ms ?? null
  const syncError = syncState?.error ?? value?.last_error ?? null

  return <>
    <SubHead>Tracker sync · {workspaceName ?? workspace}</SubHead>
    <SettingsScope workspace={workspaceName} />
    {error && <Notice tone="danger">{error}</Notice>}
    {!settingsLoaded ? <p role="status" aria-busy="true">Loading workspace tracker settings…</p> : <SettingsList>
      <Row title="Tracker provider" desc="Choose which workspace tracker configuration to edit.">
        <Select aria-label="Tracker provider" value={provider} options={PROVIDERS} onChange={(next) => setProvider(next as TaskTrackerProvider)} />
      </Row>
      {value && <>
        <Row title="Enable sync" desc="Allow this provider to import and synchronize tasks for this workspace.">
          <Toggle aria-label="Enable tracker sync" data-testid="tracker-sync-enabled" on={value.enabled} onChange={(enabled) => update({ enabled })} />
        </Row>
        {provider === 'github_issues' ? <>
          <SettingRow title="Repository (owner/name)" value={value.github_repository ?? ''} onChange={(text) => update({ github_repository: text || null })} />
          <SettingRow title="Issue label" value={value.github_label ?? ''} onChange={(text) => update({ github_label: text || null })} />
          <SettingRow title="Assigned GitHub user" value={value.github_assigned_user ?? ''} onChange={(text) => update({ github_assigned_user: text || null })} />
          <Row title="Authentication" desc="GitHub CLI authentication is used for GitHub Issues. No GitHub token is stored here." />
        </> : <>
          <SettingRow title="Notion data source ID" value={value.notion_data_source_id ?? ''} onChange={(text) => update({ notion_data_source_id: text || null })} />
          <SettingRow title="Title property ID" value={value.notion_title_property_id ?? ''} onChange={(text) => update({ notion_title_property_id: text || null })} />
          <SettingRow title="Description property ID" value={value.notion_description_property_id ?? ''} onChange={(text) => update({ notion_description_property_id: text || null })} />
          <SettingRow title="Status property ID" value={value.notion_status_property_id ?? ''} onChange={(text) => update({ notion_status_property_id: text || null })} />
          <SettingRow title="Assignee property ID" value={value.notion_assignee_property_id ?? ''} onChange={(text) => update({ notion_assignee_property_id: text || null })} />
          <SettingRow title="Project relation property ID" value={value.notion_project_relation_property_id ?? ''} onChange={(text) => update({ notion_project_relation_property_id: text || null })} />
          <SettingRow title="Notion assignee user ID" value={value.notion_assignee_user_id ?? ''} onChange={(text) => update({ notion_assignee_user_id: text || null })} />
          <SettingRow title="Active status values (comma separated)" value={value.notion_active_status_values.join(', ')} onChange={(text) => update({ notion_active_status_values: text.split(',').map((item) => item.trim()).filter(Boolean) })} />
          <SettingRow title="Projects data source ID" value={value.notion_projects_data_source_id ?? ''} onChange={(text) => update({ notion_projects_data_source_id: text || null })} />
          <SettingRow title="Project title property ID" value={value.notion_project_title_property_id ?? ''} onChange={(text) => update({ notion_project_title_property_id: text || null })} />
          <SettingRow title="Project description property ID" value={value.notion_project_description_property_id ?? ''} onChange={(text) => update({ notion_project_description_property_id: text || null })} />
          <SettingRow title="Pull request URL property ID" value={value.notion_pr_url_property_id ?? ''} onChange={(text) => update({ notion_pr_url_property_id: text || null })} />
          {(['todo', 'in_progress', 'in_review', 'done', 'canceled'] as const).map((status) => <SettingRow key={status} title={`Status option: ${status.replace('_', ' ')}`} value={value.notion_status_mapping[status] ?? ''} onChange={(text) => update({ notion_status_mapping: { ...value.notion_status_mapping, [status]: text || null } })} />)}
          <Row title="Notion integration token" desc={value.has_credential ? 'A token is stored in the OS keychain. Enter a replacement only when rotating it.' : 'The token is sent directly to the daemon credential endpoint and stored in the OS keychain.'}>
            <div className="grid gap-[var(--space-2)]">
              <TextInput aria-label="Notion integration token" type="password" autoComplete="new-password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={value.has_credential ? 'Replace keychain token' : 'Enter token'} />
              <div className="flex gap-[var(--space-2)]">
                <Button variant="secondary" disabled={!token.trim()} onClick={setCredential}>Save token</Button>
                {value.has_credential && <Button variant="ghost" onClick={clearCredential}>Remove token</Button>}
              </div>
            </div>
          </Row>
        </>}
        <Row title="Current sync status" desc={syncError ? <Notice tone="danger">{syncError}</Notice> : 'No current tracker sync error.'}>
          <Text size="small">{lastSync == null ? 'Never synced' : `Last sync ${new Date(lastSync).toLocaleString()}`}</Text>
        </Row>
        <Row title="Actions" desc="Save public configuration or request a sync for this workspace.">
          <div className="flex gap-[var(--space-2)]">
            <Button variant="secondary" disabled={JSON.stringify(value) === JSON.stringify(setting)} onClick={set}>Save settings</Button>
            <Button variant="secondary" disabled={!value.enabled} onClick={sync}>Sync now</Button>
          </div>
        </Row>
      </>}
    </SettingsList>}
  </>
}

function SettingRow({ title, value, onChange }: { title: string; value: string; onChange: (value: string) => void }): React.JSX.Element {
  return <Row title={title}><TextInput aria-label={title} value={value} onChange={(event) => onChange(event.target.value)} /></Row>
}

function emptySettings(workspace: string, provider: TaskTrackerProvider): TaskTrackerWorkspaceSettings {
  return {
    workspace, provider, enabled: false, github_repository: null, github_label: null, github_assigned_user: null,
    notion_data_source_id: null, notion_title_property_id: null, notion_description_property_id: null,
    notion_status_property_id: null, notion_assignee_property_id: null, notion_project_relation_property_id: null,
    notion_assignee_user_id: null, notion_active_status_values: [], notion_projects_data_source_id: null,
    notion_project_title_property_id: null, notion_project_description_property_id: null, notion_pr_url_property_id: null,
    notion_status_mapping: { todo: null, in_progress: null, in_review: null, done: null, canceled: null },
    has_credential: false, last_sync_at_ms: null, last_error: null
  }
}
