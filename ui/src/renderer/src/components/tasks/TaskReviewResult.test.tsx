// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskReviewVerdict as TaskReviewVerdictData } from '../../houston/generated/TaskReviewVerdict'
import { TaskReviewResult, shortHeadSha } from './TaskReviewResult'

function verdict(overrides: Partial<TaskReviewVerdictData> = {}): TaskReviewVerdictData {
  return {
    head_sha: '9f2c1ab44d9c0e7a6b5f4e3d2c1b0a9988776655',
    verdict: 'fail',
    focus: 'bugs',
    findings: [
      { path: 'core/pty.rs', line: 42, severity: 'high', category: 'bug', message: 'A closed pane leaks its reader thread.' },
      { path: 'ui/App.tsx', line: 7, severity: 'nit', category: 'other', message: 'Prefer the existing helper.' }
    ],
    skipped_reason: null,
    outdated: false,
    ...overrides
  }
}

describe('TaskReviewResult', () => {
  afterEach(cleanup)

  it('shows the short reviewed head, focus, verdict and structured findings', () => {
    render(<TaskReviewResult review={verdict()} />)
    expect(screen.getByText('Reviewed')).toBeTruthy()
    expect(screen.getByText('9f2c1ab')).toBeTruthy()
    expect(screen.getByText('Focus: Bugs')).toBeTruthy()
    expect(screen.getByText('Failed')).toBeTruthy()
    expect(screen.getByText('core/pty.rs:42')).toBeTruthy()
    expect(screen.getByText('high')).toBeTruthy()
    expect(screen.getByText('Bug')).toBeTruthy()
    expect(screen.getByText('A closed pane leaks its reader thread.')).toBeTruthy()
    expect(screen.getByText('ui/App.tsx:7')).toBeTruthy()
    expect(screen.getByText('nit')).toBeTruthy()
    expect(screen.queryByText('Review outdated')).toBeNull()
  })

  it('marks a verdict pinned to an older head as outdated', () => {
    render(<TaskReviewResult review={verdict({ outdated: true, verdict: 'pass', findings: [] })} />)
    expect(screen.getByText('Passed')).toBeTruthy()
    expect(screen.getByText('Review outdated')).toBeTruthy()
    expect(screen.getByText(/The branch moved past this reviewed head/)).toBeTruthy()
  })

  it('shows why a review was skipped', () => {
    render(<TaskReviewResult review={verdict({ verdict: 'skipped', findings: [], skipped_reason: 'The diff is 12 lines across 2 files.' })} />)
    expect(screen.getByText('Skipped')).toBeTruthy()
    expect(screen.getByText('The diff is 12 lines across 2 files.')).toBeTruthy()
  })

  it('shortens only a long head sha', () => {
    expect(shortHeadSha('9f2c1ab44d9c')).toBe('9f2c1ab')
    expect(shortHeadSha('abc1234')).toBe('abc1234')
  })
})
