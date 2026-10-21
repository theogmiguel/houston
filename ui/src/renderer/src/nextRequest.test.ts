// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { InboxRow } from './houston/generated/InboxRow'
import type { SessionInfo } from './houston/client'
import { requestAfter, waitingRequests } from './nextRequest'
import { withInputOwner } from './test/inputFixtures'

function session(overrides: Partial<SessionInfo>): SessionInfo {
  return { id: 1, agent: 'claude', project_dir: '/w', cwd: '/w', state: 'running', title: 's', hidden: false, live_children: 0, children_waiting: 0, inbox_unread: 0, tags: [], ...overrides } as SessionInfo
}

function row(overrides: Partial<InboxRow>): InboxRow {
  return { id: 1n, to_session: 0, workspace: '/w', kind: 'result', urgent: false, summary: 's', body: 'b', artifacts: [], superseded: 0, provisional: false, created_at: 0n, attempts: 0, reason: 'parent_dead', ...overrides } as InboxRow
}

describe('waitingRequests', () => {
  it('lists only amber requests, oldest first', () => {
    const sessions = new Map([
      [1, session({ id: 1, status: 'needs-input', status_since_ms: 300 })],
      [2, session({ id: 2, status: 'needs-input', status_since_ms: 100, hidden: true })],
      [3, session({ id: 3, status: 'idle' })],
      [4, withInputOwner(session({ id: 4, spawned_by: 1, status_since_ms: 200 }), 'user')],
      [5, withInputOwner(session({ id: 5, spawned_by: 1, status_since_ms: 50 }), 'orchestrator')],
      [6, session({ id: 6, spawned_by: 1, status: 'working', delegation: { stalled: true } as SessionInfo['delegation'] })]
    ])
    const rows = [row({ id: 8n, created_at: 250n }), row({ id: 9n, created_at: 10n, resolved_at: 20 }), row({ id: 10n, to_session: 1, created_at: 5n })]
    expect(waitingRequests(sessions, rows).map((request) => request.key)).toEqual(['pane:4', 'inbox:8', 'pane:1'])
  })
})

describe('requestAfter', () => {
  const requests = waitingRequests(new Map([
    [1, session({ id: 1, status: 'needs-input', status_since_ms: 100 })],
    [2, session({ id: 2, status: 'needs-input', status_since_ms: 200 })],
    [3, session({ id: 3, status: 'needs-input', status_since_ms: 300 })]
  ]), [])

  it('starts with the oldest, steps forward and wraps', () => {
    expect(requestAfter(requests, null)?.key).toBe('pane:1')
    expect(requestAfter(requests, requests[1])?.key).toBe('pane:3')
    expect(requestAfter(requests, requests[2])?.key).toBe('pane:1')
    expect(requestAfter([], requests[0])).toBeNull()
  })

  it('continues after a request answered meanwhile', () => {
    const answered = requests[1]
    expect(requestAfter([requests[0], requests[2]], answered)?.key).toBe('pane:3')
  })
})
