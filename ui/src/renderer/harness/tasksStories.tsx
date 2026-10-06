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
import { TaskChip } from '../src/components/tasks/TaskChip'
import { TaskComposer } from '../src/components/tasks/TaskComposer'
import { TaskDetail } from '../src/components/tasks/TaskDetail'
import { TaskNowCard } from '../src/components/tasks/TaskNowCard'
import { TasksList } from '../src/components/tasks/TasksList'
import { RosterColumn } from '../src/components/ui'
import { SettingsScreen } from './settingsStories'

const NOW = 1_700_000_000_000
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const noop = (): void => {}
const STATIC_MOTION = <style>{`.tasks-static *, .tasks-static *::before, .tasks-static *::after { animation: none !important; transition: none !important; }`}</style>

function useFrozenStoryClock(): void {
  Date.now = () => NOW
}

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
    children_total: 0,
    children_done: 0,
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
    links: [],
    blocked_by: []
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

// The side panel column and its card, as the inspector frames a tab's content.
const SIDE_PANEL_STYLE: React.CSSProperties = { width: 460, height: '100%', containerType: 'inline-size', position: 'relative', flex: 'none', display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, background: 'var(--rail-bg)' }
const SIDE_CARD_STYLE: React.CSSProperties = { flex: 1, minHeight: 0, minWidth: 0, margin: '0 8px 8px 0', border: '1px solid var(--border)', borderRadius: 'var(--tr-radius-md)', background: 'var(--card-bg)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }

function SidePanelFrame({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <aside style={SIDE_PANEL_STYLE}>
      <div style={SIDE_CARD_STYLE}>{children}</div>
    </aside>
  )
}

function PanelShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--rail-bg)', paddingTop: 8 }}>
      <SidePanelFrame>{children}</SidePanelFrame>
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

export function TasksStartStory(): React.JSX.Element {
  return (
    <PanelShell>
      <TaskDetail
        detail={{ ...DETAIL, task: { ...DETAIL.task, status: 'todo', archived_at_ms: null }, runs: [] }}
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

function tasksAccessClient(initial: TasksAccess, refuseReview = false): HoustonClient {
  let access = initial
  let review: { reviewer: AgentKind | null; reworkRounds: number } = { reviewer: null, reworkRounds: 0 }
  const accessHandlers = new Set<(msg: ServerMsg) => void>()
  const reviewHandlers = new Set<(msg: ServerMsg) => void>()
  const refusalHandlers = new Set<(msg: ServerMsg) => void>()
  const client = {
    subscribe: (kind: string, handler: (msg: ServerMsg) => void) => {
      if (kind === 'tasks_access') accessHandlers.add(handler)
      if (kind === 'task_review_settings') reviewHandlers.add(handler)
      if (kind === 'task_refused') refusalHandlers.add(handler)
      return () => {
        accessHandlers.delete(handler)
        reviewHandlers.delete(handler)
        refusalHandlers.delete(handler)
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
      if (refuseReview) {
        for (const handler of refusalHandlers) handler({ type: 'task_refused', kind: 'limit', limit: 5, requested: 6, expected: null, actual: null, message: 'Automatic rework rounds is limited to 5; requested 6.' })
      }
    },
    taskReviewSettingsSet: (workspace: string, reviewer: AgentKind | null, reworkRounds: number) => {
      if (refuseReview) {
        for (const handler of refusalHandlers) handler({ type: 'task_refused', kind: 'limit', limit: 5, requested: 6, expected: null, actual: null, message: 'Automatic rework rounds is limited to 5; requested 6.' })
        return
      }
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

export function TasksSettingsReviewRefusalStory(): React.JSX.Element {
  return <SettingsScreen section="tasks" props={{ daemonClient: tasksAccessClient('write', true), historyWorkspace: '/home/dev/code/houston', historyWorkspaceName: 'houston' }} />
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
  useFrozenStoryClock()
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
  return <div className="tasks-static" style={{ height: '100%', overflow: 'auto', background: 'var(--content-bg)' }}>{STATIC_MOTION}<OverviewTab parentId={ROSTER_PARENT.id} sessions={sessions} client={client} onClose={noop} onReview={noop} /></div>
}

export function TasksOverviewRosterStory(): React.JSX.Element {
  return <OverviewRosterStory />
}

function rosterClient({ empty = false, result = false }: { empty?: boolean; result?: boolean } = {}): HoustonClient {
  const handlers = new Map<string, Set<(msg: ServerMsg) => void>>()
  const emit = (msg: ServerMsg): void => {
    for (const handler of handlers.get(msg.type) ?? []) handler(msg)
  }
  const snapshot = (workspace: string): ServerMsg => ({
    type: 'task_snapshot',
    scope: workspace,
    tasks: empty ? [] : ROSTER_READY,
    counts: { ready: empty ? 0 : 2, backlog: 2, todo: 2, in_progress: 2, in_review: 2, done: 2, canceled: 0 }
  })
  const client = {
    subscribe: (kind: string, handler: (msg: ServerMsg) => void) => {
      const subscribers = handlers.get(kind) ?? new Set<(msg: ServerMsg) => void>()
      subscribers.add(handler)
      handlers.set(kind, subscribers)
      if (kind === 'task_snapshot') {
        queueMicrotask(() => {
          if (subscribers.has(handler)) handler(snapshot(ROSTER_WORKSPACE))
        })
      }
      return () => subscribers.delete(handler)
    },
    taskSnapshot: (workspace: string) => {
      emit(snapshot(workspace))
    },
    closeSession: noop,
    inboxDeliverNow: noop,
    taskQueueRun: (session: number, count: number) => {
      if (result) {
        window.setTimeout(() => emit({
          type: 'task_queue_result',
          workspace: '/home/dev/code/houston',
          started: ['HOU-113'],
          refused: [{ id: 114, key: 'HOU-114', message: 'No available child slot' }],
          ready_count: 1,
          free_children: 0
        }), 0)
      }
      void session
      void count
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

function RosterStory({ view, empty = false, result = false }: { view: 'children' | 'queue'; empty?: boolean; result?: boolean }): React.JSX.Element {
  useFrozenStoryClock()
  const client = React.useMemo(() => rosterClient({ empty, result }), [empty, result])
  return (
    <div className="tasks-static" style={{ display: 'flex', height: '100%', background: 'var(--card-bg)' }}>
      {STATIC_MOTION}
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

export function TasksQueueEmptyStory(): React.JSX.Element {
  return <RosterStory view="queue" empty />
}

export function TasksQueueResultStory(): React.JSX.Element {
  React.useEffect(() => clickAfterMount(['[data-testid="queue-run-next"]']), [])
  return <RosterStory view="queue" result />
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
  return <><style>{'.loop-anim{animation:none!important}'}</style><div style={{ height: '100%', padding: 12, display: 'flex' }}><SessionPane
    info={parent} client={client} roster={{ sessions: new Map([parent, ...children].map((pane) => [pane.id, pane])), maxLiveChildren: 8 }}
    gridSessionIds={new Set([parent.id])} theme="black" active connected fontSize={14} copyOnSelect={false} stripBoxGlyphs={false} showProject={false} shellIntegration={false}
    registerOutput={(id, sink) => { sinks.current.set(id, sink); return () => { sinks.current.delete(id) } }}
    onReconnectSsh={noop} onActivate={noop} onExpand={noop} onZoom={noop} onShellZoom={noop} onSplit={noop} onHeaderPointerDown={noop} onHandoff={noop} onOpenFile={noop} onOpenDir={noop}
  /></div></>
}


const STATE_REFUSAL = {
  id: null,
  kind: 'limit',
  message: 'Task limit reached: 500 tasks exist, 501 requested.',
  expected: null,
  actual: null,
  limit: 500,
  requested: 501
} as const

// StrictMode runs mount effects twice; the cleanup cancels the first timer so
// each selector is clicked once.
function clickAfterMount(selectors: string[], delay = 60): () => void {
  const timer = window.setTimeout(() => {
    for (const selector of selectors) document.querySelector<HTMLElement>(selector)?.click()
  }, delay)
  return () => window.clearTimeout(timer)
}

function PanelRow({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 12, height: '100%', background: 'var(--rail-bg)', paddingTop: 8 }}>
      {React.Children.map(children, (child) => <SidePanelFrame>{child}</SidePanelFrame>)}
    </div>
  )
}

export function TasksListStatesStory(): React.JSX.Element {
  const session = SESSIONS.get(431)!
  return (
    <PanelRow>
      <TasksList
        scope="all"
        showWorkspace
        tasks={TASKS}
        selectedId={43}
        now={NOW}
        access="write"
        refusal={STATE_REFUSAL}
        nowCard={
          <TaskNowCard session={session} summary={TASKS[0]} detail={DETAIL} onOpenSession={noop} onStop={noop} />
        }
        onOpen={noop}
        onNew={noop}
        onAccess={noop}
      />
      <TasksList
        tasks={[]}
        selectedId={null}
        now={NOW}
        access="off"
        refusal={{ ...STATE_REFUSAL, kind: 'access_off', message: 'Tasks are off for this workspace.' }}
        onOpen={noop}
        onNew={noop}
        onAccess={noop}
      />
    </PanelRow>
  )
}

export function TasksComposerStory(): React.JSX.Element {
  React.useEffect(() => clickAfterMount(['[data-testid="task-composer-add-item"]', '[data-testid="task-composer-add-item"]']), [])
  return (
    <PanelShell>
      <TaskComposer
        initialTitle="Refuse unsafe worktree slugs"
        initialDescription="The error names the slug, the limit and the actual length."
        parentOptions={[{ value: '46', label: 'HOU-46 — A renamed pane keeps its name across respawn' }]}
        onCancel={noop}
        onCreate={noop}
      />
    </PanelShell>
  )
}

const REVIEW_RUN = {
  ...RUN_41,
  id: 9,
  kind: 'review',
  state: 'failed',
  provider: 'codex',
  session_id: null,
  reason: null,
  summary: 'The slug validator accepts a trailing newline.\nAdd a regression test.',
  ended_at_ms: NOW - 4 * MINUTE
} as const

const IMPL_RUN = {
  ...RUN_41,
  state: 'needs_review',
  reason: 'Waiting for the reviewer verdict before handing back.',
  ended_at_ms: NOW - 5 * MINUTE
} as const

export function TasksDetailStatesStory(): React.JSX.Element {
  const common = {
    access: 'write' as const,
    now: NOW,
    parentOptions: [{ value: '46', label: 'HOU-46 — A renamed pane keeps its name across respawn' }],
    workspaceOptions: [{ value: '/home/dev/code/houston', label: 'houston' }],
    sessions: SESSIONS,
    startSettings: { agent: 'claude', delivery: 'send' } as const,
    onBack: noop,
    onReload: noop,
    onSave: noop,
    onCheck: noop,
    onComment: noop,
    onArchive: noop,
    onStart: noop,
    onRunControl: noop,
    onOpenSession: noop,
    onReview: noop
  }
  const conflict = {
    id: 41,
    kind: 'conflict',
    message: 'Revision 9 expected, 10 found.',
    expected: 9,
    actual: 10,
    limit: null,
    requested: null
  } as const
  return (
    <PanelRow>
      <TaskDetail
        {...common}
        refusal={conflict}
        detail={{ ...DETAIL, runs: [REVIEW_RUN, IMPL_RUN], comments: [], history: [] }}
      />
      <TaskDetail
        {...common}
        refusal={{ ...conflict, kind: 'limit', message: 'Description limit: 20000 bytes, 20001 requested.' }}
        detail={{
          ...DETAIL,
          task: { ...DETAIL.task, status: 'todo', workspace: null, archived_at_ms: NOW - MINUTE },
          acceptance: [],
          runs: [],
          comments: [],
          history: []
        }}
      />
    </PanelRow>
  )
}

export function TasksChipsStory(): React.JSX.Element {
  const task = SESSIONS.get(431)!.task!
  return (
    <div style={{ display: 'grid', gap: 16, padding: 24, background: 'var(--card-bg)', width: 520 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}><TaskChip task={task} /></div>
      <RosterColumn style={{ gap: 12, alignItems: 'center' }}><TaskChip task={task} compact /></RosterColumn>
    </div>
  )
}
