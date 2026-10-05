import React from 'react'
import { SettingsView, type OrchestrationStateView } from '../src/components/SettingsView'
import { Sidebar } from '../src/components/Sidebar'
import { baseSettingsViewProps, hostInfoFixture } from '../src/components/settingsViewTestFixtures'
import { setSettingsNavForTests, settingsSectionLabel } from '../src/settingsNav'
import { setMode } from '../src/backgroundMode'
import { SettingsBreadcrumb } from '../src/components/ui/SettingsBreadcrumb'
import { AUTO_TERMINAL_PALETTE } from '../src/theme'
import type { HoustonClient, SessionInfo, Workspace } from '../src/houston/client'
import type { RoleRoute } from '../src/houston/generated/RoleRoute'
import type { VoiceModelState } from '../src/houston/generated/VoiceModelState'
import type { VoiceSettings } from '../src/houston/generated/VoiceSettings'
import type { AgentHookState } from '../src/houston/generated/AgentHookState'
import type { UpdateState } from '../src/houston/generated/UpdateState'
import type { SessionPolicy } from '../src/houston/generated/SessionPolicy'
import type { SettingsSectionId } from '../src/settingsSections'
import { createSessionsStore, SessionsStoreContext } from '../src/sessionsStore'

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
      <div style={{ width: 240, flex: '0 0 240px', minWidth: 0 }}>
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

export function SettingsAppearanceCustom(): React.JSX.Element {
  React.useEffect(() => setMode('custom'), [])
  return <SettingsScreen section="appearance" />
}

export function SettingsTerminal(): React.JSX.Element {
  return <SettingsScreen section="terminal" props={{ theme: AUTO_TERMINAL_PALETTE }} />
}

export function SettingsShortcuts(): React.JSX.Element {
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

export function SettingsAgentSetup(): React.JSX.Element {
  return <SettingsScreen section="agents" props={{
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

export function SettingsWorkspaces(): React.JSX.Element {
  const sessionPolicy: SessionPolicy = { idle_reap_enabled: false, idle_reap_minutes: 15 }
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

export function SettingsAbout(): React.JSX.Element {
  const state: UpdateState = { kind: 'up_to_date', checked_at_ms: Date.now() - 2 * 60 * 60 * 1000 }
  return <SettingsScreen section="about" props={{
    hostInfo: hostInfoFixture(),
    update: { policy: { check: true }, state }
  }} />
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
