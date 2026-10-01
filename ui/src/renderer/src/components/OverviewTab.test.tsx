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
  it('counts resumed live unknown children as working and offers Stop instead of Continue', () => {
    const child = session(2, 1)
    child.delegation!.state = 'unknown'
    const client = { subscribe: () => () => {}, delegationResultsList: vi.fn(), inboxList: vi.fn(), gitStatus: vi.fn(), closeSession: vi.fn() } as unknown as HoustonClient
    render(<OverviewTab parentId={1} sessions={new Map([[1, session(1, null)], [2, child]])} client={client} onClose={vi.fn()} onReview={vi.fn()} />)
    expect(screen.getByText('children · 0 needs you · 1 working · 0 done · 0 failed')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(client.closeSession).toHaveBeenCalledWith(2)
  })
  it('shows protocol ages, targets review and resumes a settled child without fresh', () => {
    const sessions = new Map([[1, session(1, null)], [2, session(2, 1, true)]])
    const respawnSession = vi.fn()
    const onReview = vi.fn()
    const client = { subscribe: () => () => {}, delegationResultsList: vi.fn(), inboxList: vi.fn(), gitStatus: vi.fn(), respawnSession } as unknown as HoustonClient
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
    const client = { subscribe: (type: string, callback: (message: unknown) => void) => { handlers.set(type, callback); return () => handlers.delete(type) }, delegationResultsList: vi.fn(), inboxList: vi.fn(), gitStatus: vi.fn(), inboxAck, inboxResolve } as unknown as HoustonClient
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

describe('overview checkout metadata and durable results', () => {
  it('groups live siblings by checkout root, excludes ended siblings and reads worktree counts', () => {
    const handlers = new Map<string, (message: any) => void>()
    const child = { ...session(2, 1), project_dir: '/work/tree/src', checkout_root: '/work/tree', worktree: { path: '/work/tree', branch: 'fix/validator', repo_common_dir: '/work/.git' } }
    const sibling = { ...session(3, 1), project_dir: '/work/tree/tests', checkout_root: '/work/tree', delegation: { ...session(3, 1).delegation!, role: 'tests' } }
    const ended = { ...session(4, 1, true), checkout_root: '/work/tree', delegation: { ...session(4, 1, true).delegation!, role: 'ended' } }
    const client = { subscribe: (type: string, callback: (message: any) => void) => { handlers.set(type, callback); return () => handlers.delete(type) }, delegationResultsList: vi.fn(), inboxList: vi.fn(), gitStatus: vi.fn() } as unknown as HoustonClient
    render(<OverviewTab parentId={1} sessions={new Map([[1, session(1, null)], [2, child], [3, sibling], [4, ended]])} client={client} onClose={vi.fn()} onReview={vi.fn()} />)
    expect(screen.getByText('fix/validator')).toBeTruthy()
    expect(screen.getAllByText('shares checkout with tests')).toHaveLength(1)
    expect(screen.queryByText('shares checkout with ended')).toBeNull()
    expect(client.gitStatus).toHaveBeenCalledWith('/work/tree', null)
    act(() => handlers.get('git_status')!({ dir: '/work/tree', base: null, files: [{ path: 'one' }, { path: 'two' }] }))
    expect(screen.getByText('2 changed files')).toBeTruthy()
  })

  it('retrieves the parent result snapshot on reopen and refreshes when inbox results change', () => {
    const handlers = new Map<string, (message: any) => void>()
    const client = { subscribe: (type: string, callback: (message: any) => void) => { handlers.set(type, callback); return () => handlers.delete(type) }, delegationResultsList: vi.fn(), inboxList: vi.fn(), gitStatus: vi.fn() } as unknown as HoustonClient
    const props = { parentId: 1, sessions: new Map([[1, session(1, null)], [2, session(2, 1, true)]]), client, onClose: vi.fn(), onReview: vi.fn() }
    const first = render(<OverviewTab {...props} />)
    expect(client.delegationResultsList).toHaveBeenCalledWith(1)
    const result = { child: 2, role: 'validator', summary: 'Complete', excerpt: 'Validated the recorded checkout', created_at: 2, delivered_via: 'parent' }
    act(() => handlers.get('delegation_results')!({ parent: 9, results: [result] }))
    expect(screen.queryByText(result.excerpt)).toBeNull()
    act(() => handlers.get('delegation_results')!({ parent: 1, results: [result] }))
    expect(screen.getByText(result.excerpt)).toBeTruthy()
    act(() => handlers.get('inbox_changed')!({ workspace: '/work', row: { id: 9, kind: 'result' } }))
    expect(client.delegationResultsList).toHaveBeenCalledTimes(2)
    first.unmount()
    render(<OverviewTab {...props} />)
    expect(client.delegationResultsList).toHaveBeenCalledTimes(3)
    act(() => handlers.get('delegation_results')!({ parent: 1, results: [result] }))
    expect(screen.getByText(result.excerpt)).toBeTruthy()
  })
})

it('emphasizes the child count when attention is needed and groups using a segmented track', () => {
  const child = session(2, 1)
  child.status = 'needs-input'
  const client = { subscribe: () => () => {}, delegationResultsList: vi.fn(), inboxList: vi.fn(), gitStatus: vi.fn() } as unknown as HoustonClient
  render(<OverviewTab parentId={1} sessions={new Map([[1, session(1, null)], [2, child]])} client={client} onClose={vi.fn()} onReview={vi.fn()} />)
  expect(screen.getByText('1').className).toContain('text-[var(--warn)]')
  expect(screen.getByRole('radiogroup', { name: 'Group children' })).toBeTruthy()
  fireEvent.click(screen.getByRole('radio', { name: 'Worktree' }))
  expect(screen.getByRole('radio', { name: 'Worktree' }).getAttribute('aria-checked')).toBe('true')
})
