// @vitest-environment jsdom
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient } from '../../houston/client'
import { BranchCommits } from './BranchCommits'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

class FakeClient {
  listeners = new Map<string, Set<(message: never) => void>>()
  requests: string[] = []

  subscribe(kind: string, handler: (message: never) => void): () => void {
    const listeners = this.listeners.get(kind) ?? new Set()
    listeners.add(handler)
    this.listeners.set(kind, listeners)
    return () => listeners.delete(handler)
  }

  gitBranchCommits(dir: string): void {
    this.requests.push(dir)
  }

  emit(kind: string, message: object): void {
    for (const listener of this.listeners.get(kind) ?? []) listener(message as never)
  }
}

describe('BranchCommits', () => {
  it('renders the total, recent commits, relative times and expands in place', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-05T12:00:00.000Z'))
    const client = new FakeClient()
    render(<BranchCommits client={client as unknown as HoustonClient} dir="/repo" />)
    expect(client.requests).toEqual(['/repo'])

    await act(async () => client.emit('git_branch_commits', {
      dir: '/repo',
      total: 4,
      truncated: false,
      commits: [
        { sha: 'a1c3f09', subject: 'Newest change', author_time_ms: Date.now() - 40_000 },
        { sha: '7d20e44', subject: 'Earlier change', author_time_ms: Date.now() - 31 * 60_000 },
        { sha: '26f4f70', subject: 'Oldest visible', author_time_ms: Date.now() - 2 * 3_600_000 }
      ]
    }))

    expect(screen.getByText('On this branch · 4 commits')).toBeTruthy()
    expect(screen.getAllByTestId('branch-commit-row')).toHaveLength(2)
    expect(screen.getByText('a1c3f09')).toBeTruthy()
    expect(screen.getByText('Newest change')).toBeTruthy()
    expect(screen.getByText('40s ago')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'View all' }))
    expect(screen.getAllByTestId('branch-commit-row')).toHaveLength(3)
  })

  it('hides the section when the branch has no upstream', async () => {
    const client = new FakeClient()
    render(<BranchCommits client={client as unknown as HoustonClient} dir="/repo" />)
    await act(async () => client.emit('error', { message: 'listing branch commits: expected the current branch to have an upstream' }))
    expect(screen.queryByTestId('branch-commits')).toBeNull()
  })

  it('shows other request errors as one muted line', async () => {
    const client = new FakeClient()
    render(<BranchCommits client={client as unknown as HoustonClient} dir="/repo" />)
    await act(async () => client.emit('error', { message: 'permission denied' }))
    expect(screen.getByTestId('branch-commits-error').textContent).toContain('permission denied')
  })
})
