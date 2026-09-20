import React from 'react'
import { HooksSurface } from '../src/components/nav/HooksSurface'
import { McpSurface } from '../src/components/nav/McpSurface'
import { RoutinesSurface } from '../src/components/nav/RoutinesSurface'
import { RoutineEditor } from '../src/components/nav/RoutineEditor'
import { SkillsSurface } from '../src/components/nav/SkillsSurface'
import type { AgentHookState } from '../src/houston/generated/AgentHookState'
import type { McpServer } from '../src/houston/generated/McpServer'
import type { McpToolState } from '../src/houston/generated/McpToolState'
import type { Routine } from '../src/houston/routineTypes'
import type { SkillToolState } from '../src/houston/generated/SkillToolState'
import type { Skill } from '../src/env'

const noop = (): void => {}

const NOW = 1_700_000_000_000

function Frame({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div style={{ display: 'flex', flex: 1, minWidth: 0, height: '100%' }}>{children}</div>
}

function routine(o: Partial<Routine> = {}): Routine {
  return {
    id: 1,
    engine: 'claude',
    name: 'Leak watch',
    prompt: 'Check for leaked file descriptors and report.',
    cadence: { type: 'interval', seconds: 900 },
    enabled: true,
    workspace_id: '/home/dev/code/houston',
    permission_mode: 'accept_edits',
    isolate: false,
    next_run_at_ms: NOW + 13 * 3600_000,
    last_run_at_ms: null,
    last_run_session_id: null,
    last_error: null,
    revision: 'rev-1',
    ...o
  }
}

export function NavRoutines(): React.JSX.Element {
  return (
    <Frame>
      <RoutinesSurface
        routines={[
          routine({ id: 1, next_run_at_ms: NOW + 900_000, last_run_at_ms: NOW - 3600_000 }),
          routine({
            id: 2,
            name: 'Morning review',
            cadence: { type: 'clock', hour: 9, minute: 0, weekdays: null },
            permission_mode: 'accept_edits',
            isolate: false,
            next_run_at_ms: NOW + 9 * 3600_000
          }),
          routine({
            id: 3,
            name: 'Cert sweep',
            cadence: { type: 'clock', hour: 9, minute: 0, weekdays: [2, 3, 4, 5, 6] },
            last_error: 'cwd no longer exists',
            permission_mode: 'accept_edits',
            isolate: false,
            next_run_at_ms: NOW + 20 * 3600_000
          }),
          routine({ id: 4, name: 'Docs drift', enabled: false, next_run_at_ms: NOW + 3600_000 })
        ]}
        running={[]}
        runs={{}}
        runsLoading={null}
        workspaces={[{ id: '/home/dev/code/houston', name: 'houston' }]}
        error={null}
        onDismissError={noop}
        onCreate={noop}
        onUpdate={noop}
        onDelete={noop}
        onRunNow={noop}
        onLoadRuns={noop}
        onOpenSession={noop}
        onRequest={noop}
        now={NOW}
      />
    </Frame>
  )
}

export function NavRoutineEditor(): React.JSX.Element {
  return (
    <Frame>
      <RoutineEditor
        mode="create"
        workspaces={[{ id: '/home/dev/code/houston', name: 'houston' }]}
        initial={{
          engine: 'claude',
          model: null,
          effort: null,
          name: '',
          prompt: '',
          cadence: { type: 'interval', seconds: 900 },
          workspaceId: null,
          permissionMode: 'accept_edits',
          isolate: false
        }}
        onSubmit={noop}
        onCancel={noop}
      />
    </Frame>
  )
}

export function NavRoutinesEmpty(): React.JSX.Element {
  return (
    <Frame>
      <RoutinesSurface
        routines={[]}
        running={[]}
        runs={{}}
        runsLoading={null}
        workspaces={[]}
        error={null}
        onDismissError={noop}
        onCreate={noop}
        onUpdate={noop}
        onDelete={noop}
        onRunNow={noop}
        onLoadRuns={noop}
        onOpenSession={noop}
        onRequest={noop}
        now={NOW}
      />
    </Frame>
  )
}

function installSkillFixture(): void {
  const skills: Skill[] = [
    {
      agent: 'claude',
      source: 'user',
      name: 'tdd',
      path: '/home/dev/.claude/skills/tdd/SKILL.md',
      invoke: '/tdd',
      description: 'Red-green-refactor loop with an integration test first.'
    },
    {
      agent: 'claude',
      source: 'user',
      name: 'triage',
      path: '/home/dev/.claude/skills/triage/SKILL.md',
      invoke: '/triage',
      description: 'Drive an issue through the triage state machine.'
    },
    {
      agent: 'codex',
      source: 'user',
      name: 'lint-sweep',
      path: '/home/dev/.codex/skills/lint-sweep/SKILL.md',
      invoke: '/lint-sweep',
      description: ''
    }
  ]
  const w = window as unknown as { houston?: Record<string, unknown> }
  w.houston = { ...(w.houston ?? {}), listSkills: async () => skills }
}

function skillColumn(tool: SkillToolState['tool'], names: string[], inherits = false): SkillToolState {
  return {
    tool,
    path: `/home/dev/.${tool}/skills`,
    detected: true,
    inherits_claude: inherits,
    skills: names.map((name) => ({ name, path: `/skills/${name}`, digest: name === 'tdd' ? 'A' : 'B' })),
    error: null
  }
}

export function NavSkills(): React.JSX.Element {
  installSkillFixture()
  return (
    <Frame>
      <SkillsSurface
        tools={[
          skillColumn('claude', ['tdd', 'triage']),
          skillColumn('codex', ['lint-sweep']),
          skillColumn('cursor', [], true)
        ]}
        pushes={[]}
        autoPushEnabled={false}
        onRefresh={noop}
        onPush={noop}
        onPushUndo={noop}
        onAutoPushSet={noop}
      />
    </Frame>
  )
}

function mcpServer(name: string, fingerprint: string, o: Partial<McpServer> = {}): McpServer {
  return {
    name,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', `@upstash/${name}-mcp`],
    env: [],
    url: null,
    headers: [],
    cwd: null,
    enabled: true,
    fingerprint,
    destinations: [],
    ...o
  }
}

function mcpColumn(tool: McpToolState['tool'], servers: McpServer[], detected = true): McpToolState {
  return { tool, path: `/home/dev/.${tool}/config.json`, detected, servers, error: null }
}

export function NavMcp(): React.JSX.Element {
  return (
    <Frame>
      <McpSurface
        source={[mcpServer('context7', 'A'), mcpServer('playwright', 'P')]}
        tools={[
          mcpColumn('claude', [mcpServer('context7', 'A'), mcpServer('playwright', 'P')]),
          mcpColumn('codex', [mcpServer('context7', 'B')]),
          mcpColumn('opencode', [mcpServer('context7', 'A'), mcpServer('sentry', 'S')]),
          mcpColumn('cursor', [], false)
        ]}
        results={[]}
        checks={[]}
        loaded
        onRefresh={noop}
        onSync={noop}
        onImport={noop}
        onSetEnabled={noop}
        onUpsertServer={noop}
        onRemoveServer={noop}
        onTest={noop}
        onOpenSource={noop}
      />
    </Frame>
  )
}

export function NavMcpDetail(): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[aria-label="details for context7"]')?.click()
  }, [])
  return (
    <div ref={ref} style={{ display: 'flex', flex: 1, minWidth: 0, height: '100%' }}>
      <NavMcp />
    </div>
  )
}

function hook(o: Partial<AgentHookState>): AgentHookState {
  return {
    provider: 'claude',
    path: '.claude/settings.local.json',
    scope: 'workspace',
    enabled: false,
    installed: false,
    error: null,
    present: true,
    version: '1.0.0',
    trust: null,
    ...o
  }
}

export function NavHooks(): React.JSX.Element {
  return (
    <Frame>
      <HooksSurface
        providers={[
          hook({ provider: 'claude', enabled: true, installed: true }),
          hook({ provider: 'codex', path: '~/.codex/config.toml', scope: 'global', enabled: true }),
          hook({ provider: 'opencode', path: '~/.config/opencode/plugin/tr.js', scope: 'global' }),
          hook({
            provider: 'cursor',
            path: '~/.cursor/hooks.json',
            scope: 'global',
            error: 'hooks.json is not valid JSON — Houston refused to rewrite it.'
          }),
          hook({ provider: 'grok', path: '~/.grok/hooks/houston.json', scope: 'global' })
        ]}
        onSet={noop}
        onRefresh={noop}
      />
    </Frame>
  )
}
