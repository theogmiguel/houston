// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PrListItem } from '../../houston/client'
import { PullRequestsScreen } from './PullRequestsScreen'

const item: PrListItem = {
  number: 42,
  title: 'Keep the PR list focused',
  url: 'https://github.com/acme/repo/pull/42',
  state: 'open',
  is_draft: false,
  author: 'theo',
  head_ref: 'feature',
  base_ref: 'main',
  updated_at: 100,
  created_at: 50,
  additions: 12,
  deletions: 3,
  review_decision: null,
  checks: 'passing',
  labels: [],
  comments: 0,
  review_requested: false,
  mergeable: 'mergeable',
}

afterEach(() => { cleanup(); localStorage.clear() })

describe('PullRequestsScreen', () => {
  it('keeps the workspace lede and state controls available after scrolling', () => {
    render(
      <PullRequestsScreen
        repoName="acme/repo"
        workspace="/repo"
        currentUser="theo"
        items={[item]}
        onOpenPullRequest={() => {}}
      />,
    )
    expect(screen.getByTestId('pull-requests-screen').querySelector('[class*="max-w-[760px]"]')).toBeTruthy()
    const scroll = screen.getByTestId('pull-requests-screen').querySelector('[class*="overflow-y-auto"]')!
    Object.defineProperty(scroll, 'scrollTop', { value: 59, configurable: true })
    fireEvent.scroll(scroll)
    expect(screen.getByRole('radio', { name: 'Open 1' })).toBeTruthy()
    expect(screen.getByText('Open pull requests in this workspace’s repository, grouped by who has to act next.')).toBeTruthy()
  })

  it('opens the selected pull request from a row', () => {
    const onOpen = vi.fn()
    render(
      <PullRequestsScreen
        repoName="acme/repo"
        workspace="/repo"
        currentUser="theo"
        items={[item]}
        onOpenPullRequest={onOpen}
      />,
    )
    fireEvent.click(screen.getAllByTestId('pr-row-42')[0])
    expect(onOpen).toHaveBeenCalledWith(item)
  })

  it('keeps the list beside the detail and toggles the selected row to close it', () => {
    render(
      <PullRequestsScreen
        repoName="acme/repo"
        workspace="/repo"
        currentUser="theo"
        items={[item]}
      />,
    )
    fireEvent.click(screen.getByTestId('pr-row-42'))
    expect(screen.getByTestId('pr-row-42').className).toContain('bg-selected-fill')
    expect(screen.getByTestId('pr-row-42').getAttribute('aria-current')).toBe('true')
    expect(screen.getByTestId('pr-screen-detail')).toBeTruthy()
    expect(screen.getByTestId('pull-requests-screen')).toBeTruthy()
    fireEvent.click(screen.getByTestId('pr-row-42'))
    expect(screen.queryByTestId('pr-screen-detail')).toBeNull()
    expect(screen.getByTestId('pr-row-42')).toBeTruthy()
  })
})

it('groups by who acts next and shows status words', () => {
  render(<PullRequestsScreen repoName="acme/repo" workspace="/repo" currentUser="theo" items={[item, { ...item, number: 43, author: 'reviewer', review_requested: true }, { ...item, number: 44, author: 'another', checks: 'running' }]} />)
  expect(screen.getByRole('region', { name: 'Waiting on you' }).textContent).toContain('Your review')
  expect(screen.getByRole('region', { name: 'Yours' }).textContent).toContain('Ready to merge')
  expect(screen.getByRole('region', { name: 'Others' }).textContent).toContain('Checks running')
})

it('picks one workspace and requests the selected state', () => {
  const onWorkspaceChange = vi.fn()
  const onStateChange = vi.fn()
  render(<PullRequestsScreen repoName="Houston" workspace="/repo" currentUser="theo" items={[item]} workspaces={[{ name: 'Houston', path: '/repo' }, { name: 'Other project', path: '/other' }]} onWorkspaceChange={onWorkspaceChange} onStateChange={onStateChange} />)
  fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Workspace' }), { button: 0 })
  fireEvent.mouseUp(screen.getByRole('option', { name: 'Other project' }))
  expect(onWorkspaceChange).toHaveBeenCalledWith('/other')
  fireEvent.click(screen.getByRole('radio', { name: 'Merged' }))
  expect(onStateChange).toHaveBeenCalledWith('merged')
  expect(screen.queryByTestId('pr-row-42')).toBeNull()
})

it('requests the restored state instead of filtering an unrelated open listing', () => {
  localStorage.setItem('tr-pr-list:/repo', JSON.stringify({ state: 'merged' }))
  const onStateChange = vi.fn()
  render(<PullRequestsScreen repoName="Houston" workspace="/repo" currentUser="theo" items={[]} state="open" onStateChange={onStateChange} />)
  expect(screen.getByRole('radio', { name: 'Merged' }).getAttribute('aria-checked')).toBe('true')
  expect(onStateChange).toHaveBeenCalledWith('merged')
})
