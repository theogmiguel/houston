// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MergeQueueEntry, MergeQueueMerge } from '../../houston/client'
import { MergeQueueView } from './MergeQueueView'
import { PullRequestsScreen } from './PullRequestsScreen'
import type { MergeQueueController } from './useMergeQueue'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const NOW = new Date(2026, 9, 17, 12, 0).getTime()

function entry(number: number, o: Partial<MergeQueueEntry> = {}): MergeQueueEntry {
  return {
    number,
    repository: 'acme/repo',
    url: `https://github.com/acme/repo/pull/${number}`,
    title: `Change ${number}`,
    head_ref: `houston/change-${number}`,
    head_sha: SHA,
    base_ref: 'main',
    depends_on: null,
    session: null,
    position: 1,
    enqueued_at_ms: 1,
    read_at_ms: 2,
    status: 'ready',
    reason: null,
    gates: [
      { kind: 'mergeable', state: 'passed', reason: null },
      { kind: 'review_threads', state: 'passed', reason: null },
      { kind: 'reviewer', state: 'not_applicable', reason: null }
    ],
    ...o
  }
}

function merge(number: number, at: number): MergeQueueMerge {
  return { number, repository: 'acme/repo', url: `https://github.com/acme/repo/pull/${number}`, title: `Merged ${number}`, head_sha: SHA, base_ref: 'main', method: 'squash', merged_at_ms: at }
}

function controller(o: Partial<MergeQueueController> = {}): MergeQueueController {
  return {
    workspace: '/repo',
    entries: [],
    merged: [],
    loaded: true,
    unavailable: null,
    busy: null,
    reply: null,
    enqueue: vi.fn(),
    dequeue: vi.fn(),
    mergeHead: vi.fn(),
    clearReply: vi.fn(),
    ...o
  }
}

afterEach(() => { cleanup(); localStorage.clear() })

describe('MergeQueueView', () => {
  const blocked = entry(13, {
    position: 2,
    status: 'blocked',
    reason: 'PR #13 has 1 unresolved review thread',
    gates: [
      { kind: 'mergeable', state: 'passed', reason: null },
      { kind: 'review_threads', state: 'failed', reason: 'PR #13 has 1 unresolved review thread' },
      { kind: 'reviewer', state: 'failed', reason: 'HOU-7 has no reviewer verdict yet' }
    ]
  })

  it('lists the line with a rank, one status and one reason per row, then today’s merges', () => {
    const yesterday = NOW - 24 * 60 * 60 * 1000
    render(<MergeQueueView now={NOW} queue={controller({ entries: [entry(12), blocked], merged: [merge(11, NOW - 60_000), merge(10, yesterday)] })} />)
    const rows = screen.getAllByTestId('list-detail-row')
    expect(rows).toHaveLength(3)
    expect(rows[0].textContent).toContain('1#12Change 12')
    expect(rows[0].textContent).toContain('First in line, ready to merge')
    expect(rows[0].textContent).toContain('Ready')
    expect(rows[1].textContent).toContain('2#13')
    expect(rows[1].textContent).toContain('PR #13 has 1 unresolved review thread')
    expect(rows[1].textContent).toContain('Blocked')
    expect(rows[2].textContent).toContain('#11')
    expect(rows[2].textContent).toContain('Merged')
    const sections = screen.getAllByTestId('list-detail-section').map((s) => s.textContent)
    expect(sections).toEqual(['In line2', 'Today1'])
    expect(screen.queryByText(/Parked/)).toBeNull()
  })

  it('shows the gates as a checklist and gives only the head a primary Merge', () => {
    const queue = controller({ entries: [entry(12), blocked] })
    render(<MergeQueueView now={NOW} queue={queue} />)
    fireEvent.click(screen.getAllByTestId('list-detail-item')[0])
    const gates = screen.getByRole('list', { name: 'Gates' })
    expect(within(gates).getByLabelText('Mergeable: passed')).toBeTruthy()
    expect(within(gates).getByLabelText('Reviewer passed: does not apply')).toBeTruthy()
    fireEvent.click(screen.getByTestId('merge-queue-merge'))
    expect(queue.mergeHead).toHaveBeenCalledWith(12, SHA, 'squash')

    fireEvent.click(screen.getAllByTestId('list-detail-item')[1])
    expect(screen.queryByTestId('merge-queue-merge')).toBeNull()
    expect(within(screen.getByRole('list', { name: 'Gates' })).getByLabelText('No unresolved review threads: failed')).toBeTruthy()
    expect(screen.getByText('HOU-7 has no reviewer verdict yet')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Dequeue' }))
    expect(queue.dequeue).toHaveBeenCalledWith(13)
  })

  it('keeps a blocked head’s Merge disabled', () => {
    render(<MergeQueueView now={NOW} queue={controller({ entries: [entry(12, { status: 'blocked', reason: 'PR #12 is behind main' })] })} />)
    fireEvent.click(screen.getAllByTestId('list-detail-item')[0])
    expect((screen.getByTestId('merge-queue-merge') as HTMLButtonElement).disabled).toBe(true)
  })

  it('says why a workspace has no queue, and states an empty queue plainly', () => {
    const { unmount } = render(<MergeQueueView queue={controller({ unavailable: '/repo has no git remote, so it has no merge queue' })} />)
    expect(screen.getByTestId('merge-queue-unavailable').textContent).toContain('no git remote')
    unmount()
    render(<MergeQueueView queue={controller()} />)
    expect(screen.getByText('The merge queue is empty')).toBeTruthy()
  })

  it('shows a refused request until it is dismissed', () => {
    const queue = controller({ entries: [entry(12)], reply: { ok: false, number: 12, text: 'PR #12 head moved from a to b; refusing to merge an unseen commit' } })
    render(<MergeQueueView now={NOW} queue={queue} />)
    expect(screen.getByText(/head moved/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(queue.clearReply).toHaveBeenCalled()
  })
})

it('switches the Pull requests page between Requests and the merge queue, and remembers the choice', () => {
  const { unmount } = render(<PullRequestsScreen repoName="acme/repo" workspace="/repo" currentUser="theo" items={[]} />)
  expect(screen.getByRole('radio', { name: 'Requests' }).getAttribute('aria-checked')).toBe('true')
  fireEvent.click(screen.getByRole('radio', { name: 'Merge queue' }))
  expect(screen.getByTestId('merge-queue-view')).toBeTruthy()
  expect(screen.queryByRole('textbox', { name: 'Search pull requests' })).toBeNull()
  unmount()
  render(<PullRequestsScreen repoName="acme/repo" workspace="/repo" currentUser="theo" items={[]} />)
  expect(screen.getByTestId('merge-queue-view')).toBeTruthy()
})
