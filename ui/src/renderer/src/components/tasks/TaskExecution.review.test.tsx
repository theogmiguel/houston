// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskRun } from '../../houston/generated/TaskRun'
import type { TaskReviewOutcome } from './format'
import type { TaskReviewVerdict } from '../../houston/generated/TaskReviewVerdict'
import { TaskExecutionCard } from './TaskExecution'

function review(overrides: Partial<TaskReviewVerdict> = {}): TaskReviewVerdict {
  return {
    head_sha: '9f2c1ab44d9c',
    verdict: 'fail',
    focus: 'bugs',
    findings: [{ path: 'core/pty.rs', line: 42, severity: 'high', category: 'bug', message: 'A closed pane leaks its reader thread.' }],
    skipped_reason: null,
    outdated: true,
    ...overrides
  }
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 1,
    task_id: 1,
    attempt: 1,
    kind: 'review',
    state: 'handed_back',
    provider: 'codex',
    initial_revision: 1,
    started_at_ms: 1,
    ...overrides
  }
}

function renderRun(row: TaskRun, review: TaskReviewOutcome | null = null): void {
  render(
    <TaskExecutionCard
      run={row}
      sessions={new Map()}
      now={2}
      readOnly={false}
      review={review}
      onOpenSession={vi.fn()}
      onReview={vi.fn()}
      onRunControl={vi.fn()}
    />
  )
}

describe('TaskExecutionCard review result', () => {
  afterEach(cleanup)

  it('renders a structured verdict and hides the legacy findings block when review is present', () => {
    renderRun(run({ summary: '- legacy finding', review: review() }))
    expect(screen.getByTestId('task-review-result')).toBeTruthy()
    expect(screen.getByText('9f2c1ab')).toBeTruthy()
    expect(screen.getByText('core/pty.rs:42')).toBeTruthy()
    expect(screen.getByText('Review outdated')).toBeTruthy()
    expect(screen.queryByTestId('task-review-findings')).toBeNull()
  })

  it('keeps a legacy run without review rendering its summary as today', () => {
    renderRun(run({ summary: '- legacy finding' }), { reviewer: 'codex', verdict: 'fail', findings: '- legacy finding', retryRunId: null })
    expect(screen.queryByTestId('task-review-result')).toBeNull()
    expect(screen.getByTestId('task-review-findings').textContent).toContain('legacy finding')
  })
})
