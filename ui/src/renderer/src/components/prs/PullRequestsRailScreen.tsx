import { lazy, Suspense } from 'react'
import type { PrListItem, PrListState, PrSort, PullRequestLink } from '../../houston/client'

const PullRequestsScreen = lazy(() =>
  import('./PullRequestsScreen').then((module) => ({ default: module.PullRequestsScreen })),
)

interface PullRequestsRailScreenProps {
  repoName: string
  workspace: string
  currentUser: string
  items: PrListItem[]
  state: PrListState
  sort: PrSort
  loading: boolean
  onStateChange: (state: PrListState) => void
  onSortChange: (sort: PrSort) => void
  onRefresh: () => void
  onOpenPullRequest: (item: PrListItem) => void
}

export function PullRequestsRailScreen(props: PullRequestsRailScreenProps): React.JSX.Element {
  return (
    <Suspense fallback={<div className="flex-1" />}>
      <PullRequestsScreen {...props} />
    </Suspense>
  )
}

export function pullRequestLinkFromItem(item: PrListItem): PullRequestLink {
  const prUrl = new URL(item.url)
  const [owner, repositoryName] = prUrl.pathname.split('/').filter(Boolean)
  return {
    host: prUrl.host,
    repository: `${owner}/${repositoryName}`,
    number: item.number,
    url: item.url,
    state: item.state,
    source: 'detected',
    title: item.title,
    is_draft: item.is_draft,
    additions: item.additions,
    deletions: item.deletions,
    changed_files: 0,
    checks: item.checks ?? null,
    review_decision: item.review_decision ?? null,
    linked_at: Date.now(),
  }
}
