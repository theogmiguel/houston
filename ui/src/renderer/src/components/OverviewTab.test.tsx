// @vitest-environment jsdom
import { fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import type { HoustonClient, SessionInfo } from '../houston/client'
import type { InboxRow } from '../houston/generated/InboxRow'
import { OverviewTab } from './OverviewTab'
const session = (id: number, parent: number | null, ended = false): SessionInfo => ({ id, spawned_by: parent, project_dir: '/work', cwd: '/work', codename: `code-${id}`, title: `task ${id}`, agent: 'claude', state: ended ? 'exited' : 'running', status: 'working', children_waiting: 0, live_children: 0, tags: [], hidden: false, inbox_unread: 0, resumable: true, delegation: parent == null ? null : { parent, started_at: 1000, settled_at: ended ? 61000 : null, state: ended ? 'done' : 'working', stalled: false, result_staged: false, superseded: 0, turn_end_source: 'unknown', inbox_owed: 0, inbox_provisional: 0, reusable: true } } as SessionInfo)
afterEach(cleanup)
describe('orchestrator overview', () => {
  it('shows protocol ages, targets review and resumes a settled child without fresh', () => {
    const sessions = new Map([[1, session(1, null)], [2, session(2, 1, true)]])
    const respawnSession = vi.fn()
    const onReview = vi.fn()
    const client = { subscribe: () => () => {}, inboxList: vi.fn(), gitStatus: vi.fn(), respawnSession } as unknown as HoustonClient
    render(<OverviewTab parentId={1} sessions={sessions} client={client} onClose={vi.fn()} onReview={onReview} />)
    expect(screen.getByText('1m')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(onReview).toHaveBeenCalledWith(sessions.get(2))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(respawnSession).toHaveBeenCalledWith(2, undefined, null, undefined, undefined, false)
  })
  it('updates the operator queue and sends acknowledge and resolve receipts', () => {
    const handlers = new Map<string, (message: unknown) => void>()
    const inboxAck = vi.fn(), inboxResolve = vi.fn()
    const client = { subscribe: (type: string, callback: (message: unknown) => void) => { handlers.set(type, callback); return () => handlers.delete(type) }, inboxList: vi.fn(), gitStatus: vi.fn(), inboxAck, inboxResolve } as unknown as HoustonClient
    render(<OverviewTab parentId={1} sessions={new Map([[1, session(1, null)], [2, session(2, 1)]])} client={client} onClose={vi.fn()} onReview={vi.fn()} />)
    const row = { id: 9n, to_session: 0, original_to: 1, from_session: 2, workspace: '/work', kind: 'result', urgent: false, superseded: 0, provisional: false, attempts: 0, summary: 'Please review', body: 'result', artifacts: [], created_at: 2000n, resolved_at: null } as InboxRow
    act(() => handlers.get('inbox_changed')!({ workspace: '/work', row }))
    expect(screen.getByRole('region', { name: 'Addressed to you' })).toBeTruthy()
    fireEvent.click(screen.getByText('Acknowledge')); expect(inboxAck).toHaveBeenCalledWith(9n)
    fireEvent.click(screen.getByText('Resolve')); expect(inboxResolve).toHaveBeenCalledWith(9n)
    act(() => handlers.get('inbox_changed')!({ workspace: '/work', row: { ...row, resolved_at: 3000 } }))
    expect(screen.queryByRole('region', { name: 'Addressed to you' })).toBeNull()
  })
})
