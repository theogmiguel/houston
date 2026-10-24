// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from './client'
import { INBOX_LIST_IN_FLIGHT_LIMIT } from './inboxListRequests'
import { GIT_STATUS_IN_FLIGHT_LIMIT } from '../components/git/gitStatusPoller'
import { OverviewTab } from '../components/OverviewTab'
import { TasksSurface } from '../components/nav/TasksSurface'
import { useOperatorInbox } from '../nextRequest'

// The hook keeps one snapshot between renders; a new one per call would re-run every effect.
const tasks = vi.hoisted(() => ({ snapshot: { scope: 'all', tasks: [], counts: {} }, detail: null, watched: null, access: 'off', refusal: null, watchTask: () => {}, openTask: () => {}, saveTask: () => {}, createTask: () => {}, setAccess: () => {}, startTask: () => {} }))
vi.mock('./useTasks', () => ({
  useTasks: () => tasks,
  useTaskStartSettings: () => ({ settings: { agent: 'claude', delivery: 'send' } })
}))

const CONTROL_HANDLERS_PER_CONNECTION = 16

type Handler = (message: never) => void

// One `/ws` connection: inbox_list and git_status hold a daemon control handler until
// their reply. Every other request is answered at once or not modelled.
class FakeConnection {
  readonly handlers = new Map<string, Set<Handler>>()
  readonly pending: { type: 'inbox_list' | 'git_status'; key: string }[] = []
  readonly listed = new Set<string>()
  peak = 0

  subscribe(type: string, handler: Handler): () => void {
    const set = this.handlers.get(type) ?? new Set()
    set.add(handler)
    this.handlers.set(type, set)
    return () => set.delete(handler)
  }
  inboxList(workspace: string): void { this.hold('inbox_list', workspace) }
  gitStatus(dir: string): void { this.hold('git_status', dir) }
  replyAll(): void {
    for (let replies = 0; this.pending.length > 0; replies += 1) {
      if (replies > 1000) throw new Error(`replies never settle: ${this.pending.length} still pending`)
      const { type, key } = this.pending.shift()!
      if (type === 'inbox_list') this.listed.add(key)
      act(() => this.emit(type === 'inbox_list' ? 'inbox_rows' : 'git_status', type === 'inbox_list'
        ? { type: 'inbox_rows', workspace: key, rows: [] }
        : { type: 'git_status', dir: key, base: null, files: [], ahead: 0, behind: 0 }))
    }
  }
  private hold(type: 'inbox_list' | 'git_status', key: string): void {
    this.pending.push({ type, key })
    this.peak = Math.max(this.peak, this.pending.length)
  }
  private emit(type: string, message: unknown): void {
    for (const handler of [...(this.handlers.get(type) ?? [])]) handler(message as never)
  }
}

// Every client method a surface calls besides the modelled ones is a no-op.
function clientOf(connection: FakeConnection): HoustonClient {
  return new Proxy(connection, {
    get: (target, name) => name in target ? Reflect.get(target, name).bind(target) : () => undefined
  }) as unknown as HoustonClient
}

const session = (id: number, parent: number | null, dir: string): SessionInfo => ({
  id, spawned_by: parent, project_dir: '/repo', cwd: dir, title_source: 'prompt', codename: `code-${id}`, title: `task ${id}`,
  agent: 'claude', state: 'running', status: 'working', children_waiting: 0, live_children: 0, tags: [], hidden: false,
  inbox_unread: 0, resumable: true, worktree: parent === null ? null : { path: dir, branch: `wt-${id}` },
  delegation: parent === null ? null : { parent, started_at: 1000, settled_at: null, state: 'working', stalled: false, result_staged: false, superseded: 0, turn_end_source: 'unknown', inbox_owed: 0, inbox_provisional: 0, reusable: true }
} as SessionInfo)

function Surfaces({ client, workspaces, sessions }: { client: HoustonClient; workspaces: { path: string; name: string }[]; sessions: Map<number, SessionInfo> }): React.JSX.Element {
  useOperatorInbox(client, workspaces.map((workspace) => workspace.path))
  // App passes a new workspace array on every render, as here.
  return <>
    <TasksSurface client={client} workspace="" workspaces={workspaces.map((workspace) => ({ ...workspace }))} sessions={sessions} now={1}
      onStartRequested={vi.fn()} onOpenSession={vi.fn()} onReview={vi.fn()} onOpenExternal={vi.fn()} />
    <OverviewTab parentId={1} sessions={sessions} client={client} onClose={vi.fn()} onReview={vi.fn()} />
  </>
}

describe('per-workspace refresh burst', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { cleanup(); vi.useRealTimers() })

  test('a pane-list change over many workspaces stays within the control handler limit', () => {
    const connection = new FakeConnection()
    const client = clientOf(connection)
    const workspaces = Array.from({ length: 10 }, (_, i) => ({ path: `/ws-${i}`, name: `ws-${i}` }))
    const parent = session(1, null, '/repo')
    const view = render(<Surfaces client={client} workspaces={workspaces} sessions={new Map([[1, parent]])} />)
    connection.replyAll()
    const mountPeak = connection.peak
    connection.peak = 0

    // Four children spawn into their own worktrees in one roster change.
    const sessions = new Map([[1, parent], ...[2, 3, 4, 5].map((id) => [id, session(id, 1, `/repo/.wt/${id}`)] as const)])
    view.rerender(<Surfaces client={client} workspaces={workspaces} sessions={sessions} />)
    connection.replyAll()

    const bound = INBOX_LIST_IN_FLIGHT_LIMIT + GIT_STATUS_IN_FLIGHT_LIMIT
    expect(bound).toBeLessThan(CONTROL_HANDLERS_PER_CONNECTION)
    expect(connection.peak, 'requests in flight after the pane-list change').toBeLessThanOrEqual(bound)
    expect(mountPeak, 'requests in flight after mount').toBeLessThanOrEqual(bound)
    // Bounding drops nothing: every workspace and worktree was listed.
    expect([...connection.listed].sort()).toEqual([...workspaces.map((w) => w.path), '/repo', '/repo/.wt/2', '/repo/.wt/3', '/repo/.wt/4', '/repo/.wt/5'].sort())
  })
})
