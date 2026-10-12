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
  { provider: 'opencode', path: '~/.config/opencode/plugins/houston.ts', scope: 'global', enabled: true, installed: false, error: 'Managed hook file is missing', present: true, version: '1.18.27', trust: null },
  { provider: 'grok', path: '~/.config/grok/settings.json', scope: 'global', enabled: true, installed: true, error: null, present: true, version: '0.9.2', trust: null },
  { provider: 'cursor', path: '~/.cursor/hooks.json', scope: 'global', enabled: false, installed: false, error: null, present: false, version: null, trust: null }
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

function remoteClient(remote: RemoteInfo): HoustonClient {
  let listener: ((message: ServerMsg) => void) | null = null
  return new Proxy({
    subscribe(type: string, handler: (message: ServerMsg) => void) {
      if (type === 'remote_state') listener = handler
      return () => { listener = null }
    },
    remoteGet() {
      queueMicrotask(() => listener?.({ type: 'remote_state', remote }))
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
    { id: 1, name: 'Pixel 8 · Chrome', created_at: Date.now() - 4 * 86_400_000, last_seen_at: Date.now() - 2 * 60_000 },
    { id: 2, name: 'MacBook · Safari', created_at: Date.now() - 6 * 86_400_000, last_seen_at: Date.now() - 26 * 3_600_000 }
  ]
}

export function SettingsRemote(): React.JSX.Element {
  return <SettingsScreen section="remote" props={{ daemonClient: remoteClient(remoteFixture) }} />
}

export function SettingsRemoteOff(): React.JSX.Element {
  return <SettingsScreen section="remote" props={{ daemonClient: remoteClient({ ...remoteFixture, enabled: false, listening: false, public_url: null, url: 'http://127.0.0.1:47823', ntfy_server: null }) }} />
}

export function SettingsAgentSetup(): React.JSX.Element {
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
    size_bytes: 465_000_000,
    status: { kind: 'downloaded', size_bytes: 465_000_000 },
    cooldown_remaining_ms: null
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
    { id: 'ggml-small', display_name: 'Small (multilingual)', size_bytes: 465_000_000, status: { kind: 'downloaded', size_bytes: 465_000_000 }, cooldown_remaining_ms: null },
    { id: 'ggml-medium', display_name: 'Medium (multilingual)', size_bytes: 1_500_000_000, status: { kind: 'downloading', progress: 0.42 }, cooldown_remaining_ms: null },
    { id: 'ggml-large', display_name: 'Large (multilingual)', size_bytes: 2_900_000_000, status: { kind: 'not_downloaded' }, cooldown_remaining_ms: null },
    { id: 'ggml-failed', display_name: 'Failed download', size_bytes: 900_000_000, status: { kind: 'failed', reason: 'Checksum verification failed' }, cooldown_remaining_ms: 15_000 }
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

export function SettingsWorkspaces(): React.JSX.Element {
  const sessionPolicy: SessionPolicy = { idle_reap_enabled: false, idle_reap_minutes: 15, claude_fullscreen: true }
  return <SettingsScreen section="workspaces" props={{
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

export function SettingsAgentsOverview({ healthy = false }: { healthy?: boolean } = {}): React.JSX.Element {
  const attention = agentAttentionFor({ agentHooks: healthy ? [] : [{ provider: 'opencode', path: '/home/dev/.config/opencode/plugins/houston.ts', scope: 'global', present: true, enabled: true, installed: false, error: 'The managed hook block differs.', version: '1.18', trust: null }], skills: [], checks: healthy ? [] : [['github', { state: 'failed', message: 'npx is not on PATH' }]], reviews: healthy ? [] : [{ workspace: '/home/dev/code/houston', attention: 1, open: 1, fixing: 0, awaiting_verification: 0, not_seen: 0, resolved: 0, dismissed: 0, seen_review_id: 0 }] })
  const review: import('../src/houston/useHarness').HarnessState = { workspace: '/home/dev/code/houston', routine: null, reviews: [{ id: 1, workspace: '/home/dev/code/houston', routine_id: 1, run_id: 1, status: 'published', started_at_ms: 1, run_dir: '/home/dev/code/houston/.houston/harness/r1', sessions: 38, finding_count: 1 }], findings: [{ review_id: 1, key: 'style', title: 'Agents re-read the styleguide on every UI change', category: 'workflow', confidence: 'high', sessions: ['a'], count: 9, quotes: [], recommendation_kind: 'workflow', target: 'AGENTS.md', recommendation: 'Read once', apply_prompt: 'Read once', state: 'open', recurred: false, phase: 'open', last_seen_review_id: 1 }], models: [], providerCoverage: [], engineRefusals: [] }
  return <SettingsScreen section="agents-overview" props={{ agentAttention: attention, agentReviewStates: healthy ? [] : [review] }} />
}
