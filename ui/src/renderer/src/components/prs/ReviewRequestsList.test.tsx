// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReviewRequest } from '../../houston/generated/ReviewRequest'
import type { ReviewRequestsState } from '../../houston/useReviewRequests'
import { ReviewRequestsList } from './ReviewRequestsList'

function request(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    id: 1,
    host: 'github.com',
    repo: 'acme/houston',
    number: 42,
    title: 'A pane keeps its name',
    author: 'octocat',
    url: 'https://github.com/acme/houston/pull/42',
    head_sha: 'abc1234',
    tier: 'b',
    reasons: ['Touches 6 files', 'No tests changed'],
    state: 'new',
    workspace: '/work/houston',
    provider: 'claude',
    ...overrides
  }
}

function state(overrides: Partial<ReviewRequestsState> = {}): ReviewRequestsState {
  return { mode: 'notify', items: [request()], pausedUntilMs: null, note: null, ...overrides }
}

describe('ReviewRequestsList', () => {
  afterEach(cleanup)

  it('shows each request with its tier and every reason', () => {
    const view = render(<ReviewRequestsList state={state()} onDismiss={vi.fn()} onReopen={vi.fn()} />)
    expect(screen.getByText('acme/houston#42 · A pane keeps its name')).toBeTruthy()
    expect(screen.getByText('octocat · github.com')).toBeTruthy()
    expect(screen.getByText('Tier B')).toBeTruthy()
    expect(screen.getByText('New')).toBeTruthy()
    expect(screen.getByText('Touches 6 files')).toBeTruthy()
    expect(screen.getByText('No tests changed')).toBeTruthy()
    expect(view.getByText('Open on GitHub').getAttribute('href')).toBe('https://github.com/acme/houston/pull/42')
  })

  it('dismisses a live request and reopens a dismissed one', () => {
    const onDismiss = vi.fn()
    const onReopen = vi.fn()
    const view = render(<ReviewRequestsList state={state()} onDismiss={onDismiss} onReopen={onReopen} />)
    fireEvent.click(view.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledWith(1)

    cleanup()
    const dismissed = render(<ReviewRequestsList state={state({ items: [request({ state: 'dismissed' })] })} onDismiss={onDismiss} onReopen={onReopen} />)
    fireEvent.click(dismissed.getByRole('button', { name: 'Reopen' }))
    expect(onReopen).toHaveBeenCalledWith(1)
  })

  it('says when there is no checkout for a request', () => {
    render(<ReviewRequestsList state={state({ items: [request({ workspace: null })] })} onDismiss={vi.fn()} onReopen={vi.fn()} />)
    expect(screen.getByText(/No checkout for this repository/)).toBeTruthy()
  })

  it('shows a pause and the daemon note', () => {
    render(<ReviewRequestsList state={state({ pausedUntilMs: Date.UTC(2026, 9, 25, 12, 5), note: 'GitHub asked Houston to slow down.' })} onDismiss={vi.fn()} onReopen={vi.fn()} />)
    expect(screen.getByTestId('review-requests-paused').textContent).toContain('GitHub asked Houston to wait until')
    expect(screen.getByTestId('review-requests-note').textContent).toContain('GitHub asked Houston to slow down.')
  })

  it('shows nothing but the off explanation when the mode is off', () => {
    const view = render(
      <ReviewRequestsList
        state={state({ mode: 'off' })}
        onDismiss={vi.fn()}
        onReopen={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    )
    expect(screen.getByText('Review requests are off')).toBeTruthy()
    expect(view.queryByText('Tier B')).toBeNull()
    expect(view.queryByTestId('review-requests-list')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Open settings' }))
  })
})
