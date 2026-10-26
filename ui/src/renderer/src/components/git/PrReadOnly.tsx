import type { PrDetail } from '../../houston/client'
import { Button } from '../ui/Button'
import { Inline } from '../ui/Inline'
import { PullRequestRole } from '../ui/PullRequestRoles'
import { Text } from '../ui/Text'
import { ScmNotice } from './ScmNotice'

/** The tab's own association with the pull request, which is Houston's to
 * change even when the pull request itself is not. */
export interface PrReadOnlyLink {
  number: number
  linked: boolean
  busy: boolean
  onLink: (number: number) => void
  onUnlink: () => void
}

/** Why nothing here can change the pull request, and where it can be changed. */
export function PrReadOnlyNotice({
  reason,
  url,
  onOpenUrlInPane,
  link
}: {
  reason: string
  url: string
  onOpenUrlInPane?: (url: string) => void
  link: PrReadOnlyLink
}): React.JSX.Element {
  return (
    <ScmNotice tone="info" testId="pr-read-only">
      <Inline as="span" gap="small" wrap>
        <span>{reason}</span>
        <Button
          variant="secondary"
          size="sm"
          data-testid={link.linked ? 'pr-unlink' : 'pr-link-detected'}
          disabled={link.busy}
          onClick={() => (link.linked ? link.onUnlink() : link.onLink(link.number))}
        >
          {link.linked ? 'Unlink' : `Link #${link.number}`}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          data-testid="pr-open-forge"
          disabled={!onOpenUrlInPane}
          onClick={() => onOpenUrlInPane?.(url)}
        >
          Open on Bitbucket
        </Button>
      </Inline>
    </ScmNotice>
  )
}

/** Inline threads and general comments, with no composer, reply or reaction. */
export function PrReadOnlyDiscussion({ detail }: { detail: PrDetail }): React.JSX.Element {
  return (
    <PullRequestRole as="div" role="summary-content" data-testid="pr-read-only-discussion">
      {detail.threads.map((thread, index) => (
        <PullRequestRole key={thread.id || index} as="div" role="review-row" data-testid="pr-thread">
          <PullRequestRole as="span" role="branch-summary">
            {thread.path ?? 'file'}
            {thread.line !== null && thread.line !== undefined ? `:${thread.line}` : ''}
            {thread.resolved ? ' · resolved' : ''}
          </PullRequestRole>
          {thread.comments.map((comment, at) => (
            <Text key={comment.id || at} as="span" size="small" tone="secondary">
              <Text as="span" size="small" tone="primary">
                {comment.author}
              </Text>{' '}
              {comment.body}
            </Text>
          ))}
        </PullRequestRole>
      ))}
      {detail.comments.map((comment, index) => (
        <PullRequestRole key={comment.id ?? index} as="div" role="review-row" data-testid="pr-comment">
          <PullRequestRole as="span" role="review-author">
            {comment.author}
          </PullRequestRole>
          <Text as="span" size="small" tone="secondary">
            {comment.body}
          </Text>
        </PullRequestRole>
      ))}
      {detail.comments_total > detail.comments.length && (
        <PullRequestRole as="div" role="review-row">
          <Text as="span" size="small" tone="muted">
            Showing {detail.comments.length} of {detail.comments_total} comments.
          </Text>
        </PullRequestRole>
      )}
      {detail.threads_message !== null && detail.threads_message !== undefined && (
        <PullRequestRole as="div" role="review-row" data-testid="pr-threads-message">
          <Text as="span" size="small" tone="muted">
            {detail.threads_message}
          </Text>
        </PullRequestRole>
      )}
      {detail.threads.length === 0 && detail.comments.length === 0 && (
        <PullRequestRole as="div" role="review-row">
          <Text as="span" size="small" tone="muted">
            No comments yet.
          </Text>
        </PullRequestRole>
      )}
    </PullRequestRole>
  )
}
