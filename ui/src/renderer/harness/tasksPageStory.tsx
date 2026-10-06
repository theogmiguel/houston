import React from 'react'
import type { HoustonClient, SessionInfo } from '../src/houston/client'
import type { ServerMsg } from '../src/houston/generated/ServerMsg'
import type { TaskRun } from '../src/houston/generated/TaskRun'
import type { TaskSummary } from '../src/houston/generated/TaskSummary'
import type { TaskDetailData } from '../src/houston/useTasks'
import { TasksSurface } from '../src/components/nav/TasksSurface'
import '../src/components/tasks/tasks.css'
import '../src/components/sidePanel.css'

const NOW = 1_700_000_000_000
const WORKSPACE = '/home/dev/code/houston'
const MINUTE = 60_000

function task(id: number, title: string, status: TaskSummary['status'], extra: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id, workspace: WORKSPACE, number: id, key: `HOU-${id}`, title, status,
    priority: 'medium', parent_id: null, ref_url: null, revision: 1, created_by: 'user',
    created_at_ms: NOW - 60 * MINUTE, updated_at_ms: NOW - 6 * MINUTE,
    archived_at_ms: null, acceptance_checked: 0, acceptance_total: 0, ...extra
  }
}

const TASKS: TaskSummary[] = [
  task(45, 'Rename Harness review to Harness', 'in_progress', { open_run: { id: 45, task_id: 45, attempt: 1, kind: 'implementation', state: 'waiting_for_input', provider: 'claude', session_id: 445, initial_revision: 1, started_at_ms: NOW - 8 * MINUTE } }),
  task(39, 'Pane header shows the branch', 'in_review', { ref_url: 'https://github.com/theogmiguel/houston/pull/61' }),
  task(50, 'Usage page in the rail', 'in_progress', { open_run: { id: 50, task_id: 50, attempt: 1, kind: 'implementation', state: 'running', provider: 'codex', session_id: 450, initial_revision: 1, started_at_ms: NOW - 6 * MINUTE } }),
  task(42, 'Block bun test in agent settings', 'in_progress', { acceptance_checked: 1, acceptance_total: 2, updated_at_ms: NOW - 14 * MINUTE }),
  task(47, 'Agents re-read the styleguide on every UI change', 'backlog', { origin: { kind: 'harness_finding', workspace: WORKSPACE, key: 'bun-test', review_id: 7 } }),
  task(40, 'pane_prompt retries after a daemon restart', 'done'),
  task(38, 'Old task', 'todo', { archived_at_ms: NOW - MINUTE })
]

const RUN: TaskRun = {
  id: 42, task_id: 42, attempt: 1, kind: 'implementation', state: 'cancelled', provider: 'claude',
  session_id: 442, worktree_path: `${WORKSPACE}/.houston/worktrees/hou-42-block-bun-test`,
  branch: 'houston/task/hou-42-block-bun-test', initial_revision: 1, started_at_ms: NOW - 14 * MINUTE
}

const DETAIL: TaskDetailData = {
  task: {
    id: 42, workspace: WORKSPACE, number: 42, key: 'HOU-42', title: 'Block bun test in agent settings',
    description: 'Use bun run test for the renderer suite.', status: 'in_progress', priority: 'medium', parent_id: null,
    ref_url: null, revision: 1, created_by: 'user', origin: { kind: 'harness_finding', workspace: WORKSPACE, key: 'bun-test', review_id: 7 }, created_at_ms: NOW - 60 * MINUTE,
    updated_at_ms: NOW - 14 * MINUTE, archived_at_ms: null, links: [], blocked_by: []
  },
  acceptance: [
    { id: 1, position: 0, text: 'bun test is denied in .claude/settings.json', checked_at_ms: NOW - 30 * MINUTE, checked_by: 'user' },
    { id: 2, position: 1, text: 'AGENTS.md points to bun run test', checked_at_ms: null, checked_by: null }
  ], comments: [], history: [], runs: [RUN]
}

const SESSIONS: ReadonlyMap<number, SessionInfo> = new Map([[442, {
  id: 442, agent: 'claude', project_dir: RUN.worktree_path!, cwd: RUN.worktree_path!, state: 'exited',
  title: 'HOU-42 Block bun test in agent settings', codename: 'tests', hidden: false,
  live_children: 0, children_waiting: 0, inbox_unread: 0, tags: [], resumable: true
}]])

function fixtureClient(): HoustonClient {
  const handlers = new Map<string, Set<(msg: ServerMsg) => void>>()
  const emit = (kind: string, message: ServerMsg): void => handlers.get(kind)?.forEach((handler) => handler(message))
  const client = {
    subscribe: (kind: string, handler: (msg: ServerMsg) => void) => {
      const set = handlers.get(kind) ?? new Set()
      set.add(handler)
      handlers.set(kind, set)
      return () => set.delete(handler)
    },
    taskSnapshot: (scope: string) => emit('task_snapshot', { type: 'task_snapshot', scope, tasks: TASKS, counts: { ready: 2, backlog: 1, todo: 1, in_progress: 3, in_review: 1, done: 1, canceled: 0 } }),
    taskGet: (id: number) => emit('task_detail', { type: 'task_detail', ...DETAIL, task: { ...DETAIL.task, id, number: id, key: `HOU-${id}` } }),
    tasksAccessGet: (workspace: string) => emit('tasks_access', { type: 'tasks_access', workspace, access: 'write' }),
    taskStartSettingsGet: (workspace: string) => emit('task_start_settings', { type: 'task_start_settings', workspace, agent: 'claude', delivery: 'send' }),
    inboxList: (workspace: string) => emit('inbox_rows', { type: 'inbox_rows', workspace, rows: [{
      id: 1n, to_session: 0, original_to: 0, workspace, from_session: 445, kind: 'needs_input', urgent: true,
      summary: 'tests is blocked', body: 'this child needs input: Keep the old name in the palette as an alias? Inspect it (`pane_read`) and answer it (`pane_send_keys`), or escalate — it will sit there until somebody does.',
      artifacts: [], superseded: 0, provisional: false, created_at: BigInt(NOW - 2 * MINUTE), resolved_at: null, attempts: 0
    }] })
  }
  return new Proxy(client, { get(target, prop, receiver) {
    if (prop in target) return Reflect.get(target, prop, receiver)
    if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined
    return () => undefined
  } }) as unknown as HoustonClient
}

export function TasksPageStory(): React.JSX.Element {
  const client = React.useMemo(fixtureClient, [])
  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--content-bg)' }}>
      <aside style={{ width: 148, flex: 'none', padding: 8, background: 'var(--rail-bg)', color: 'var(--text-secondary)' }}>
        <div style={{ padding: 8, color: 'var(--text-faint)', fontSize: 11 }}>HOUSTON</div>
        <div style={{ display: 'grid', gap: 2, marginBottom: 8 }}>
          {['auth-refactor', 'migrate-db', 'shell'].map((item) => <div key={item} style={{ padding: '5px 8px', fontSize: 12 }}>{item}</div>)}
        </div>
        <div style={{ height: 1, background: 'var(--divider)', margin: '0 8px 8px' }} />
        <div style={{ display: 'grid', gap: 2 }}>
          {([['Tasks', 2], ['Routines', null], ['Skills', null], ['Harness', 1], ['Connections', null], ['Usage', null]] as const).map(([label, count]) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderRadius: 6, background: label === 'Tasks' ? 'var(--hover-fill)' : 'transparent' }}>
              {label}{count !== null && <span style={{ color: 'var(--accent)' }}>{count}</span>}
            </div>
          ))}
        </div>
      </aside>
      <div style={{ flex: 1, minWidth: 0 }}>
        <TasksSurface
          client={client} workspace={WORKSPACE} workspaces={[{ path: WORKSPACE, name: 'houston' }]}
          sessions={SESSIONS} now={NOW} onStartRequested={() => {}} onOpenSession={() => {}}
          onReview={() => {}} onOpenExternal={() => {}}
        />
      </div>
    </div>
  )
}
