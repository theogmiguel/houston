import type { PrDetail } from '../../houston/client'
import { BTN_SECONDARY } from '../buttonChrome'
import { ScmNotice } from './ScmNotice'

const SMALL = 'text-[length:var(--tr-text-small-size)]'
const ROW = 'flex flex-col gap-0.5 px-3 py-1.5 border-t border-t-[var(--divider)] first:border-t-0'
const BODY = `${SMALL} text-[var(--text-secondary)] whitespace-pre-wrap break-words`

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
      <span className="flex flex-wrap items-center gap-2">
        <span>{reason}</span>
        <button
          type="button"
          data-testid={link.linked ? 'pr-unlink' : 'pr-link-detected'}
          className={`btn ${BTN_SECONDARY}`}
          disabled={link.busy}
          onClick={() => (link.linked ? link.onUnlink() : link.onLink(link.number))}
        >
          {link.linked ? 'Unlink' : `Link #${link.number}`}
        </button>
        <button
          type="button"
          data-testid="pr-open-forge"
          className={`btn ${BTN_SECONDARY}`}
          disabled={!onOpenUrlInPane}
          onClick={() => onOpenUrlInPane?.(url)}
        >
          Open on Bitbucket
        </button>
      </span>
    </ScmNotice>
  )
}

/** Inline threads and general comments, with no composer, reply or reaction. */
export function PrReadOnlyDiscussion({ detail }: { detail: PrDetail }): React.JSX.Element {
  return (
    <div className="flex flex-col" data-testid="pr-read-only-discussion">
      {detail.threads.map((thread, index) => (
        <div key={thread.id || index} className={ROW} data-testid="pr-thread">
          <span className={`font-mono ${SMALL} text-[var(--text-faint)]`}>
            {thread.path ?? 'file'}
            {thread.line !== null && thread.line !== undefined ? `:${thread.line}` : ''}
            {thread.resolved ? ' · resolved' : ''}
          </span>
          {thread.comments.map((comment, at) => (
            <span key={comment.id || at} className={BODY}>
              <span className="text-[var(--text-primary)]">{comment.author}</span> {comment.body}
            </span>
          ))}
        </div>
      ))}
      {detail.comments.map((comment, index) => (
        <div key={comment.id ?? index} className={ROW} data-testid="pr-comment">
          <span className={`${SMALL} text-[var(--text-primary)]`}>{comment.author}</span>
          <span className={BODY}>{comment.body}</span>
        </div>
      ))}
      {detail.comments_total > detail.comments.length && (
        <div className={`${ROW} ${SMALL} text-[var(--text-muted)]`}>
          Showing {detail.comments.length} of {detail.comments_total} comments.
        </div>
      )}
      {detail.threads_message !== null && detail.threads_message !== undefined && (
        <div className={`${ROW} ${SMALL} text-[var(--text-muted)]`} data-testid="pr-threads-message">
          {detail.threads_message}
        </div>
      )}
      {detail.threads.length === 0 && detail.comments.length === 0 && (
        <div className={`${ROW} ${SMALL} text-[var(--text-muted)]`}>No comments yet.</div>
      )}
    </div>
  )
}
