import { lazy, Suspense } from 'react'
import type { AgentKind, HoustonClient, PrListItem, PrListState, PrSort, PullRequestLink, Workspace } from '../../houston/client'
import type { SurfaceKind } from '../../scmPanel'

const PullRequestsScreen = lazy(() =>
  import('./PullRequestsScreen').then((module) => ({ default: module.PullRequestsScreen })),
)

interface PullRequestsRailScreenProps {
  repoName: string
  workspace: string
  currentUser: string
  workspaces?: readonly Workspace[]
  onWorkspaceChange?: (workspace: string) => void
  items: PrListItem[]
  client: HoustonClient | null
  directory: string | null
  state: PrListState
  sort: PrSort
  loading: boolean
  onStateChange: (state: PrListState) => void
  onSortChange: (sort: PrSort) => void
  onRefresh: () => void
  onOpenSurface?: (surface: SurfaceKind) => void
  onOpenUrlInPane?: (url: string) => void
  onHandOff?: (worktree: string, prompt: string, agent: AgentKind) => void
  onOpenMergeQueueSettings?: () => void
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
