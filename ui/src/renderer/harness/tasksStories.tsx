import React from 'react'
import type { HoustonClient, SessionInfo } from '../src/houston/client'
import type { AgentKind } from '../src/houston/generated/AgentKind'
import type { ServerMsg } from '../src/houston/generated/ServerMsg'
import type { TaskAcceptanceItem } from '../src/houston/generated/TaskAcceptanceItem'
import type { TaskHistoryEntry } from '../src/houston/generated/TaskHistoryEntry'
import type { TaskSummary } from '../src/houston/generated/TaskSummary'
import type { TasksAccess } from '../src/houston/generated/TasksAccess'
import type { TaskDetailData } from '../src/houston/useTasks'
import { ChildrenRoster } from '../src/components/ChildrenRoster'
import { OverviewTab } from '../src/components/OverviewTab'
import { SessionPane } from '../src/components/SessionPane'
import type { OutputSink } from '../src/pane/TerminalPane'
import { TaskDetail } from '../src/components/tasks/TaskDetail'
import { TasksList } from '../src/components/tasks/TasksList'
import { SettingsScreen } from './settingsStories'
import '../src/components/tasks/tasks.css'
import '../src/components/sidePanel.css'

const NOW = 1_700_000_000_000
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const noop = (): void => {}

function summary(
  id: number,
  title: string,
  status: TaskSummary['status'],
  priority: TaskSummary['priority'],
  ageMs: number,
  extra: Partial<TaskSummary> = {}
): TaskSummary {
  return {
    id,
    workspace: '/home/dev/code/houston',
    number: id,
    key: `HOU-${id}`,
    title,
    status,
    priority,
    parent_id: null,
    ref_url: null,
    revision: 1,
    created_by: 'user',
    created_at_ms: NOW - 2 * HOUR,
    updated_at_ms: NOW - ageMs,
    archived_at_ms: null,
    acceptance_checked: 0,
    acceptance_total: 0,
    ...extra
  }
}

const RUN_41 = {
  id: 7,
  task_id: 41,
  attempt: 1,
  kind: 'implementation',
  state: 'waiting_for_input',
  provider: 'claude',
  reviewer: null,
  session_id: 431,
  delegation_id: null,
  worktree_path: '/home/dev/code/houston/.houston/worktrees/hou-41-slug',
  branch: 'task/hou-41-slug',
  base_commit: null,
  initial_revision: 9,
  summary: null,
  reason: null,
  started_at_ms: NOW - 8 * MINUTE,
  ended_at_ms: null
} as const

const TASKS: TaskSummary[] = [
  summary(41, 'pane_spawn refuses unsafe worktree slugs', 'in_progress', 'high', 2 * MINUTE, {
    open_run: RUN_41,
    acceptance_checked: 2,
    acceptance_total: 3
  }),
  summary(42, 'Measure cleanup pass cost per worktree', 'in_progress', 'medium', 3 * MINUTE, {
    open_run: { ...RUN_41, id: 8, task_id: 42, state: 'running', session_id: 432, branch: 'task/hou-42-cleanup-cost' }
  }),
  summary(44, 'Document the base branch of a worktree spawn', 'in_review', 'low', 12 * MINUTE),
  summary(45, 'Move git out of temporary_cleanup_lock', 'in_review', 'high', 18 * MINUTE),
  summary(43, 'Regression test: child stalls on folder-trust prompt', 'todo', 'high', HOUR),
  summary(47, 'hs-pane exits non-zero when a cap is hit', 'todo', 'medium', 25 * MINUTE),
  summary(46, 'A renamed pane keeps its name across respawn', 'todo', 'medium', 2 * HOUR),
  summary(48, 'Style guide: terminal link hit area', 'backlog', 'none', 3 * DAY),
  summary(49, 'Worktree sweep: report bytes reclaimed', 'backlog', 'low', 3 * DAY),
  summary(40, 'pane_prompt retries after a daemon restart', 'done', 'high', DAY),
  summary(39, 'Children persist in the orchestrator roster', 'done', 'high', 2 * DAY)
]

function acceptance(id: number, position: number, text: string, checked: boolean): TaskAcceptanceItem {
  return {
    id,
    position,
    text,
    checked_at_ms: checked ? NOW - 30 * MINUTE : null,
    checked_by: checked ? 'user' : null
  }
}

const DETAIL: TaskDetailData = {
  task: {
    id: 41,
    workspace: '/home/dev/code/houston',
    number: 41,
    key: 'HOU-41',
    title: 'pane_spawn refuses unsafe worktree slugs',
    description:
      'A slug with control characters or more than 48 bytes must be refused with an error that names the slug, the limit and the actual length.',
    status: 'in_progress',
    priority: 'high',
    parent_id: null,
    ref_url: null,
    revision: 9,
    created_by: 'user',
    created_at_ms: NOW - 2 * HOUR,
    updated_at_ms: NOW - 2 * MINUTE,
    archived_at_ms: null,
    links: []
  },
  acceptance: [
    acceptance(1, 0, 'Control characters are rejected', true),
    acceptance(2, 1, 'Error names slug, limit 48 and actual length', true),
    acceptance(3, 2, 'Regression test fails before the fix', false)
  ],
  comments: [
    {
      id: 1,
      body: 'slug::validate added; running the orchestration tests next.',
      author: 'user',
      created_at_ms: NOW - 3 * MINUTE
    }
  ],
  history: [
    { id: 1, actor: 'user', action: 'create', changes: '{}', created_at_ms: NOW - 2 * HOUR },
    {
      id: 2,
      actor: 'houston:start',
      action: 'start',
      changes: '{"status":{"from":"todo","to":"in_progress"},"run":7,"session":431}',
      created_at_ms: NOW - 8 * MINUTE
    },
    {
      id: 3,
      actor: 'houston:pane-working',
      action: 'pane_working',
      changes: '{"status":{"from":"todo","to":"in_progress"},"run":7,"session":431}',
      created_at_ms: NOW - 8 * MINUTE
    },
    {
      id: 4,
      actor: 'user',
      action: 'check',
      changes: '{"item":1,"text":"Control characters are rejected"}',
      created_at_ms: NOW - 6 * MINUTE
    },
    {
      id: 5,
      actor: 'user',
      action: 'check',
      changes: '{"item":2,"text":"Error names slug, limit 48 and actual length"}',
      created_at_ms: NOW - 5 * MINUTE
    }
  ] as TaskHistoryEntry[],
  runs: [RUN_41]
}

const SESSIONS: ReadonlyMap<number, SessionInfo> = new Map([
  [
    431,
    {
      id: 431,
      agent: 'claude',
      project_dir: '/home/dev/code/houston/.houston/worktrees/hou-41-slug',
      cwd: '/home/dev/code/houston/.houston/worktrees/hou-41-slug',
      state: 'running',
      title: 'HOU-41 pane_spawn refuses unsafe worktree slugs',
      codename: 'backend',
      hidden: false,
      live_children: 0,
      children_waiting: 0,
      inbox_unread: 0,
      tags: [],
      resumable: true,
      task: { task_id: 41, key: 'HOU-41', title: 'pane_spawn refuses unsafe worktree slugs', status: 'in_progress', run_id: 7, run_state: 'waiting_for_input' }
    }
  ]
])

function PanelShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--rail-bg)', paddingTop: 8 }}>
      <aside className="side-panel" style={{ width: 460, height: '100%' }}>
        <div className="side-card">{children}</div>
      </aside>
    </div>
  )
}

export function TasksListStory(): React.JSX.Element {
  return (
    <PanelShell>
      <TasksList
        tasks={TASKS}
        selectedId={null}
        now={NOW}
        access="write"
        refusal={null}
        onOpen={noop}
        onNew={noop}
        onAccess={noop}
      />
    </PanelShell>
  )
}

export function TasksDetailStory(): React.JSX.Element {
  return (
    <PanelShell>
      <TaskDetail
        detail={DETAIL}
        access="write"
        refusal={null}
        now={NOW}
        parentOptions={[{ value: '46', label: 'HOU-46 — A renamed pane keeps its name across respawn' }]}
        sessions={SESSIONS}
        startSettings={{ agent: 'claude', delivery: 'send' }}
        onBack={noop}
        onReload={noop}
        onSave={noop}
        onCheck={noop}
        onComment={noop}
        onArchive={noop}
        onStart={noop}
        onRunControl={noop}
        onOpenSession={noop}
        onReview={noop}
      />
    </PanelShell>
  )
}

function tasksAccessClient(initial: TasksAccess): HoustonClient {
  let access = initial
  let review: { reviewer: AgentKind | null; reworkRounds: number } = { reviewer: null, reworkRounds: 0 }
  const accessHandlers = new Set<(msg: ServerMsg) => void>()
  const reviewHandlers = new Set<(msg: ServerMsg) => void>()
  const client = {
    subscribe: (kind: string, handler: (msg: ServerMsg) => void) => {
      if (kind === 'tasks_access') accessHandlers.add(handler)
      if (kind === 'task_review_settings') reviewHandlers.add(handler)
      return () => {
        accessHandlers.delete(handler)
        reviewHandlers.delete(handler)
      }
    },
    tasksAccessGet: (workspace: string) => {
      for (const handler of accessHandlers) handler({ type: 'tasks_access', workspace, access })
    },
    tasksAccessSet: (workspace: string, next: TasksAccess) => {
      access = next
      for (const handler of accessHandlers) handler({ type: 'tasks_access', workspace, access })
    },
    taskReviewSettingsGet: (workspace: string) => {
      for (const handler of reviewHandlers) {
        handler({ type: 'task_review_settings', workspace, reviewer: review.reviewer, rework_rounds: review.reworkRounds })
      }
    },
    taskReviewSettingsSet: (workspace: string, reviewer: AgentKind | null, reworkRounds: number) => {
      review = { reviewer, reworkRounds }
      for (const handler of reviewHandlers) {
        handler({ type: 'task_review_settings', workspace, reviewer, rework_rounds: reworkRounds })
      }
    }
  }
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined
      return () => undefined
    }
  }) as unknown as HoustonClient
}

export function TasksSettingsStory(): React.JSX.Element {
  return <SettingsScreen section="tasks" props={{
    daemonClient: tasksAccessClient('write'),
    historyWorkspace: '/home/dev/code/houston',
    historyWorkspaceName: 'houston'
  }} />
}

const ROSTER_WORKSPACE = '/home/dev/code/houston'

const ROSTER_READY: TaskSummary[] = [
  summary(43, 'Regression test: child stalls on folder-trust prompt', 'todo', 'high', HOUR),
  summary(47, 'hs-pane exits non-zero when a cap is hit', 'todo', 'medium', 25 * MINUTE)
]

function rosterChild(
  id: number,
  role: string,
  status: NonNullable<SessionInfo['status']>,
  taskNumber: number | null
): SessionInfo {
  const settled = status === 'idle'
  return {
    id,
    agent: 'claude',
    project_dir: ROSTER_WORKSPACE,
    cwd: ROSTER_WORKSPACE,
    state: settled ? 'exited' : 'running',
    title: `${role} child`,
    codename: role,
    hidden: false,
    spawned_by: 398,
    live_children: 0,
    children_waiting: 0,
    inbox_unread: 0,
    tags: [],
    resumable: false,
    status,
    delegation: {
      state: settled ? 'done' : 'working',
      role,
      started_at: NOW - 8 * MINUTE,
      settled_at: settled ? NOW - MINUTE : null
    } as SessionInfo['delegation'],
    task:
      taskNumber === null
        ? null
        : {
            task_id: taskNumber,
            key: `HOU-${taskNumber}`,
            title: `task ${taskNumber}`,
            status: 'in_progress',
            run_id: 7,
            run_state: 'running'
          }
  }
}

const ROSTER_PARENT: SessionInfo = {
  id: 398,
  agent: 'claude',
  project_dir: ROSTER_WORKSPACE,
  cwd: ROSTER_WORKSPACE,
  state: 'running',
  title: 'Orchestrator — houston queue',
  codename: 'orchestrator',
  hidden: false,
  live_children: 5,
  children_waiting: 0,
  inbox_unread: 0,
  tags: [],
  resumable: false,
  status: 'working'
}

const ROSTER_SESSIONS: ReadonlyMap<number, SessionInfo> = new Map(
  [
    rosterChild(431, 'backend', 'needs-input', 41),
    rosterChild(432, 'perf', 'working', 42),
    rosterChild(433, 'tests', 'working', 43),
    rosterChild(434, 'docs', 'idle', 44),
    rosterChild(435, 'lock', 'idle', 45)
  ].map((child) => [child.id, child])
)

function OverviewRosterStory(): React.JSX.Element {
  const client = React.useMemo(() => new Proxy({
    subscribe: () => () => {},
    delegationResultsList: noop,
    inboxList: noop,
    gitStatus: noop
  }, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined
      return noop
    }
  }) as unknown as HoustonClient, [])
  const sessions = new Map([[ROSTER_PARENT.id, ROSTER_PARENT], ...ROSTER_SESSIONS])
  return <div style={{ height: '100%', overflow: 'auto', background: 'var(--content-bg)' }}><OverviewTab parentId={ROSTER_PARENT.id} sessions={sessions} client={client} onClose={noop} onReview={noop} /></div>
}

export function TasksOverviewRosterStory(): React.JSX.Element {
  return <OverviewRosterStory />
}

function rosterClient(): HoustonClient {
  const handlers = new Set<(msg: ServerMsg) => void>()
  const client = {
    subscribe: (kind: string, handler: (msg: ServerMsg) => void) => {
      if (kind === 'task_snapshot') handlers.add(handler)
      return () => handlers.delete(handler)
    },
    taskSnapshot: (workspace: string) => {
      for (const handler of handlers) {
        handler({
          type: 'task_snapshot',
          scope: workspace,
          tasks: ROSTER_READY,
          counts: { ready: 2, backlog: 2, todo: 2, in_progress: 2, in_review: 2, done: 2, canceled: 0 }
        })
      }
    },
    closeSession: noop,
    inboxDeliverNow: noop,
    taskQueueRun: noop
  }
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined
      return () => undefined
    }
  }) as unknown as HoustonClient
}

function RosterStory({ view }: { view: 'children' | 'queue' }): React.JSX.Element {
  const client = React.useMemo(() => rosterClient(), [])
  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--card-bg)' }}>
      <ChildrenRoster
        parent={ROSTER_PARENT}
        children={[...ROSTER_SESSIONS.values()]}
        roster={{ sessions: ROSTER_SESSIONS, maxLiveChildren: 4 }}
        client={client}
        selected={null}
        onSelect={noop}
        onMove={noop}
        collapsed={false}
        onCollapse={noop}
        defaultView={view}
      />
    </div>
  )
}

export function TasksRosterStory(): React.JSX.Element {
  return <RosterStory view="children" />
}

export function TasksQueueStory(): React.JSX.Element {
  return <RosterStory view="queue" />
}


export function PaneLifecycleStory(): React.JSX.Element {
  const children = React.useMemo(() => [
    { ...rosterChild(431, 'reviewer', 'needs-input', null), task: null, title: 'Confirm the target branch' },
    { ...rosterChild(432, 'validator', 'working', null), task: null, title: 'Waiting after validation', delegation: { ...rosterChild(432, 'validator', 'working', null).delegation!, stalled: true } },
    { ...rosterChild(433, 'backend', 'working', null), task: null, title: 'Completed the requested change', delegation: { ...rosterChild(433, 'backend', 'working', null).delegation!, state: 'done' as const, result_staged: true, settled_at: NOW - MINUTE } },
    { ...rosterChild(434, 'tests', 'working', null), task: null, title: 'Regression tests passed', delegation: { ...rosterChild(434, 'tests', 'working', null).delegation!, state: 'done' as const, inbox_owed: 1, settled_at: NOW - MINUTE } },
  ], [])
  const parent = { ...ROSTER_PARENT, title: 'Pane lifecycle', live_children: 4, children_waiting: 1, inbox_unread: 2 }
  const sinks = React.useRef(new Map<number, OutputSink>())
  const client = React.useMemo(() => new Proxy({
    subscribe: () => noop,
    attachSession: (id: number) => queueMicrotask(() => {
      const text = id === 398 ? 'Orchestrator terminal ready.\r\nSelect a child to inspect its terminal.\r\n' : `Child ${id} terminal ready.\r\nRecorded output remains visible after switching children.\r\n`
      const bytes = new TextEncoder().encode(text)
      sinks.current.get(id)?.replay(bytes, bytes.length)
    }),
  }, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined
      return noop
    },
  }) as unknown as HoustonClient, [])
  return <div style={{ height: '100%', padding: 12, display: 'flex' }}><SessionPane
    info={parent} client={client} roster={{ sessions: new Map([parent, ...children].map((pane) => [pane.id, pane])), maxLiveChildren: 8 }}
    gridSessionIds={new Set([parent.id])} theme="black" active connected fontSize={14} copyOnSelect={false} stripBoxGlyphs={false} showProject={false} shellIntegration={false}
    registerOutput={(id, sink) => { sinks.current.set(id, sink); return () => { sinks.current.delete(id) } }}
    onReconnectSsh={noop} onActivate={noop} onExpand={noop} onZoom={noop} onShellZoom={noop} onSplit={noop} onHeaderPointerDown={noop} onHandoff={noop} onOpenFile={noop} onOpenDir={noop}
  /></div>
}
