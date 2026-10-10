// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientMsg } from '../../houston/client'
import type { ServerMsg } from '../../houston/generated/ServerMsg'
import type { Task } from '../../houston/generated/Task'
import type { TaskRun } from '../../houston/generated/TaskRun'
import type { TaskSummary } from '../../houston/generated/TaskSummary'
import { TaskDetail, type TaskDetailProps } from './TaskDetail'
import { TaskExecutionCard } from './TaskExecution'

const TASK: Task = {
  id: 7, workspace: '/work/app', number: 7, key: 'HOU-7', title: 'Task title', description: '', status: 'todo', priority: 'none',
  parent_id: null, ref_url: null, revision: 12, created_by: 'user', created_at_ms: 1, updated_at_ms: 2, archived_at_ms: null
}

const QUESTION: NonNullable<TaskSummary['open_question']> = {
  id: 31, task_id: 7, run_id: 3, session_id: 44, question: 'Which migration path?', options: ['Add a column', 'Create a table'],
  recommended: 2, why: 'The table is written on every request.', context: 'Schema version 12', created_at_ms: 5
}

const SUMMARY: TaskSummary = { ...TASK, acceptance_checked: 0, acceptance_total: 0, intake: null, open_run: null, open_question: null }

const RUN: TaskRun = {
  id: 3, task_id: 7, attempt: 1, kind: 'implementation', state: 'handed_back', provider: 'claude', session_id: null,
  branch: 'houston/task/hou-7', initial_revision: 1, started_at_ms: 1, ended_at_ms: 2, pr_url: null,
  pr_number: null, pushed_sha: null, evidence: null
}

function detailProps(overrides: Partial<TaskDetailProps> = {}): TaskDetailProps {
  return {
    detail: { task: TASK, acceptance: [], comments: [], history: [], runs: [] },
    access: 'off', refusal: null, now: 10, parentOptions: [], sessions: new Map(), startSettings: null,
    onReload: vi.fn(), onSave: vi.fn(), onCheck: vi.fn(), onComment: vi.fn(), onArchive: vi.fn(), onStart: vi.fn(),
    onRunControl: vi.fn(), onOpenSession: vi.fn(), onReview: vi.fn(),
    ...overrides
  }
}

function fakeClient(): { client: NonNullable<TaskDetailProps['client']>; sent: ClientMsg[] } {
  const listeners = new Set<(message: ServerMsg) => void>()
  const sent: ClientMsg[] = []
  return {
    sent,
    client: {
      subscribeAll: (listener: (message: ServerMsg) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
      taskSnapshot: () => {},
      taskSave: () => {},
      send: (message: ClientMsg) => sent.push(message)
    }
  }
}

describe('TaskDetail status controls', () => {
  afterEach(cleanup)

  it('marks an open task done at its current revision', () => {
    const onSave = vi.fn()
    render(<TaskDetail {...detailProps({ onSave })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }))
    expect(onSave).toHaveBeenCalledWith(7, 12, { status: 'done' })
    expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull()
  })

  it.each(['done', 'canceled'] as const)('reopens a %s task to todo and offers no cancel', (status) => {
    const onSave = vi.fn()
    render(<TaskDetail {...detailProps({ onSave, detail: { task: { ...TASK, status }, acceptance: [], comments: [], history: [], runs: [] } })} />)
    expect(screen.queryByRole('button', { name: 'Mark done' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    expect(onSave).toHaveBeenCalledWith(7, 12, { status: 'todo' })
    fireEvent.click(screen.getByTestId('task-detail-menu'))
    expect(screen.queryByRole('menuitem', { name: 'Cancel task' })).toBeNull()
  })

  it('cancels a task only after confirmation', () => {
    const onSave = vi.fn()
    render(<TaskDetail {...detailProps({ onSave })} />)
    fireEvent.click(screen.getByTestId('task-detail-menu'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel task' }))
    expect(screen.getByText('Cancel HOU-7?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('Cancel HOU-7?')).toBeNull()
    expect(onSave).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('task-detail-menu'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel task' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel task' }))
    expect(onSave).toHaveBeenCalledWith(7, 12, { status: 'canceled' })
    expect(screen.queryByText('Cancel HOU-7?')).toBeNull()
  })
})

describe('TaskDetail Slack intake and agent questions', () => {
  afterEach(cleanup)

  it.each([
    [{ source: 'slack', author: 'U1', state: 'pending', queue_position: null, permalink: null }, 'Slack · awaiting ✅'],
    [{ source: 'slack', author: 'U1', state: 'queued', queue_position: 3, permalink: null }, 'Slack · queued #3']
  ] as const)('shows the intake state %#', (intake, label) => {
    render(<TaskDetail {...detailProps({ summary: { ...SUMMARY, intake } })} />)
    expect(screen.getByTestId('task-intake-chip').textContent).toBe(label)
  })

  it('shows no intake chip once the task has a run', () => {
    const intake = { source: 'slack', author: 'U1', state: 'queued' as const, queue_position: 1, permalink: null }
    render(<TaskDetail {...detailProps({ summary: { ...SUMMARY, intake, open_run: RUN } })} />)
    expect(screen.queryByTestId('task-intake-chip')).toBeNull()
  })

  it('answers an open question with the chosen option text', () => {
    const { client, sent } = fakeClient()
    render(<TaskDetail {...detailProps({ client, summary: { ...SUMMARY, open_question: QUESTION } })} />)
    expect(screen.getByText('Which migration path?')).toBeTruthy()
    expect(screen.getByText('Why: The table is written on every request.')).toBeTruthy()
    expect(screen.getByText('Context: Schema version 12')).toBeTruthy()
    const options = screen.getAllByTestId('question-card-option')
    expect(options).toHaveLength(2)
    expect(options[0]!.textContent).toContain('Add a column')
    expect(options[1]!.textContent).toContain('Create a table · Recommended')
    expect(screen.queryByTestId('question-card-skip')).toBeNull()

    fireEvent.click(options[1]!)
    expect(sent.at(-1)).toEqual({ type: 'task_question_answer', question_id: 31, answer: 'Create a table' })
    expect(screen.getByText(/^Answer sent\./)).toBeTruthy()
    fireEvent.click(options[0]!)
    expect(sent.filter((message) => message.type === 'task_question_answer')).toHaveLength(1)
  })

  it('answers with a digit key but not while typing in a field', () => {
    const { client, sent } = fakeClient()
    render(<TaskDetail {...detailProps({ client, summary: { ...SUMMARY, open_question: QUESTION } })} />)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Leave a comment' }), { key: '1' })
    expect(sent.some((message) => message.type === 'task_question_answer')).toBe(false)
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '1' })) })
    expect(sent.at(-1)).toEqual({ type: 'task_question_answer', question_id: 31, answer: 'Add a column' })
  })

  it('opens the asking pane for a free-text answer', () => {
    // The card's own "Type it your own" row is live only while the card can answer, so this needs a client.
    const { client } = fakeClient()
    const onOpenSession = vi.fn()
    render(<TaskDetail {...detailProps({ client, onOpenSession, summary: { ...SUMMARY, open_question: QUESTION } })} />)
    fireEvent.click(screen.getByTestId('task-question-open-pane'))
    expect(onOpenSession).toHaveBeenLastCalledWith(44)
    fireEvent.click(screen.getByTestId('question-card-escape-hatch'))
    expect(onOpenSession).toHaveBeenCalledTimes(2)
  })

  it('ignores a summary that belongs to another task', () => {
    render(<TaskDetail {...detailProps({ summary: { ...SUMMARY, id: 8, open_question: QUESTION } })} />)
    expect(screen.queryByTestId('task-question')).toBeNull()
  })
})

describe('TaskDetail acceptance editing', () => {
  afterEach(cleanup)

  const ITEMS = [
    { id: 5, position: 0, text: 'Run `bun run test`', checked_at_ms: 3, checked_by: 'agent', },
    { id: 6, position: 1, text: 'Looks right on a narrow window', checked_at_ms: null, checked_by: null }
  ]

  it('marks executable items and counts them', () => {
    render(<TaskDetail {...detailProps({ detail: { task: TASK, acceptance: ITEMS, comments: [], history: [], runs: [] } })} />)
    expect(screen.getByTestId('task-acceptance-executable-5').textContent).toBe('Executable')
    expect(screen.queryByTestId('task-acceptance-executable-6')).toBeNull()
    expect(screen.getByTestId('task-acceptance').textContent).toContain('1/2 · 1 executable')
  })

  it('edits, removes and adds items and saves the list at the revision it was read at', () => {
    const onSave = vi.fn()
    render(<TaskDetail {...detailProps({ onSave, detail: { task: TASK, acceptance: ITEMS, comments: [], history: [], runs: [] } })} />)
    fireEvent.click(screen.getByTestId('task-acceptance-edit'))
    expect(screen.getByText(/A command in backticks/)).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'Acceptance item 1' }) as HTMLInputElement).value).toBe('Run `bun run test`')
    fireEvent.click(screen.getByRole('button', { name: 'Remove acceptance item 2' }))
    fireEvent.click(screen.getByTestId('task-acceptance-add'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Acceptance item 2' }), { target: { value: '  `cargo test -p app`  ' } })
    fireEvent.click(screen.getByTestId('task-acceptance-add'))
    fireEvent.click(screen.getByTestId('task-acceptance-save'))
    expect(onSave).toHaveBeenCalledWith(7, 12, { acceptance: ['Run `bun run test`', '`cargo test -p app`'] })
    expect(screen.queryByRole('textbox', { name: 'Acceptance item 1' })).toBeNull()
  })

  it('discards the draft on Cancel', () => {
    const onSave = vi.fn()
    render(<TaskDetail {...detailProps({ onSave, detail: { task: TASK, acceptance: ITEMS, comments: [], history: [], runs: [] } })} />)
    fireEvent.click(screen.getByTestId('task-acceptance-edit'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Acceptance item 1' }), { target: { value: 'Changed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('checkbox', { name: /Run `bun run test`/ })).toBeTruthy()
  })

  it('stops adding at the per-task item limit', () => {
    const many = Array.from({ length: 50 }, (_, index) => ({ id: index + 1, position: index, text: `Item ${index + 1}`, checked_at_ms: null, checked_by: null }))
    render(<TaskDetail {...detailProps({ detail: { task: TASK, acceptance: many, comments: [], history: [], runs: [] } })} />)
    fireEvent.click(screen.getByTestId('task-acceptance-edit'))
    expect((screen.getByTestId('task-acceptance-add') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('Task run proof', () => {
  afterEach(cleanup)

  const renderCard = (run: TaskRun, pullRequestUrl: string | null = null): void => {
    render(<TaskExecutionCard run={run} sessions={new Map()} now={10} readOnly={false} onOpenSession={vi.fn()} onReview={vi.fn()}
      onRunControl={vi.fn()} presentation="drawer" pullRequestUrl={pullRequestUrl} />)
  }

  it('shows the pull request, pushed commit, verification, capture and permanent changes', () => {
    renderCard({
      ...RUN,
      pr_url: 'https://github.com/acme/app/pull/57',
      pr_number: 57,
      pushed_sha: '0123456789abcdef0123456789abcdef01234567',
      evidence: {
        verification: [
          { command: 'cargo test -p houston-core', output: 'test result: ok. 12 passed', passed: true },
          { command: 'bun run typecheck', output: 'error TS2322', passed: false }
        ],
        capture_path: '/work/app/.captures/after.png',
        permanent: ['Migration 0042 adds tasks.question_id']
      }
    }, 'https://github.com/acme/app/pull/57')
    const proof = screen.getByTestId('task-run-proof')
    expect(screen.getByRole('link', { name: 'Pull request #57' }).getAttribute('href')).toBe('https://github.com/acme/app/pull/57')
    expect(proof.textContent).toContain('Pushed 0123456')
    expect(screen.getByRole('button', { name: 'Copy 0123456789abcdef0123456789abcdef01234567' })).toBeTruthy()
    expect(screen.getByText('Verification reported by the agent')).toBeTruthy()
    expect(screen.getByLabelText('Passed')).toBeTruthy()
    expect(screen.queryByLabelText('Verified')).toBeNull()
    expect(screen.getByLabelText('Failed')).toBeTruthy()
    const toggle = screen.getByRole('button', { name: /cargo test -p houston-core/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByTestId('task-run-verification-output').map((node) => node.textContent)).toEqual(['test result: ok. 12 passed', 'error TS2322'])
    expect(proof.textContent).toContain('/work/app/.captures/after.png')
    expect(screen.getByText('What becomes permanent')).toBeTruthy()
    expect(screen.getByText('Migration 0042 adds tasks.question_id')).toBeTruthy()
    expect(document.querySelector('[data-task-drawer-run-reuse]')?.textContent).toBe('Reuses houston/task/hou-7 · pull request #57')
  })

  it('names a pull request number without a link when no pull request URL is known', () => {
    renderCard({ ...RUN, pr_number: 12 })
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('Pull request #12')).toBeTruthy()
  })

  it('shows no proof block for a run that recorded none', () => {
    renderCard(RUN)
    expect(screen.queryByTestId('task-run-proof')).toBeNull()
  })
})
