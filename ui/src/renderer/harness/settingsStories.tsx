import { ConnectPhoneHost } from '../src/components/ConnectPhoneDialog'
import { RAIL_DEFAULT } from '../src/railWidth'
import { agentAttentionFor } from '../src/useAgentAttention'
import React from 'react'
import { SettingsView, type OrchestrationStateView } from '../src/components/SettingsView'
import { Sidebar } from '../src/components/Sidebar'
import { baseSettingsViewProps, hostInfoFixture } from '../src/components/settingsViewTestFixtures'
import { setSettingsNavForTests, settingsSectionLabel } from '../src/settingsNav'
import { setMode } from '../src/backgroundMode'
import { SettingsBreadcrumb } from '../src/components/ui/SettingsBreadcrumb'
import { DaemonSection } from '../src/components/settings/DaemonSection'
import { DiagnosticsSection } from '../src/components/settings/DiagnosticsSection'
import { AUTO_TERMINAL_PALETTE } from '../src/theme'
import type { HoustonClient, SessionInfo, Workspace } from '../src/houston/client'
import type { RoleRoute } from '../src/houston/generated/RoleRoute'
import type { VoiceModelState } from '../src/houston/generated/VoiceModelState'
import type { VoiceSettings } from '../src/houston/generated/VoiceSettings'
import type { RemoteInfo } from '../src/houston/generated/RemoteInfo'
import type { ServerMsg } from '../src/houston/generated/ServerMsg'
import type { AgentHookState } from '../src/houston/generated/AgentHookState'
import type { UpdateState } from '../src/houston/generated/UpdateState'
import type { SessionPolicy } from '../src/houston/generated/SessionPolicy'
import type { SettingsSectionId } from '../src/settingsSections'
import { createSessionsStore, SessionsStoreContext } from '../src/sessionsStore'
import { SettingsDetail } from '../src/components/SettingsDetail'
import { AppearancePicker } from '../src/components/AppearancePicker'
import { setVoicePageError } from '../src/voice/store'
import { resetUpdateInstall, setUpdateInstallForTests, type UpdateInstallState } from '../src/updateInstall'

const noop = (): void => {}

export function SettingsScreen({
  section,
  props
}: {
  section: SettingsSectionId
  props?: Partial<React.ComponentProps<typeof SettingsView>>
}): React.JSX.Element {
  setSettingsNavForTests({ open: true, section })
  const ws = (path: string, name: string): Workspace => ({ path, name }) as Workspace
  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--content-bg)' }}>
      <div style={{ width: RAIL_DEFAULT, flex: `0 0 ${RAIL_DEFAULT}px`, minWidth: 0 }}>
        <Sidebar
          workspaces={[ws('/home/dev/code/houston', 'houston')]}
          sessions={[] as SessionInfo[]}
          selected="/home/dev/code/houston"
          customColors={{}}
          colorIndexByPath={{}}
          renaming={null}
          onSelect={noop}
          onAddWorkspace={noop}
          onRemoveWorkspace={noop}
          onRenameStart={noop}
          onRenameSubmit={noop}
          onRenameCancel={noop}
          onChangeColor={noop}
          onReorderWorkspace={noop}
          pinnedWorkspaces={new Set()}
          onTogglePinWorkspace={noop}
          onSshConnect={noop}
          chromeTheme="graphite"
          onToggleChromeTheme={noop}
          onOpenSettings={noop}
          agentAttention={props?.agentAttention}
        />
      </div>
      <div style={{ display: 'flex', flex: '1 1 0', minWidth: 0, flexDirection: 'column' }}>
        <header style={{ height: 'var(--h-top)', flex: '0 0 var(--h-top)', display: 'flex', alignItems: 'center', paddingInline: 'var(--space-3)', background: 'var(--rail-bg)', borderBottom: '1px solid var(--divider)' }}>
          <SettingsBreadcrumb open section={settingsSectionLabel()} />
        </header>
        <SettingsView
          {...baseSettingsViewProps()}
          historyWorkspace="/home/dev/code/houston"
          historyWorkspaceName="houston"
          {...props}
          chromeTheme={props?.chromeTheme ?? (document.documentElement.dataset.theme === 'paper' ? 'paper' : 'graphite')}
        />
      </div>
    </div>
  )
}

export function SettingsAppearance(): React.JSX.Element {
  return <SettingsScreen section="appearance" />
}

export function SettingsMascot(): React.JSX.Element {
  return <SettingsScreen section="appearance" />
}

export function SettingsAppearanceCustom(): React.JSX.Element {
  React.useEffect(() => setMode('custom'), [])
  return <SettingsScreen section="appearance" />
}

const detailGroups = [{
  heading: 'Workspace',
  rows: [{
    id: 'name',
    label: 'Workspace name',
    description: 'The label shown in the sidebar.',
    control: { kind: 'node' as const, node: <input value="Houston" readOnly className="w-36" /> }
  }, {
    id: 'remove',
    label: 'Remove workspace',
    description: 'This action needs a second confirmation.',
    control: { kind: 'destructive' as const, label: 'Remove', armedLabel: 'Confirm remove', onConfirm: noop },
    disable: { disabled: true as const, reason: 'A session is still running in this workspace.' }
  }]
}]

export function SettingsDetailStory({ state = 'ready' }: { state?: 'ready' | 'error' | 'loading' | 'empty' }): React.JSX.Element {
  return <div className="h-full bg-[var(--content-bg)] text-[var(--text-primary)]"><style>{'[data-testid="settings-detail"] [role="status"] { animation: none !important; }'}</style><SettingsDetail
    title="Workspace settings"
    description="Control how Houston uses this workspace."
    groups={state === 'empty' ? undefined : detailGroups}
    loading={state === 'loading'}
    error={state === 'error' ? { message: 'Settings could not be loaded.', onRetry: noop } : undefined}
    dirty
    onSave={noop}
  /></div>
}

export function AppearancePickerStory({ empty = false, highlighted = false }: { empty?: boolean; highlighted?: boolean }): React.JSX.Element {
  React.useEffect(() => {
    if (!empty && !highlighted) return
    const input = document.querySelector<HTMLInputElement>('[data-testid="appearance-picker-search"]')
    if (!input) return
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (highlighted) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      return
    }
    setter?.call(input, 'missing palette')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, [empty, highlighted])
  return <div className="max-w-[700px] p-6 bg-[var(--content-bg)] text-[var(--text-primary)]"><AppearancePicker currentTheme="black" onPreview={noop} onCommit={noop} /></div>
}

export function SettingsTerminal(): React.JSX.Element {
  return <SettingsScreen section="terminal" props={{ theme: AUTO_TERMINAL_PALETTE }} />
}

export function SettingsShortcuts(): React.JSX.Element {
  return <SettingsScreen section="shortcuts" />
}

export function SettingsShortcutsArmed(): React.JSX.Element {
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="settings-shortcut-row"] .key-chip--capture')?.click()
    }, 300)
    return () => window.clearTimeout(timer)
  }, [])
  return <SettingsScreen section="shortcuts" />
}

export function SettingsShortcutsConflict(): React.JSX.Element {
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      const row = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="settings-shortcut-row"]')).find((node) => node.textContent?.includes('zoom out (whole app)'))
      row?.querySelector<HTMLButtonElement>('.key-chip--capture')?.click()
      window.setTimeout(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '=', code: 'Equal', ctrlKey: true, bubbles: true })), 50)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [])
  return <SettingsScreen section="shortcuts" />
}

export function SettingsNotifications(): React.JSX.Element {
  return <SettingsScreen section="notifications" props={{
    desktopNotificationMode: 'notifications-sound',
    inAppNotifications: true,
    desktopNotificationDelivery: { allowed: true }
  }} />
}

// Stands in for the desktop app's answer before the section first renders.
export function SettingsNotificationsUnavailable(): React.JSX.Element {
  Object.assign(window, {
    __TAURI_INTERNALS__: {
      invoke: async (command: string) => command === 'native_notifications_supported'
        ? { supported: false, reason: "Windows reports notifications for 'dev.houston.desktop' as disabled for this user, expected enabled; allow Houston in Windows Settings ▸ System ▸ Notifications" }
        : null
    }
  })
  return <SettingsScreen section="notifications" props={{
    desktopNotificationMode: 'notifications-sound',
    inAppNotifications: true,
    desktopNotificationDelivery: null
  }} />
}

export function SettingsDiagnostics(): React.JSX.Element {
  const originalFetch = window.fetch
  Object.assign(window, {
    houston: {
      ...(window.houston ?? {}),
      getConfig: async () => ({ port: 43153, token: 'harness-token', pid: 4242, protocol: 70 })
    }
  })
  window.fetch = async (input, init) => {
    if (String(input).endsWith('/manage')) {
      return new Response(JSON.stringify({
        manage_version: 1,
        protocol_version: 70,
        build: 'abc1234',
        pid: 4242,
        started_at: new Date(Date.now() - 4 * 60 * 60_000).toISOString(),
        live_sessions: { count: 7, ids: [1, 2, 3, 4, 5, 6, 7] },
        routines_enabled: 0,
        clients_connected: 1,
        handoff: { supported: true, reason: '' },
        reap: { armed: false, deadline_ms: null }
      }), { headers: { 'Content-Type': 'application/json' } })
    }
    return originalFetch(input, init)
  }
  const sessions = [
    { id: 1, title: 'orchestrator', codename: 'heron', project_dir: '/home/dev/code/houston', agent: 'claude', status: 'needs-input', state: 'running' },
    { id: 2, title: 'inbox-api', codename: 'otter', project_dir: '/home/dev/code/houston', agent: 'codex', status: 'working', state: 'running' },
    { id: 3, title: 'pr-watch', codename: 'tern', project_dir: '/home/dev/code/houston', agent: 'claude', status: 'idle', state: 'running' },
    { id: 4, title: 'flow-ui', codename: 'eagle', project_dir: '/home/dev/code/dispatch', agent: 'opencode', status: 'working', state: 'running' }
  ] as unknown as SessionInfo[]
  const store = createSessionsStore(new Map(sessions.map((session) => [session.id, session])))
  return <SessionsStoreContext.Provider value={store}><SettingsScreen section="daemon" props={{ hostInfo: hostInfoFixture(), agentHooks: agentHookFixture }} /></SessionsStoreContext.Provider>
}

export function SettingsDiagnosticsOpenHooks(): React.JSX.Element {
  const session = {
    id: 1,
    title: 'orchestrator',
    codename: 'heron',
    project_dir: '/home/dev/code/houston',
    agent: 'claude',
    status: 'needs-input',
    state: 'running'
  } as unknown as SessionInfo
  return (
    <SessionsStoreContext.Provider value={createSessionsStore(new Map([[session.id, session]]))}>
      <div style={{ padding: 'var(--space-4)' }}>
        <DiagnosticsSection
          hostInfo={hostInfoFixture()}
          agentHooks={agentHookFixture}
          onOpenHooks={noop}
          onOpenLogsFolder={noop}
        />
      </div>
    </SessionsStoreContext.Provider>
  )
}

function storageClient(): HoustonClient {
  const handlers = new Set<(message: ServerMsg) => void>()
  return {
    subscribeAll(handler: (message: ServerMsg) => void) {
      handlers.add(handler)
      return () => { handlers.delete(handler) }
    },
    send(message: { type: string }) {
      const reply: ServerMsg | null =
        message.type === 'storage_reclaim'
          ? { type: 'storage_reclaimed', before_bytes: 214_958_080, after_bytes: 25_165_824, refusal: null }
          : message.type === 'diagnostics_collect'
            ? { type: 'diagnostics_collected', path: '/home/dev/.houston/diagnostics/houston-diagnostics-20261024T120000Z.txt', bytes: 187_392, error: null }
            : null
      if (!reply) return
      setTimeout(() => { for (const handler of handlers) handler(reply) }, 0)
    }
  } as unknown as HoustonClient
}

function StorageDiagnosticsStory({ reclaim, saveFile = false }: { reclaim: boolean; saveFile?: boolean }): React.JSX.Element {
  React.useEffect(() => {
    if (reclaim) document.querySelector<HTMLButtonElement>('[data-testid="settings-storage-reclaim"]')?.click()
    if (saveFile) document.querySelector<HTMLButtonElement>('[data-testid="settings-diagnostics-file"]')?.click()
  }, [reclaim, saveFile])
  return (
    <SessionsStoreContext.Provider value={createSessionsStore(new Map())}>
      <div style={{ padding: 'var(--space-4)' }}>
        <DiagnosticsSection
          hostInfo={hostInfoFixture({ live_sessions: 0, session_db_bytes: 201_326_592, session_db_wal_bytes: 13_631_488, session_db_free_bytes: 178_257_920 })}
          agentHooks={agentHookFixture}
          onOpenHooks={noop}
          onOpenLogsFolder={noop}
          client={storageClient()}
        />
      </div>
    </SessionsStoreContext.Provider>
  )
}

export function SettingsDiagnosticsStorage(): React.JSX.Element {
  return <StorageDiagnosticsStory reclaim={false} />
}

export function SettingsDiagnosticsStorageReclaimed(): React.JSX.Element {
  return <StorageDiagnosticsStory reclaim />
}

export function SettingsDiagnosticsFileSaved(): React.JSX.Element {
  return <StorageDiagnosticsStory reclaim={false} saveFile />
}

export function SettingsDaemon(): React.JSX.Element {
  const originalFetch = window.fetch
  Object.assign(window, {
    houston: {
      ...(window.houston ?? {}),
      getConfig: async () => ({ port: 43153, token: 'harness-token', pid: 4242, protocol: 70 })
    }
  })
  window.fetch = async () => new Response(JSON.stringify({
    manage_version: 1,
    protocol_version: 70,
    build: 'abc1234',
    pid: 4242,
    started_at: '2026-10-06T12:00:00.000Z',
    live_sessions: { count: 4, ids: [1, 2, 3, 4] },
    routines_enabled: 2,
    clients_connected: 1,
    handoff: { supported: true, reason: '' },
    reap: { armed: false, deadline_ms: null }
  }), { headers: { 'Content-Type': 'application/json' } })
  React.useEffect(() => () => { window.fetch = originalFetch }, [originalFetch])
  return <DaemonSection />
}

export function SettingsDaemonError(): React.JSX.Element {
  const originalFetch = window.fetch
  Object.assign(window, {
    houston: {
      ...(window.houston ?? {}),
      getConfig: async () => ({ port: 43153, token: 'harness-token', pid: 4242, protocol: 70 })
    }
  })
  window.fetch = async () => new Response(JSON.stringify({ error: 'Harness daemon unavailable' }), { status: 503 })
  React.useEffect(() => () => { window.fetch = originalFetch }, [originalFetch])
  return <DaemonSection />
}

const agentHookFixture: AgentHookState[] = [
  { provider: 'claude', path: '~/.claude/settings.json', scope: 'global', enabled: true, installed: true, error: null, present: true, version: '2.1.263', trust: null },
  { provider: 'codex', path: '~/.codex/config.toml', scope: 'global', enabled: false, installed: false, error: null, present: false, version: null, trust: 'not_confirmed' },
  { provider: 'opencode', path: '~/.config/opencode/plugins/houston.ts', scope: 'global', enabled: true, installed: false, error: 'Managed hook file is missing', present: true, version: '1.18.27', trust: null }
]

function routingClient(routes: RoleRoute[]): HoustonClient {
  let listener: ((message: { workspace: string; routes: RoleRoute[] }) => void) | null = null
  return new Proxy({
    subscribe(_type: string, handler: (message: { workspace: string; routes: RoleRoute[] }) => void) {
      listener = handler
      return () => { listener = null }
    },
    workspaceRoutingGet(workspace: string) {
      queueMicrotask(() => listener?.({ workspace, routes }))
    }
  }, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver)
      return () => undefined
    }
  }) as unknown as HoustonClient
}

export function remoteClient(initial: RemoteInfo, pairing = false): HoustonClient {
  const handlers = new Map<string, Set<(message: ServerMsg) => void>>()
  let remote = initial
  const emit = (message: ServerMsg): void => { for (const handler of handlers.get(message.type) ?? []) handler(message) }
  const showCode = (): void => emit({ type: 'remote_pairing', url: `${remote.url}/#pair=story`, qr_svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21"><rect width="21" height="21" fill="#fff"/><path d="M1 1h7v7H1zM13 1h7v7h-7zM1 13h7v7H1z" fill="#000"/></svg>', expires_at: Date.now() + 9 * 60_000 + 41_000 })
  return new Proxy({
    subscribe(type: string, handler: (message: ServerMsg) => void) {
      const set = handlers.get(type) ?? new Set()
      set.add(handler)
      handlers.set(type, set)
      return () => { set.delete(handler) }
    },
    remoteGet() {
      queueMicrotask(() => { emit({ type: 'remote_state', remote }); if (pairing) showCode() })
    },
    remoteConfigure(patch: Partial<RemoteInfo>) {
      remote = { ...remote, ...patch, url: patch.public_url ?? remote.url, listening: patch.enabled ?? remote.enabled }
      queueMicrotask(() => emit({ type: 'remote_state', remote }))
    },
    remotePairStart() { queueMicrotask(showCode) },
    remoteDeviceRevoke(id: number) {
      remote = { ...remote, devices: remote.devices.filter((device) => device.id !== id) }
      queueMicrotask(() => emit({ type: 'remote_state', remote }))
    }
  }, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver)
      return () => undefined
    }
  }) as unknown as HoustonClient
}

const remoteFixture: RemoteInfo = {
  enabled: true,
  bind: '127.0.0.1:47823',
  public_url: 'https://workstation.tail1234.ts.net',
  url: 'https://workstation.tail1234.ts.net',
  listening: true,
  error: null,
  ntfy_server: 'ntfy.sh',
  notify_delay_secs: 30,
  notify_detail: 'generic',
  notify_finished: false,
  dictation: true,
  tls: false,
  ca_fingerprint: null,
  devices: [
    { id: 1, name: 'Pixel 8 · Chrome', tier: 'drive', created_at: Date.now() - 4 * 86_400_000, last_seen_at: Date.now() - 2 * 60_000 },
    { id: 2, name: 'MacBook · Safari', tier: 'manage', created_at: Date.now() - 6 * 86_400_000, last_seen_at: Date.now() - 26 * 3_600_000 }
  ]
}

export function SettingsRemote({ pairing = false }: { pairing?: boolean } = {}): React.JSX.Element {
  const client = React.useMemo(() => remoteClient({ ...remoteFixture, devices: remoteFixture.devices.map((device, index) => ({ ...device, last_seen_at: Date.now() - (index === 0 ? 30_000 : 26 * 3_600_000) })) }, pairing), [pairing])
  return <><SettingsScreen section="remote" props={{ daemonClient: client, agentAttention: pairing ? settingsAgentAttentionFixture : undefined }} /><ConnectPhoneHost client={client} /></>
}

export function SettingsRemoteOff(): React.JSX.Element {
  const client = React.useMemo(() => remoteClient({ ...remoteFixture, enabled: false, listening: false, devices: [], ntfy_server: null }), [])
  return <><SettingsScreen section="remote" props={{ daemonClient: client }} /><ConnectPhoneHost client={client} /></>
}

export function SettingsRemoteUnconfigured(): React.JSX.Element {
  const client = React.useMemo(() => remoteClient({ ...remoteFixture, enabled: false, listening: false, devices: [], public_url: null, url: 'http://127.0.0.1:47823', ntfy_server: null }), [])
  return <><SettingsScreen section="remote" props={{ daemonClient: client }} /><ConnectPhoneHost client={client} /></>
}

export function SettingsAgentSetup({ detail = false, rename = false }: { detail?: boolean; rename?: boolean } = {}): React.JSX.Element {
  React.useEffect(() => {
    if (detail) document.querySelector<HTMLButtonElement>('[data-provider="claude"] button')?.click()
    if (rename) [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Rename')?.click()
  }, [detail, rename])
  return <SettingsScreen section="agents-clis" props={{
    agentHooks: agentHookFixture,
    agentProfiles: {
      profiles: [
        { id: 1, agent: 'claude', name: 'work', config_dir: '~/.claude-work' },
        { id: 2, agent: 'claude', name: 'personal', config_dir: '~/.claude-personal' }
      ],
      active: [{ agent: 'claude', id: 1 }]
    } as React.ComponentProps<typeof SettingsView>['agentProfiles']
  }} />
}

export function SettingsAgentStatusLoading(): React.JSX.Element {
  return <SettingsScreen section="agents-clis" props={{ agentHooks: null }} />
}

export function SettingsAgentStatusEmpty(): React.JSX.Element {
  return <SettingsScreen section="agents-clis" props={{ agentHooks: [] }} />
}

export function SettingsOrchestration(): React.JSX.Element {
  const orchestrationState: OrchestrationStateView = {
    enabled: true,
    caps: { max_live_children: 4, max_spawn_depth: 2 },
    acpAgents: [
      { slug: 'acp-gemini', display_name: 'Gemini CLI', command: 'gemini --experimental-acp', agent: 'custom' },
      { slug: 'acp-claude', display_name: 'Claude Code', command: 'claude-code-acp', agent: 'claude' }
    ]
  }
  return <SettingsScreen section="orchestration" props={{
    orchestrationState,
    orchestrationEnabled: true,
    hostInfo: hostInfoFixture(),
    historyWorkspace: '/home/dev/code/houston',
    historyWorkspaceName: 'houston',
    daemonClient: routingClient([{ pattern: '*', model: 'claude-sonnet-4-5', effort: 'high' }])
  }} />
}

export function SettingsOrchestrationLoading(): React.JSX.Element {
  return <SettingsScreen section="orchestration" props={{ orchestrationState: null, hostInfo: null, daemonClient: routingClient([]) }} />
}

export function SettingsOrchestrationEmptyRoster(): React.JSX.Element {
  return <SettingsScreen section="orchestration" props={{ orchestrationState: { enabled: true, caps: { max_live_children: 4, max_spawn_depth: 2 }, acpAgents: [] }, orchestrationEnabled: true, hostInfo: hostInfoFixture(), daemonClient: routingClient([]) }} />
}

export function SettingsOrchestrationNoWorkspace(): React.JSX.Element {
  return <SettingsScreen section="orchestration" props={{ orchestrationState: { enabled: true, caps: { max_live_children: 4, max_spawn_depth: 2 }, acpAgents: [] }, orchestrationEnabled: true, hostInfo: hostInfoFixture(), historyWorkspace: null, historyWorkspaceName: null, daemonClient: routingClient([]) }} />
}

export function SettingsDictation(): React.JSX.Element {
  const voiceSettings: VoiceSettings = {
    enabled: true,
    engine: { kind: 'local', model_id: 'ggml-small' },
    output_mode: 'original',
    input_language: null,
    capture_mode: 'hold',
    input_device: null,
    insert_mode: 'direct',
    vocabulary: 'Houston, pane, workspace, Claude, Codex, MCP, tsx, bun',
    agent_preamble: true,
    mic_policy: 'persistent',
    rms_floor: 0.01
  }
  const voiceModels: VoiceModelState[] = [{
    id: 'ggml-small',
    display_name: 'Small (multilingual)',
    size_bytes: 487_601_967,
    status: { kind: 'downloaded', size_bytes: 487_601_967 },
    linked: false, cooldown_remaining_ms: null
  }]
  return <SettingsScreen section="dictation" props={{ voiceSettings, voiceModels }} />
}

export function SettingsDictationModelStates(): React.JSX.Element {
  const voiceSettings: VoiceSettings = {
    enabled: true,
    engine: { kind: 'local', model_id: 'ggml-small' },
    output_mode: 'original',
    input_language: null,
    capture_mode: 'hold',
    input_device: null,
    insert_mode: 'direct',
    vocabulary: '',
    agent_preamble: true,
    mic_policy: 'persistent',
    rms_floor: 0.01
  }
  const voiceModels: VoiceModelState[] = [
    { id: 'ggml-tiny', display_name: 'Tiny (multilingual)', size_bytes: 77_691_713, status: { kind: 'downloaded', size_bytes: 77_691_713 }, linked: true, cooldown_remaining_ms: null },
    { id: 'ggml-base', display_name: 'Base (multilingual)', size_bytes: 147_951_465, status: { kind: 'failed', reason: 'Model download timed out; retry the download' }, linked: false, cooldown_remaining_ms: 15_000 },
    { id: 'ggml-small', display_name: 'Small (multilingual)', size_bytes: 487_601_967, status: { kind: 'downloaded', size_bytes: 487_601_967 }, linked: false, cooldown_remaining_ms: null },
    { id: 'ggml-medium-q5_0', display_name: 'Medium Q5_0 (multilingual)', size_bytes: 539_212_467, status: { kind: 'downloading', progress: 0.42 }, linked: false, cooldown_remaining_ms: null },
    { id: 'ggml-large-v3-turbo-q5_0', display_name: 'Large v3 Turbo Q5_0 (multilingual)', size_bytes: 574_041_195, status: { kind: 'not_downloaded' }, linked: false, cooldown_remaining_ms: null, guidance: '4 physical cores, 8 GiB RAM. This model may be slow on this machine. Guidance only.' }
  ]
  return <SettingsScreen section="dictation" props={{ voiceSettings, voiceModels }} />
}

export function SettingsDictationCloud(): React.JSX.Element {
  const voiceSettings: VoiceSettings = {
    enabled: true,
    engine: { kind: 'cloud', provider: 'groq' },
    output_mode: 'original',
    input_language: null,
    capture_mode: 'hold',
    input_device: null,
    insert_mode: 'direct',
    vocabulary: '',
    agent_preamble: true,
    mic_policy: 'persistent',
    rms_floor: 0.01
  }
  React.useEffect(() => {
    setVoicePageError('Could not refresh voice settings')
    return () => setVoicePageError(null)
  }, [])
  return <SettingsScreen section="dictation" props={{ voiceSettings, voiceCloudKeyPresent: true, voiceKeyringError: 'Secret Service is unavailable' }} />
}

export function SettingsWorkspaces({ mergeQueue = false }: { mergeQueue?: boolean } = {}): React.JSX.Element {
  React.useEffect(() => {
    if (!mergeQueue) return
    const timer = window.setInterval(() => {
      const policy = document.querySelector('[data-testid="merge-queue-policy-switch"]')
      if (policy) { policy.scrollIntoView({ block: 'start' }); window.clearInterval(timer) }
    }, 100)
    return () => window.clearInterval(timer)
  }, [mergeQueue])
  const client = React.useMemo(() => {
    let enabled = false
    const listeners = new Set<(message: ServerMsg) => void>()
    const typed = new Map<string, Set<(message: ServerMsg) => void>>()
    return new Proxy({
      subscribeAll(handler: (message: ServerMsg) => void) {
        listeners.add(handler)
        return () => { listeners.delete(handler) }
      },
      subscribe(kind: string, handler: (message: ServerMsg) => void) {
        const set = typed.get(kind) ?? new Set()
        typed.set(kind, set)
        set.add(handler)
        return () => { set.delete(handler) }
      },
      mergeQueueGet(dir: string) {
        queueMicrotask(() => {
          for (const listener of typed.get('merge_queue') ?? []) listener({ type: 'merge_queue', workspace: dir, dir, entries: [], log: [], settings: { merge_when_verified: false, verification_command: '', time_limit_minutes: 30, paused: false }, global_paused: false, away: { merged: 0, parked: 0, last_merge_at_ms: null }, message: null })
        })
      },
      send(message: { type: string; enabled?: boolean }) {
        if (message.type === 'generated_titles_set') enabled = message.enabled === true
        if (message.type === 'generated_titles_get' || message.type === 'generated_titles_set') {
          queueMicrotask(() => { for (const listener of listeners) listener({ type: 'generated_titles', enabled }) })
        }
      }
    }, { get: (target, key) => Reflect.get(target, key) ?? noop }) as unknown as HoustonClient
  }, [])
  const sessionPolicy: SessionPolicy = { idle_reap_enabled: false, idle_reap_minutes: 15, claude_fullscreen: true }
  return <SettingsScreen section="workspaces" props={{
    daemonClient: client,
    hostInfo: hostInfoFixture(),
    sessionPolicy,
    historyWorkspace: '/home/dev/code/houston',
    historyWorkspaceName: 'houston'
  }} />
}

export function SettingsPrivacy(): React.JSX.Element {
  return <SettingsScreen section="privacy" props={{
    hostInfo: hostInfoFixture(),
    historyCount: 4812,
    historyIgnoreGlobs: ['aws configure*', 'gh auth login*', 'gcloud auth*', 'az login*', 'docker login*', 'npm login*', 'pnpm login*', 'yarn login*', 'ssh-add*', 'pass*', 'op signin*', 'vault login*']
  }} />
}

export function SettingsPrivacyEditor(): React.JSX.Element {
  React.useEffect(() => {
    document.querySelector<HTMLButtonElement>('[data-testid="settings-history-ignore-edit"]')?.click()
    document.querySelector<HTMLButtonElement>('[data-testid="settings-clear-browsing-data"]')?.click()
  }, [])
  return <SettingsPrivacy />
}

export function SettingsDiagnosticsLoading(): React.JSX.Element {
  return <SettingsScreen section="daemon" props={{ hostInfo: null, agentHooks: null }} />
}

export function SettingsAbout(): React.JSX.Element {
  const state: UpdateState = { kind: 'up_to_date', checked_at_ms: Date.now() - 2 * 60 * 60 * 1000 }
  return <SettingsScreen section="about" props={{
    hostInfo: hostInfoFixture(),
    update: { policy: { check: true }, state }
  }} />
}

export function SettingsAboutAvailable(): React.JSX.Element {
  const state: UpdateState = {
    kind: 'available',
    checked_at_ms: Date.now() - 60 * 60 * 1000,
    release: {
      version: '1.2.3',
      notes: '## Changes\n\n- A concise release note\n- A second improvement\n\n## Fixes\n\n- A compatibility fix',
      notes_url: 'https://example.invalid/releases/1.2.3'
    }
  }
  return <SettingsScreen section="about" props={{ hostInfo: hostInfoFixture(), update: { policy: { check: true }, state }, liveSessionCount: 3 }} />
}

export function SettingsAboutInstallState({ state }: { state: UpdateInstallState }): React.JSX.Element {
  React.useEffect(() => {
    setUpdateInstallForTests(state)
    return () => resetUpdateInstall()
  }, [state])
  const update: UpdateState = {
    kind: 'available',
    checked_at_ms: Date.now(),
    release: { version: '1.2.3', notes: '## Changes\n\n- Update notes', notes_url: 'https://example.invalid/releases/1.2.3' }
  }
  return <SettingsScreen section="about" props={{ hostInfo: hostInfoFixture(), update: { policy: { check: true }, state: update } }} />
}

export function SettingsAboutNotices(): React.JSX.Element {
  React.useEffect(() => {
    [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Show notices'))
      ?.click()
  }, [])
  return <SettingsScreen section="about" props={{ hostInfo: hostInfoFixture() }} />
}

export function SettingsNoticesLoaded(): React.JSX.Element {
  React.useEffect(() => {
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: async () => JSON.stringify({
          texts: { mit: 'Permission is hereby granted, free of charge, to any person obtaining a copy of this software.' },
          packages: [
            { origin: 'npm', name: 'example-package', version: '1.2.3', license: 'MIT', repository: 'https://example.invalid/package', note: 'Bundled in the renderer.', textIds: ['mit'] },
            { origin: 'cargo', name: 'license-without-text', version: '2.0.0', license: 'Apache-2.0', repository: null, textIds: [] }
          ]
        })
      }
    })
    const interval = window.setInterval(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((candidate) => candidate.textContent?.includes('Show notices'))
      button?.click()
      window.clearInterval(interval)
      const expand = window.setInterval(() => {
        const license = [...document.querySelectorAll<HTMLButtonElement>('button')]
          .find((candidate) => candidate.textContent?.includes('Show licence'))
        if (!license) return
        license.click()
        window.clearInterval(expand)
      }, 20)
    }, 0)
    return () => window.clearInterval(interval)
  }, [])
  return <SettingsScreen section="about" props={{ hostInfo: hostInfoFixture() }} />
}

export function SettingsSearchStory(): React.JSX.Element {
  React.useEffect(() => {
    const input = document.querySelector<HTMLInputElement>('[aria-label="Search settings"]')
    if (!input) return
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setValue?.call(input, 'workspace')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, [])
  return <SettingsScreen section="workspaces" />
}

export const settingsAgentAttentionFixture = agentAttentionFor({ agentHooks: [{ provider: 'opencode', path: '/home/dev/.config/opencode/plugins/houston.ts', scope: 'global', present: true, enabled: true, installed: false, error: 'The managed hook block differs.', version: '1.18', trust: null }], skills: [], checks: [['github', { state: 'failed', message: 'npx is not on PATH' }]], reviews: [{ workspace: '/home/dev/code/houston', attention: 1, open: 1, fixing: 0, awaiting_verification: 0, not_seen: 0, resolved: 0, dismissed: 0, seen_review_id: 0 }] })

export function SettingsAgentsOverview({ healthy = false }: { healthy?: boolean } = {}): React.JSX.Element {
  const attention = healthy ? agentAttentionFor({ agentHooks: [], skills: [], checks: [], reviews: [] }) : settingsAgentAttentionFixture
  const review: import('../src/houston/useHarness').HarnessState = { workspace: '/home/dev/code/houston', routine: { id: 1, kind: 'harness_review', name: 'Weekly review', prompt: 'Review', cadence: { type: 'clock', hour: 9, minute: 0, weekdays: [2] }, enabled: true, workspace_id: '/home/dev/code/houston', engine: 'claude', model: null, next_run_at_ms: 1791802800000, permission_mode: 'accept_edits', isolate: false, revision: '1' }, reviews: [{ id: 1, workspace: '/home/dev/code/houston', routine_id: 1, run_id: 1, status: 'published', started_at_ms: 1, run_dir: '/home/dev/code/houston/.houston/harness/r1', sessions: 38, finding_count: 1 }], findings: [{ review_id: 1, key: 'style', title: 'Agents re-read the styleguide on every UI change', category: 'workflow', confidence: 'high', sessions: ['a'], count: 9, quotes: [], recommendation_kind: 'workflow', target: 'AGENTS.md', recommendation: 'Read once', apply_prompt: 'Read once', state: 'open', recurred: false, phase: 'open', last_seen_review_id: 1 }], models: [], providerCoverage: [], engineRefusals: [] }
  return <SettingsScreen section="agents-overview" props={{ agentAttention: attention, agentReviewStates: healthy ? [] : [review] }} />
}
