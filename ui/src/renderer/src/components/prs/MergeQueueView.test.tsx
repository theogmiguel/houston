// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MergeQueueEntry, MergeQueueLogEntry, MergeQueueSettings } from '../../houston/client'
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
      { kind: 'reviewer', state: 'not_applicable', reason: null },
      { kind: 'verification', state: 'not_applicable', reason: 'No verification command is set' }
    ],
    verification: null,
    failure: null,
    worktree: null,
    verifying_since_ms: null,
    ...o
  }
}

function logged(number: number, at: number, o: Partial<MergeQueueLogEntry> = {}): MergeQueueLogEntry {
  return { kind: 'merge', number, repository: 'acme/repo', url: `https://github.com/acme/repo/pull/${number}`, title: `Merged ${number}`, ref_name: 'main', old_sha: 'a'.repeat(40), new_sha: 'a91c2e'.padEnd(40, '0'), head_sha: SHA, method: 'squash', detail: null, unattended: true, at_ms: at, ...o }
}

const POLICY_ON: MergeQueueSettings = { merge_when_verified: true, verification_command: 'cargo nextest run', time_limit_minutes: 30, paused: false }

function controller(o: Partial<MergeQueueController> = {}): MergeQueueController {
  return {
    workspace: '/repo',
    entries: [],
    log: [],
    settings: { merge_when_verified: false, verification_command: '', time_limit_minutes: 30, paused: false },
    globalPaused: false,
    away: { merged: 0, parked: 0, last_merge_at_ms: null },
    loaded: true,
    unavailable: null,
    busy: null,
    reply: null,
    enqueue: vi.fn(),
    dequeue: vi.fn(),
    mergeHead: vi.fn(),
    retry: vi.fn(),
    revert: vi.fn(),
    setPaused: vi.fn(),
    setSettings: vi.fn(),
    acknowledge: vi.fn(),
    clearReply: vi.fn(),
    ...o
  }
}

const parked = entry(209, {
  position: 0,
  status: 'parked',
  head_ref: 'houston/settings-prefs',
  reason: 'Rebasing onto main@7f03d1 stopped on a conflict in 2 files',
  worktree: '/repo/.houston/worktrees/settings-prefs',
  failure: { kind: 'conflict', message: 'Rebasing onto main@7f03d1 stopped on a conflict in 2 files', files: ['src/settings/Preferences.tsx', 'src/lib/loadPreferences.ts'], output_tail: null, head_sha: SHA, base_sha: '7f03d1'.padEnd(40, '0'), handed_to: null, at_ms: 1 }
})

afterEach(() => { cleanup(); localStorage.clear() })

describe('MergeQueueView', () => {
  const blocked = entry(13, {
    position: 2,
    status: 'blocked',
    reason: 'PR #13 has 1 unresolved review thread',
    gates: [
      { kind: 'mergeable', state: 'passed', reason: null },
      { kind: 'review_threads', state: 'failed', reason: 'PR #13 has 1 unresolved review thread' },
      { kind: 'reviewer', state: 'failed', reason: 'HOU-7 has no reviewer verdict yet' },
      { kind: 'verification', state: 'pending', reason: 'Runs when it is first in line' }
    ]
  })

  it('lists the line with a rank, one status and one reason per row, the parked entries, then today’s merges and parks', () => {
    const yesterday = NOW - 24 * 60 * 60 * 1000
    const log = [logged(11, NOW - 60_000), logged(209, NOW - 120_000, { kind: 'park', detail: 'Rebase onto main@7f03d1 stopped on a conflict' }), logged(10, yesterday), logged(8, NOW - 30_000, { kind: 'push' })]
    render(<MergeQueueView now={NOW} queue={controller({ entries: [entry(12), blocked, parked], log })} />)
    const rows = screen.getAllByTestId('list-detail-row')
    expect(rows).toHaveLength(5)
    expect(rows[0].textContent).toContain('1#12Change 12')
    expect(rows[0].textContent).toContain('First in line, ready to merge')
    expect(rows[1].textContent).toContain('PR #13 has 1 unresolved review thread')
    expect(rows[2].textContent).toContain('#209')
    expect(rows[2].textContent).toContain('Parked')
    expect(rows[3].textContent).toContain('Merged into main@a91c2e0')
    expect(rows[4].textContent).toContain('Parked. Rebase onto main@7f03d1 stopped on a conflict')
    const sections = screen.getAllByTestId('list-detail-section').map((s) => s.textContent)
    expect(sections).toEqual(['In line2', 'Parked1', 'Today2'])
  })

  it('shows the gates as a checklist and gives only the head a primary Merge while the policy is off', () => {
    const queue = controller({ entries: [entry(12), blocked] })
    render(<MergeQueueView now={NOW} queue={queue} />)
    fireEvent.click(screen.getAllByTestId('list-detail-item')[0])
    const gates = screen.getByRole('list', { name: 'Gates' })
    expect(within(gates).getByLabelText('Mergeable: passed')).toBeTruthy()
    expect(within(gates).getByLabelText('Reviewer passed: does not apply')).toBeTruthy()
    expect(within(gates).getByLabelText('Verification: does not apply')).toBeTruthy()
    fireEvent.click(screen.getByTestId('merge-queue-merge'))
    expect(queue.mergeHead).toHaveBeenCalledWith(12, SHA, 'squash')

    fireEvent.click(screen.getAllByTestId('list-detail-item')[1])
    expect(screen.queryByTestId('merge-queue-merge')).toBeNull()
    expect(within(screen.getByRole('list', { name: 'Gates' })).getByLabelText('Verification: not run yet')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Dequeue' }))
    expect(queue.dequeue).toHaveBeenCalledWith(13)
  })

  it('with the policy on, names it with the command, gives the head no Merge, and counts the run against its limit', () => {
    const verifying = entry(212, { status: 'verifying', verifying_since_ms: NOW - 252_000 })
    render(<MergeQueueView now={NOW} queue={controller({ settings: POLICY_ON, entries: [verifying] })} />)
    expect(screen.getByTestId('merge-queue-policy').textContent).toContain('Merges when verified · cargo nextest run · one at a time on this machine')
    const row = screen.getAllByTestId('list-detail-row')[0]
    expect(row.textContent).toContain('houston/change-212 · rebased on main · 4m 12s of 30m')
    expect(row.textContent).toContain('Verifying')
    fireEvent.click(screen.getAllByTestId('list-detail-item')[0])
    expect(screen.queryByTestId('merge-queue-merge')).toBeNull()
  })

  it('pauses and resumes the queue from the policy line', () => {
    const queue = controller({ entries: [entry(12, { status: 'paused', reason: 'the merge queue of /repo is paused; resume it to push and merge' })] })
    const { unmount } = render(<MergeQueueView now={NOW} queue={queue} />)
    fireEvent.click(screen.getByTestId('merge-queue-pause'))
    expect(queue.setPaused).toHaveBeenCalledWith(true)
    expect(screen.getAllByTestId('list-detail-row')[0].textContent).toContain('Paused')
    unmount()
    const paused = controller({ settings: { ...POLICY_ON, paused: true } })
    render(<MergeQueueView now={NOW} queue={paused} />)
    expect(screen.getByTestId('merge-queue-policy').textContent).toContain('Paused: nothing is pushed or merged until you resume')
    fireEvent.click(screen.getByTestId('merge-queue-pause'))
    expect(paused.setPaused).toHaveBeenCalledWith(false)
  })

  it('details a parked entry with its reason and files, and offers Retry, Dequeue and a hand-off pane', () => {
    const queue = controller({ entries: [parked] })
    const onHandOff = vi.fn()
    render(<MergeQueueView now={NOW} queue={queue} onHandOff={onHandOff} />)
    fireEvent.click(screen.getAllByTestId('list-detail-item')[0])
    const failure = screen.getByTestId('merge-queue-failure')
    expect(failure.textContent).toContain('No pane owns it, so it is parked and the queue moved on')
    expect(within(failure).getByRole('list', { name: 'Conflicting files' }).textContent).toContain('src/lib/loadPreferences.ts')
    fireEvent.click(screen.getByTestId('merge-queue-retry'))
    expect(queue.retry).toHaveBeenCalledWith(209)
    fireEvent.click(screen.getByTestId('merge-queue-hand-off'))
    expect(onHandOff).toHaveBeenCalledWith('/repo/.houston/worktrees/settings-prefs', expect.stringContaining('- src/settings/Preferences.tsx'))
    expect(onHandOff.mock.calls[0][1]).toContain('Rebase houston/settings-prefs onto main')
  })

  it('shows a failed command’s output tail, never a count parsed from it', () => {
    const failed = entry(14, { position: 0, status: 'fixing', failure: { kind: 'failed', message: '`cargo test` failed (exit 101)', files: [], output_tail: 'test export::csv_rows ... FAILED', head_sha: SHA, base_sha: null, handed_to: 7, at_ms: 1 } })
    render(<MergeQueueView now={NOW} queue={controller({ entries: [failed] })} />)
    expect(screen.getAllByTestId('list-detail-row')[0].textContent).toContain('Fixing')
    fireEvent.click(screen.getAllByTestId('list-detail-item')[0])
    expect(screen.getByLabelText('Last lines of the output').textContent).toBe('test export::csv_rows ... FAILED')
    expect(screen.getByTestId('merge-queue-failure').textContent).toContain('Its pane was told; the queue moved on')
  })

  it('reverts a queue merge from today’s history', () => {
    const queue = controller({ log: [logged(211, NOW - 60_000)] })
    render(<MergeQueueView now={NOW} queue={queue} />)
    fireEvent.click(screen.getAllByTestId('list-detail-item')[0])
    fireEvent.click(screen.getByTestId('merge-queue-revert'))
    expect(queue.revert).toHaveBeenCalledWith(211)
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
