import React from 'react'
import type { HoustonClient } from '../src/houston/client'
import type { ServerMsg } from '../src/houston/generated/ServerMsg'
import type { TaskAcceptanceItem } from '../src/houston/generated/TaskAcceptanceItem'
import type { TaskHistoryEntry } from '../src/houston/generated/TaskHistoryEntry'
import type { TaskSummary } from '../src/houston/generated/TaskSummary'
import type { TasksAccess } from '../src/houston/generated/TasksAccess'
import type { TaskDetailData } from '../src/houston/useTasks'
import { TaskDetail } from '../src/components/tasks/TaskDetail'
import { TasksList } from '../src/components/tasks/TasksList'
import { SettingsView } from '../src/components/SettingsView'
import { baseSettingsViewProps } from '../src/components/settingsViewTestFixtures'
import { setSettingsNavForTests } from '../src/settingsNav'
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

const TASKS: TaskSummary[] = [
  summary(41, 'pane_spawn refuses unsafe worktree slugs', 'in_progress', 'high', 2 * MINUTE),
  summary(42, 'Measure cleanup pass cost per worktree', 'in_progress', 'medium', 3 * MINUTE),
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
    archived_at_ms: null
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
      actor: 'user',
      action: 'update',
      changes: '{"status":{"from":"todo","to":"in_progress"}}',
      created_at_ms: NOW - 8 * MINUTE
    },
    {
      id: 3,
      actor: 'user',
      action: 'check',
      changes: '{"item":1,"text":"Control characters are rejected"}',
      created_at_ms: NOW - 6 * MINUTE
    },
    {
      id: 4,
      actor: 'user',
      action: 'check',
      changes: '{"item":2,"text":"Error names slug, limit 48 and actual length"}',
      created_at_ms: NOW - 5 * MINUTE
    }
  ] as TaskHistoryEntry[],
  runs: []
}

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
        workspaceName="houston"
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
        onBack={noop}
        onReload={noop}
        onSave={noop}
        onCheck={noop}
        onComment={noop}
        onArchive={noop}
      />
    </PanelShell>
  )
}

function tasksAccessClient(initial: TasksAccess): HoustonClient {
  let access = initial
  const handlers = new Set<(msg: ServerMsg) => void>()
  const client = {
    subscribe: (kind: string, handler: (msg: ServerMsg) => void) => {
      if (kind === 'tasks_access') handlers.add(handler)
      return () => handlers.delete(handler)
    },
    tasksAccessGet: (workspace: string) => {
      for (const handler of handlers) handler({ type: 'tasks_access', workspace, access })
    },
    tasksAccessSet: (workspace: string, next: TasksAccess) => {
      access = next
      for (const handler of handlers) handler({ type: 'tasks_access', workspace, access })
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
  setSettingsNavForTests({ open: true, section: 'tasks' })
  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--content-bg)' }}>
      <SettingsView
        {...baseSettingsViewProps()}
        daemonClient={tasksAccessClient('write')}
        historyWorkspace="/home/dev/code/houston"
        historyWorkspaceName="houston"
      />
    </div>
  )
}
