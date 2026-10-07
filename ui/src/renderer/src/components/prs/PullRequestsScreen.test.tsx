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

afterEach(cleanup)

describe('PullRequestsScreen', () => {
  it('condenses the header after the list scrolls', () => {
    render(
      <PullRequestsScreen
        repoName="acme/repo"
        workspace="/repo"
        currentUser="theo"
        items={[item]}
        onOpenPullRequest={() => {}}
      />,
    )
    expect(screen.getByTestId('pull-requests-screen').querySelector('[class*="max-w-[1152px]"]')).toBeTruthy()
    const scroll = screen.getByTestId('pull-requests-screen').querySelector('[class*="overflow-y-auto"]')!
    Object.defineProperty(scroll, 'scrollTop', { value: 59, configurable: true })
    fireEvent.scroll(scroll)
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy()
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

  it('keeps the list beside the detail and closes the detail from its tab', () => {
    render(
      <PullRequestsScreen
        repoName="acme/repo"
        workspace="/repo"
        currentUser="theo"
        items={[item]}
      />,
    )
    fireEvent.click(screen.getByTestId('pr-row-42'))
    expect(screen.getByTestId('pr-row-42').className).toContain('prs-pr-row-selected')
    expect(screen.getByTestId('pr-screen-detail')).toBeTruthy()
    expect(screen.getByTestId('pull-requests-screen')).toBeTruthy()
    fireEvent.click(screen.getByTestId('pr-screen-detail').querySelector('.panel-tab-close')!)
    expect(screen.queryByTestId('pr-screen-detail')).toBeNull()
    expect(screen.getByTestId('pr-row-42')).toBeTruthy()
  })
})
