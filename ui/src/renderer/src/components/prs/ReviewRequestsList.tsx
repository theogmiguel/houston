import type { ReviewRequest } from '../../houston/generated/ReviewRequest'
import type { ReviewRequestState } from '../../houston/generated/ReviewRequestState'
import type { ReviewTier } from '../../houston/generated/ReviewTier'
import type { ReviewRequestsState } from '../../houston/useReviewRequests'
import { IconGitPullRequest } from '../icons'
import { Inline } from '../ui/Inline'
import { BulletList, InlineCluster } from '../ui/navText'
import { Button, Card, Chip, EmptyState, InlineLink, Notice, Text, type ChipTone } from '../ui'

const TIER_TONE: Readonly<Record<ReviewTier, ChipTone>> = {
  a: 'success',
  b: 'warning',
  c: 'danger'
}

const STATE_LABEL: Readonly<Record<ReviewRequestState, string>> = {
  new: 'New',
  reviewing: 'Reviewing',
  reviewed: 'Reviewed',
  dismissed: 'Dismissed'
}

const STATE_TONE: Readonly<Record<ReviewRequestState, ChipTone>> = {
  new: 'info',
  reviewing: 'warning',
  reviewed: 'success',
  dismissed: 'default'
}

export function reviewRequestTitle(item: ReviewRequest): string {
  return `${item.repo}#${item.number}`
}

export function tierLabel(tier: ReviewTier): string {
  return `Tier ${tier.toUpperCase()}`
}

/** Rows of requests awaiting the operator's review, newest head first. The tier
 *  is never shown alone: its deterministic reasons sit directly under it. */
export function ReviewRequestsList({
  state,
  onDismiss,
  onReopen,
  onOpenSettings
}: {
  state: ReviewRequestsState | null
  onDismiss: (id: number) => void
  onReopen: (id: number) => void
  onOpenSettings?: () => void
}): React.JSX.Element {
  if (state === null) return <Text role="status" aria-busy="true" tone="muted">Reading review requests…</Text>
  if (state.mode === 'off') {
    return (
      <EmptyState
        icon={IconGitPullRequest}
        heading="Review requests are off"
        description="Turn them on in Settings ▸ Workspaces to have Houston notice pull requests waiting for your review."
        action={onOpenSettings && { label: 'Open settings', onClick: onOpenSettings }}
      />
    )
  }
  return (
    <div className="grid min-w-0 gap-[var(--space-2)]" data-testid="review-requests-list">
      {state.pausedUntilMs != null && (
        <Notice tone="warn" data-testid="review-requests-paused">
          GitHub asked Houston to wait until {new Date(state.pausedUntilMs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} before the next request.
        </Notice>
      )}
      {state.note && <Notice tone="info" data-testid="review-requests-note">{state.note}</Notice>}
      {state.items.length === 0 ? (
        <EmptyState
          icon={IconGitPullRequest}
          heading="No review requests"
          description="Pull requests that ask for your review will appear here after the next GitHub check."
        />
      ) : (
        <div role="list" aria-label="Review requests" className="grid min-w-0 gap-[var(--space-2)]">
          {state.items.map((item) => (
            <ReviewRequestRow key={item.id} item={item} onDismiss={onDismiss} onReopen={onReopen} />
          ))}
        </div>
      )}
    </div>
  )
}

function ReviewRequestRow({ item, onDismiss, onReopen }: { item: ReviewRequest; onDismiss: (id: number) => void; onReopen: (id: number) => void }): React.JSX.Element {
  return (
    <Card role="listitem" data-testid={`review-request-${item.id}`} padding="md" className="grid min-w-0 gap-[var(--space-2)]">
      <Inline gap="small" wrap align="start" className="min-w-0">
        <div className="grid min-w-0 flex-1 gap-[var(--space-0-5)]">
          <Text weight="semibold" className="min-w-0 truncate">{reviewRequestTitle(item)} · {item.title}</Text>
          <Text size="caption" tone="muted">{item.author} · {item.host}</Text>
        </div>
        <InlineCluster gap="sm" className="flex-none">
          <Chip variant="state" tone={TIER_TONE[item.tier]} label={tierLabel(item.tier)} />
          <Chip variant="state" tone={STATE_TONE[item.state]} label={STATE_LABEL[item.state]} />
        </InlineCluster>
      </Inline>
      <BulletList items={item.reasons.length > 0 ? item.reasons : ['No reasons were recorded.']} />
      {!item.workspace && (
        <Text size="caption" tone="muted">No checkout for this repository, so Houston cannot start a review pane.</Text>
      )}
      <InlineCluster>
        <InlineLink href={item.url}>Open on GitHub</InlineLink>
        <span className="flex-1" />
        {item.state === 'dismissed' ? (
          <Button variant="ghost" size="sm" onClick={() => onReopen(item.id)}>Reopen</Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => onDismiss(item.id)}>Dismiss</Button>
        )}
      </InlineCluster>
    </Card>
  )
}
