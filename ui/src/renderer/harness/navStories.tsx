import React from 'react'
import { HooksSurface } from '../src/components/nav/HooksSurface'
import { McpSurface } from '../src/components/nav/McpSurface'
import { RoutinesSurface } from '../src/components/nav/RoutinesSurface'
import { RoutineEditor } from '../src/components/nav/RoutineEditor'
import { SkillsSurface } from '../src/components/nav/SkillsSurface'
import { HarnessSurface } from '../src/components/nav/HarnessSurface'
import { HarnessHistory } from '../src/components/nav/HarnessHistory'
import { HarnessFindings } from '../src/components/nav/HarnessFindings'
import { HarnessReportView } from '../src/components/nav/HarnessReportView'
import { ListDetail } from '../src/components/nav/ListDetail'
import { RoutineHistory, RoutineRow } from '../src/components/nav/RoutineRow'
import { NavBack, NavDetailState, NavEmpty, NavFeedback, NavFootnote, NavSwitch } from '../src/components/nav/navChrome'
import { IconFolder } from '../src/components/icons'
import type { AgentHookState } from '../src/houston/generated/AgentHookState'
import type { HarnessFinding } from '../src/houston/generated/HarnessFinding'
import type { HarnessReview } from '../src/houston/generated/HarnessReview'
import type { HarnessState } from '../src/houston/useHarness'
import type { McpServer } from '../src/houston/generated/McpServer'
import type { McpSyncResult } from '../src/houston/generated/McpSyncResult'
import type { McpToolState } from '../src/houston/generated/McpToolState'
import type { Routine } from '../src/houston/routineTypes'
import type { RoutineRun } from '../src/houston/generated/RoutineRun'
import type { SkillToolState } from '../src/houston/generated/SkillToolState'
import type { Skill } from '../src/env'
import type { HoustonClient } from '../src/houston/client'

const noop = (): void => {}

const NOW = new Date(2026, 9, 3, 12).getTime()

function Frame({ children, active = 'Routines' }: { children: React.ReactNode; active?: 'Routines' | 'Connections' | 'Skills' }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flex: 1, minWidth: 0, height: '100%' }}>
      <aside style={{ width: 148, flex: 'none', padding: 8, background: 'var(--rail-bg)', color: 'var(--text-secondary)' }}>
        <div style={{ padding: 8, color: 'var(--text-faint)', fontSize: 11 }}>HOUSTON</div>
        <div style={{ display: 'grid', gap: 2, marginBottom: 8 }}>
          {['auth-refactor', 'migrate-db', 'shell'].map((item, index) => <div key={item} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', fontSize: 12 }}><i style={{ width: 6, height: 6, borderRadius: '50%', background: index === 0 ? 'var(--info)' : index === 1 ? 'var(--warn)' : 'transparent', border: index === 2 ? '1px solid var(--text-faint)' : undefined }} />{item}</div>)}
        </div>
        <div style={{ height: 1, background: 'var(--divider)', margin: '0 8px 8px' }} />
        <div style={{ display: 'grid', gap: 2, fontSize: 13 }}>
          {['Tasks', 'Routines', 'Skills', 'Harness', 'Connections', 'Usage'].map((item) => <div key={item} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 8px', borderRadius: 6, background: item === active ? 'var(--hover-fill)' : 'transparent', color: item === active ? 'var(--text-primary)' : undefined }}><span>{item}</span>{item === 'Tasks' ? <span style={{ color: 'var(--warn)' }}>2</span> : item === 'Harness' ? <span style={{ color: 'var(--warn)' }}>1</span> : null}</div>)}
        </div>
      </aside>
      <div style={{ display: 'flex', minWidth: 0, flex: 1 }}>{children}</div>
    </div>
  )
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
  const run = (id: number, status: RoutineRun['status'], started: number, sessionId: number | null, error?: string): RoutineRun => ({
    id, routine_id: 2, trigger: 'schedule', status, started_at_ms: started, ended_at_ms: status === 'running' ? null : started + 4 * 60_000,
    session_id: sessionId, error
  })
  const runHistory: RoutineRun[] = [
    run(30, 'running', new Date(2026, 9, 3, 2).getTime(), 42),
    run(29, 'ok', new Date(2026, 9, 2, 2).getTime(), 41),
    run(28, 'failed', new Date(2026, 9, 1, 2).getTime(), 40, 'npx was not found on PATH'),
    ...Array.from({ length: 27 }, (_, index) => run(27 - index, 'ok', new Date(2026, 8, 30 - index, 2).getTime(), 13 + index))
  ]
  const routines = [
    routine({ id: 1, name: 'Harness review', cadence: { type: 'clock', hour: 9, minute: 0, weekdays: [2] }, next_run_at_ms: NOW - 120_000, last_run_at_ms: NOW - 60_000 }),
    routine({ id: 2, name: 'Nightly dependency check', cadence: { type: 'clock', hour: 2, minute: 0, weekdays: null }, next_run_at_ms: NOW - 60_000, workspace_id: null }),
    routine({ id: 3, name: 'Weekly changelog draft', cadence: { type: 'clock', hour: 17, minute: 0, weekdays: [6] }, next_run_at_ms: new Date(2026, 9, 9, 17).getTime(), last_run_at_ms: NOW - 24 * 3600_000, last_outcome: 'ok', workspace_id: null }),
    routine({ id: 4, name: 'Flaky test sweep', enabled: false, workspace_id: null, next_run_at_ms: NOW + 7 * 24 * 3600_000 })
  ]
  return (
    <Frame active="Routines">
      <RoutinesSurface
        routines={routines}
        running={[1, 91, 92]}
        runs={{ 2: runHistory }}
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
        selectedRoutineId={2}
        showLimitNotice={false}
      />
    </Frame>
  )
}

export function NavRoutineEditor(): React.JSX.Element {
  return (
    <Frame active="Routines">
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
    <Frame active="Routines">
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
      source: 'project',
      name: 'ui-tokens',
      path: '/home/dev/code/auth-refactor/.claude/skills/ui-tokens/SKILL.md',
      invoke: '/ui-tokens',
      description: 'Use theme tokens and shared chrome constants in the renderer.'
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
  w.houston = {
    ...(w.houston ?? {}),
    listSkills: async () => skills,
    readFile: async (path: string) => path.endsWith('digest.jsonl')
      ? `${JSON.stringify({ skills: { 'ui-tokens': 1 } })}\n${JSON.stringify({ skills: {} })}`
      : '# UI tokens\n\nUse the shared design tokens.'
  }
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

function OpenSkillStory({ children }: { children: React.ReactNode }): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const timer = window.setInterval(() => {
      const button = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
        .find((candidate) => candidate.textContent?.includes('ui-tokens'))
      if (!button) return
      button.click()
      window.clearInterval(timer)
    }, 50)
    return () => window.clearInterval(timer)
  }, [])
  return <div ref={ref} style={{ display: 'flex', flex: 1, minWidth: 0 }}>{children}</div>
}

export function NavSkills(): React.JSX.Element {
  installSkillFixture()
  const client = React.useMemo(() => {
    const handlers = new Map<string, (message: unknown) => void>()
    const state: HarnessState = {
      workspace: '/home/dev/code/auth-refactor',
      routine: null,
      reviews: [{ id: 13, workspace: '/home/dev/code/auth-refactor', routine_id: 1, run_id: 13, status: 'published', started_at_ms: 1, run_dir: '/home/dev/code/auth-refactor/.houston/harness/r13', finding_count: 0 }],
      findings: [],
      models: [],
      providerCoverage: []
    }
    return {
      subscribe(kind: string, handler: (message: never) => void) {
        handlers.set(kind, handler as (message: unknown) => void)
        return () => handlers.delete(kind)
      },
      harnessState() {
        queueMicrotask(() => handlers.get('harness_state')?.({
          type: 'harness_state',
          workspace: state.workspace,
          routine: state.routine,
          reviews: state.reviews,
          findings: state.findings,
          models: state.models,
          provider_coverage: state.providerCoverage
        }))
      }
    } as unknown as HoustonClient
  }, [])
  return (
    <Frame active="Skills">
      <OpenSkillStory>
        <SkillsSurface
          tools={[
            skillColumn('claude', ['tdd', 'ui-tokens']),
            skillColumn('codex', ['ui-tokens']),
            skillColumn('opencode', [], true),
            skillColumn('cursor', [], true),
            skillColumn('grok', [], true)
          ]}
          client={client}
          workspace="/home/dev/code/auth-refactor"
          focusedPaneName="auth-refactor"
          canRunSkillInFocusedPane
          onRunSkill={noop}
          pushes={[]}
          autoPushEnabled={false}
          onRefresh={noop}
          onPush={noop}
          onPushUndo={noop}
          onAutoPushSet={noop}
        />
      </OpenSkillStory>
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

export function NavMcp({ slackClient = null, results = [] }: { slackClient?: HoustonClient | null; results?: McpSyncResult[] } = {}): React.JSX.Element {
  return (
    <Frame active="Connections">
      <McpSurface
        source={[mcpServer('github', 'G'), mcpServer('linear', 'L'), mcpServer('postgres-local', 'P')]}
        tools={[
          mcpColumn('claude', [mcpServer('github', 'G'), mcpServer('linear', 'L'), mcpServer('postgres-local', 'P')]),
          mcpColumn('codex', [mcpServer('linear', 'L')]),
          mcpColumn('opencode', [mcpServer('linear', 'L'), mcpServer('postgres-local', 'OP')]),
          mcpColumn('cursor', [mcpServer('postgres-local', 'P')])
        ]}
        results={results}
        checks={[["github", { state: 'failed', message: 'npx was not found on PATH' }]]}
        loaded
        onRefresh={noop}
        onSync={noop}
        onImport={noop}
        onSetEnabled={noop}
        onUpsertServer={noop}
        onRemoveServer={noop}
        onTest={noop}
        onOpenSource={noop}
        slackClient={slackClient}
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

export function NavMcpForm(): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const manager = ref.current
    if (!manager) return
    const openForm = (): boolean => {
      const button = [...manager.querySelectorAll<HTMLButtonElement>('[data-testid="mcp-manager"] button')]
        .find((item) => item.textContent?.includes('Add server'))
      if (!button) return false
      button.click()
      return true
    }
    if (openForm()) return
    const observer = new MutationObserver(() => {
      if (openForm()) observer.disconnect()
    })
    observer.observe(manager, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])
  return <div ref={ref} style={{ display: 'flex', flex: 1, minWidth: 0, height: '100%' }}><NavMcp results={[{ tool: 'claude', written: 3, removed: 0, skipped: [], error: null }]} /></div>
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

const HARNESS_WS = '/home/dev/code/auth-refactor'

function harnessReview(id: number, sessions: number, findingCount: number, startedAt?: number): HarnessReview {
  const started = startedAt ?? Date.UTC(2026, 9, 5, 12) - (13 - id) * 7 * 86_400_000
  return {
    id,
    workspace: HARNESS_WS,
    routine_id: 3,
    run_id: 100 + id,
    session_id: 500 + id,
    status: 'published',
    started_at_ms: started,
    ended_at_ms: started + 900_000,
    run_dir: `${HARNESS_WS}/.houston/harness/r${100 + id}`,
    window: ['2026-09-01', '2026-09-28'],
    sessions,
    prompts: sessions * 8,
    cost_usd: 1.2,
    finding_count: findingCount,
    summary: `${findingCount} findings`,
    error: null
  }
}

function harnessFinding(overrides: Partial<HarnessFinding>): HarnessFinding {
  return {
    review_id: 13,
    key: 'HOU-42',
    title: 'Agents run bun test instead of bun run test',
    category: 'verification',
    confidence: 'high',
    sessions: ['session-a'],
    count: 11,
    quotes: [],
    recommendation_kind: 'tooling',
    target: 'AGENTS.md',
    recommendation: 'Use bun run test.',
    apply_prompt: 'Update the command.',
    state: 'open',
    recurred: false,
    phase: 'open',
    task: null,
    verification: null,
    last_seen_review_id: 13,
    ...overrides
  }
}

export function HarnessPageStory({ firstRun = false, noReviews = false }: { firstRun?: boolean; noReviews?: boolean }): React.JSX.Element {
  const latest = harnessReview(13, 38, 7)
  const reviews = [latest, harnessReview(12, 41, 10, Date.UTC(2026, 8, 22, 12))]
  const findings = [
    harnessFinding({ key: 'HOU-47', title: 'Agents re-read the styleguide on every UI change', count: 9, target: 'AGENTS.md', review_id: 13 }),
    harnessFinding({ key: 'HOU-42', count: 11, task: { task_id: 42, key: 'HOU-42', status: 'in_progress', landed_at_ms: null }, phase: 'fixing' }),
    harnessFinding({
      key: 'HOU-44',
      title: 'Codex skips hooks until the first approval',
      count: 6,
      review_id: 12,
      task: { task_id: 44, key: 'HOU-44', status: 'done', landed_at_ms: Date.UTC(2026, 9, 2) },
      phase: 'awaiting_verification',
      verification: { review_id: 12, verdict: 'inconclusive', sessions_after: 6, quotes: [] }
    }),
    harnessFinding({ key: 'HOU-51', title: 'Agents open the browser pane to read local docs', review_id: 12, count: 4, phase: 'not_seen', state: 'open', last_seen_review_id: 12 }),
    harnessFinding({
      key: 'HOU-41',
      title: 'Pane titles get truncated',
      review_id: 12,
      phase: 'resolved',
      state: 'resolved',
      task: { task_id: 41, key: 'HOU-41', status: 'done', landed_at_ms: Date.UTC(2026, 8, 24) },
      verification: { review_id: 13, verdict: 'gone', sessions_after: 0, quotes: [] }
    }),
  ]
  const state: HarnessState = {
    workspace: HARNESS_WS,
    routine: {
      id: 3,
      name: 'Harness review · auth-refactor',
      prompt: '[houston harness review]',
      cadence: { type: 'clock', hour: 9, minute: 0, weekdays: [2] },
      enabled: true,
      workspace_id: HARNESS_WS,
      engine: 'claude',
      model: null,
      next_run_at_ms: Date.UTC(2026, 9, 5, 12),
      permission_mode: 'accept_edits',
      isolate: false,
      revision: 'review-3'
    },
    reviews,
    findings,
    models: [],
    providerCoverage: [{ agent: 'opencode', sessions: 4 }]
  }
  const shown: HarnessState = firstRun || noReviews ? { ...state, routine: firstRun ? null : state.routine, reviews: [], findings: [], providerCoverage: [] } : state

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%', minWidth: 0 }}>
      <div style={{ display: 'flex', width: 'calc(100% - 16px)', height: 'calc(100% - 8px)', margin: '0 8px 8px', border: '1px solid var(--divider)', borderRadius: 10, overflow: 'hidden' }}>
        <aside style={{ width: 140, flex: 'none', padding: 8, background: 'var(--rail-bg)', color: 'var(--text-secondary)' }}>
          <div style={{ padding: 8, color: 'var(--text-faint)', fontSize: 11 }}>HOUSTON</div>
          <div style={{ display: 'grid', gap: 2, marginBottom: 8 }}>
            {['auth-refactor', 'migrate-db', 'shell'].map((item, index) => (
              <div key={item} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', fontSize: 12 }}><i style={{ width: 6, height: 6, borderRadius: '50%', background: index === 0 ? 'var(--info)' : index === 1 ? 'var(--warn)' : 'transparent', border: index === 2 ? '1px solid var(--text-faint)' : undefined }} />{item}</div>
            ))}
          </div>
          <div style={{ height: 1, background: 'var(--divider)', margin: '0 8px 8px' }} />
          <div style={{ display: 'grid', gap: 2 }}>
            {['Tasks', 'Routines', 'Skills', 'Harness', 'Connections', 'Usage'].map((item) => (
              <div key={item} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 8px', borderRadius: 6, background: item === 'Harness' ? 'var(--hover-fill)' : 'transparent' }}><span>{item}</span>{item === 'Tasks' ? <span style={{ color: 'var(--warn)' }}>2</span> : item === 'Harness' ? <span style={{ color: 'var(--warn)' }}>1</span> : null}</div>
            ))}
          </div>
        </aside>
        <HarnessSurface
        workspaces={[{ id: HARNESS_WS, name: 'auth-refactor' }]}
        workspace={HARNESS_WS}
        onWorkspace={noop}
        state={shown}
        report={null}
        running={false}
        error={null}
        onCreateRoutine={noop}
        onRunNow={noop}
        onDecide={noop}
        attention={firstRun || noReviews ? null : {
          workspace: HARNESS_WS,
          open: 1,
          fixing: 2,
          awaiting_verification: 1,
          not_seen: 1,
          resolved: 1,
          dismissed: 1,
          latest_published_review_id: 13,
          seen_review_id: 12,
          attention: 4
        }}
        onSeen={noop}
        onCreateTask={noop}
        onLoadReport={noop}
        onOpenFile={noop}
        onReveal={noop}
        trendValues={[41, 33, 25, 18]}
        trendReviewCount={4}
        historyDeltaOverrides={{ 12: { new: 2, gone: 1 } }}
        />
      </div>
    </div>
  )
}

function editorStory(initial: React.ComponentProps<typeof RoutineEditor>['initial'], mode: 'create' | 'edit', error: string | null): React.JSX.Element {
  return (
    <Frame active="Routines">
      <RoutineEditor
        mode={mode}
        workspaces={[{ id: '/home/dev/code/houston', name: 'houston' }]}
        initial={initial}
        error={error}
        onSubmit={noop}
        onCancel={noop}
      />
    </Frame>
  )
}

export function NavRoutineEditorClock(): React.JSX.Element {
  return editorStory({
    engine: 'claude', model: 'opus', effort: 'high', name: 'Nightly dependency check', prompt: 'Check for outdated dependencies.',
    cadence: { type: 'clock', hour: 2, minute: 30, weekdays: [2, 3, 4, 5, 6] }, workspaceId: '/home/dev/code/houston',
    permissionMode: 'bypass_permissions', isolate: true
  }, 'edit', 'A routine with that name already exists.')
}

export function NavRoutineEditorInterval(): React.JSX.Element {
  return editorStory({
    engine: 'opencode', model: null, effort: null, name: 'Leak watch', prompt: '',
    cadence: { type: 'interval', seconds: 1200 }, workspaceId: null, permissionMode: 'accept_edits', isolate: false
  }, 'edit', null)
}

export function NavRoutineRows(): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const timer = window.setTimeout(() => ref.current?.querySelector<HTMLButtonElement>('[data-testid="routine-edit"]')?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [])
  const run = (id: number, status: RoutineRun['status'], started: number, sessionId: number | null, error?: string): RoutineRun => ({
    id, routine_id: 2, trigger: id % 2 ? 'manual' : 'schedule', status, started_at_ms: started, ended_at_ms: status === 'running' ? null : started + 4 * 60_000,
    session_id: sessionId, error
  })
  const runs = [
    run(3, 'running', NOW - 600_000, 42),
    run(2, 'failed', NOW - 86_400_000, 41, 'npx was not found on PATH'),
    run(1, 'ok', NOW - 2 * 86_400_000, null)
  ]
  const common = { workspace: { id: '/home/dev/code/houston', name: 'houston' }, now: NOW, onEdit: noop, onToggleEnabled: noop, onDelete: noop }
  return (
    <Frame active="Routines">
      <div ref={ref} style={{ flex: 1, padding: 24, display: 'grid', alignContent: 'start' }}>
        <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', background: 'var(--card-bg)' }}>
          <RoutineRow {...common} routine={routine({ id: 1, last_outcome: 'ok', last_run_session_id: 9 })} onOpenSession={noop} onRunNow={noop} onToggleHistory={noop} />
          <RoutineRow {...common} routine={routine({ id: 2, name: 'Nightly dependency check', last_error: 'engine refused to start', last_outcome: 'failed', workspace_id: null })} running historyOpen runs={runs} onOpenSession={noop} onToggleHistory={noop} />
          <RoutineRow {...common} routine={routine({ id: 3, name: 'Flaky test sweep', enabled: false, last_outcome: 'denied' })} waitingForSlot={{ running: 2, limit: 2 }} historyOpen runs={[]} />
          <RoutineRow {...common} routine={routine({ id: 4, name: 'Weekly changelog', last_run_at_ms: NOW - 3600_000, last_outcome: 'killed_at_cap' })} historyOpen runsLoading />
          <RoutineRow {...common} routine={routine({ id: 5, name: 'Waiting', last_outcome: 'engine_refused' })} waitingForSlot={{ running: 2, limit: 2 }} />
          <RoutineRow {...common} routine={routine({ id: 6, name: 'Failed dependency check', last_error: 'npx was not found on PATH', last_outcome: 'failed' })} />
        </div>
      </div>
    </Frame>
  )
}

export function NavRoutineRunOutcomes(): React.JSX.Element {
  const statuses: RoutineRun['status'][] = ['running', 'ok', 'denied', 'killed_at_cap', 'engine_refused', 'failed']
  const runs = statuses.map((status, index): RoutineRun => ({
    id: index + 1,
    routine_id: 2,
    trigger: index % 2 ? 'schedule' : 'manual',
    status,
    started_at_ms: NOW - (index + 1) * 60_000,
    ended_at_ms: status === 'running' ? null : NOW - index * 60_000,
    session_id: index === 0 ? 42 : null,
    error: status === 'failed' ? 'npx was not found on PATH' : undefined
  }))
  return (
    <Frame active="Routines">
      <div style={{ flex: 1, padding: 24 }}>
        <RoutineHistory runs={runs} loading={false} now={NOW} onOpenSession={noop} />
      </div>
    </Frame>
  )
}

export function NavListDetailStates(): React.JSX.Element {
  const items = [
    { id: 'a', title: 'Alpha skill', sub: 'user · claude', right: <span style={{ color: 'var(--text-faint)' }}>2</span> },
    { id: 'b', title: 'Beta skill', sub: 'project · codex' },
    { id: 'c', title: 'Gamma skill' }
  ]
  const detail = (item: { title: React.ReactNode } | null): React.JSX.Element => <div>{item ? item.title : 'Nothing selected'}</div>
  return (
    <Frame active="Skills">
      <div style={{ flex: 1, padding: 24, display: 'grid', gap: 24, alignContent: 'start' }}>
        <div style={{ width: 800 }}><ListDetail items={items} backLabel="Skills" renderDetail={detail} listHead={<div style={{ padding: 4 }}>Head</div>} /></div>
        <div style={{ width: 500 }}><ListDetail items={items} backLabel="Skills" renderDetail={detail} forceDetailOpen /></div>
        <div style={{ width: 500 }}><ListDetail items={items} backLabel="Skills" renderDetail={detail} listEmpty={<div>No items</div>} /></div>
      </div>
    </Frame>
  )
}

export function NavChromeStates(): React.JSX.Element {
  const emptyAction = <button type="button">Add one</button>
  return (
    <Frame active="Skills">
      <div style={{ flex: 1, padding: 24, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignContent: 'start' }}>
        <div style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
          <div>
            <NavFeedback>Neutral message</NavFeedback>
            <NavFeedback tone="warning" icon={<IconFolder />} onDismiss={noop} testId="fb-warn">Warning message with dismiss</NavFeedback>
            <NavFeedback tone="error" icon={<IconFolder />}>Error message</NavFeedback>
          </div>
          <NavFootnote>A footnote under a list.</NavFootnote>
          <div style={{ display: 'flex', gap: 12 }}>
            <NavSwitch on label="on" onChange={noop} />
            <NavSwitch on={false} label="off" onChange={noop} />
            <NavSwitch on disabled label="on disabled" onChange={noop} />
            <NavSwitch on={false} disabled label="off disabled" onChange={noop} />
          </div>
          <div style={{ border: '1px solid var(--border)', borderRadius: 10 }}>
            <NavBack label="Skills" onClick={noop}><span>extra</span></NavBack>
          </div>
          <div style={{ border: '1px solid var(--border)', borderRadius: 10 }}>
            <NavDetailState title="Loading the thing" detail="Reading the file from disk." />
            <NavDetailState title="Could not load" detail="The file is gone." tone="error" action={<button type="button">Retry</button>} />
          </div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 10, alignSelf: 'start' }}>
          <NavEmpty title="Nothing here" icon={<IconFolder />} action={emptyAction}>Add the first item to see it listed.</NavEmpty>
        </div>
      </div>
    </Frame>
  )
}

export function HarnessReportStates(): React.JSX.Element {
  const reviews = [harnessReview(13, 38, 7), harnessReview(12, 41, 10, Date.UTC(2026, 8, 22, 12))]
  const base = { reviews, onLoadReport: noop, onOpenFile: noop, onReveal: noop }
  return (
    <Frame active="Routines">
      <div style={{ flex: 1, padding: 24, display: 'grid', gap: 24, alignContent: 'start', overflow: 'auto' }}>
        <HarnessReportView {...base} initialReviewId={13} report={{ reviewId: 13, markdown: '# Review 13\n\nTwo findings.\n\n- one\n- two', truncated: true }} reportError={null} />
        <HarnessReportView {...base} initialReviewId={12} report={null} reportError={{ workspace: HARNESS_WS, reviewId: 12, message: 'report.md is not readable' }} />
        <HarnessReportView {...base} reviews={[]} report={null} reportError={null} />
      </div>
    </Frame>
  )
}

export function HarnessReportLoadingStory(): React.JSX.Element {
  const reviews = [harnessReview(13, 38, 7)]
  return (
    <Frame active="Routines">
      <div style={{ flex: 1, padding: 24 }}>
        <HarnessReportView reviews={reviews} initialReviewId={13} report={null} reportError={null} onLoadReport={noop} onOpenFile={noop} onReveal={noop} />
      </div>
    </Frame>
  )
}

export function HarnessHistoryEmptyStory(): React.JSX.Element {
  return (
    <Frame active="Routines">
      <div style={{ flex: 1, padding: 24, minWidth: 0 }}>
        <HarnessHistory reviews={[]} liveSessions={new Set()} onOpenSession={noop} />
      </div>
    </Frame>
  )
}

export function HarnessFindingsDismissedStory(): React.JSX.Element {
  return (
    <Frame active="Routines">
      <div style={{ flex: 1, padding: 24 }}>
        <HarnessFindings
          workspace={HARNESS_WS}
          findings={[harnessFinding({ key: 'HOU-55', title: 'A dismissed finding', phase: 'dismissed', state: 'dismissed', review_id: 12 })]}
          defaultEngine="claude"
          latestReviewId={13}
          latestReviewSessions={38}
          onDecide={noop}
          onCreateTask={noop}
          onVerifyNow={noop}
        />
      </div>
    </Frame>
  )
}

export function HarnessHistoryStory(): React.JSX.Element {
  const failed: HarnessReview = { ...harnessReview(14, 0, 0), status: 'failed', error: 'engine refused to start', summary: null, sessions: null }
  const running: HarnessReview = { ...harnessReview(15, 0, 0), status: 'running', summary: null, sessions: null, session_id: 999 }
  return (
    <Frame active="Routines">
      <div style={{ flex: 1, padding: 24, minWidth: 0 }}>
        <HarnessHistory reviews={[running, failed, harnessReview(13, 38, 7), harnessReview(12, 41, 10, Date.UTC(2026, 8, 22, 12))]} liveSessions={new Set([513, 515])} onOpenSession={noop} />
      </div>
    </Frame>
  )
}
