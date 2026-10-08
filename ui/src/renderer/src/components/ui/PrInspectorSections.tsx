import { useState } from 'react'
import type { PrDetail, PrThread } from '../../houston/client'
import { Button } from './Button'
import { PrChecksPanel } from '../prs/PrChecksPanel'
import type { PrChecksState } from '../prs/usePrChecksState'

function ReviewComment({ thread, comment, number, busy, onReply, onSendToOrchestrator }: {
  thread: PrThread
  comment: PrThread['comments'][number]
  number: number
  busy: boolean
  onReply: (threadId: string, body: string) => void
  onSendToOrchestrator?: (text: string) => void
}): React.JSX.Element {
  const [replyOpen, setReplyOpen] = useState(false)
  const [reply, setReply] = useState('')
  const location = `${thread.path ?? 'a file'}${thread.line != null ? `:${thread.line}` : ''}`
  const age = Math.max(0, Math.floor((Date.now() / 1000 - comment.created_at) / 60))
  return <article className="pr-inspector-comment" data-testid="pr-inspector-comment">
    <div className="pr-inspector-comment-head">
      <strong>{comment.author}</strong>
      <span className="pr-inspector-comment-location">{location}</span>
      <time className="pr-inspector-comment-age">{age}m</time>
    </div>
    <p className="pr-inspector-comment-body">{comment.body}</p>
    <div className="pr-inspector-comment-links">
      <button type="button" className="pr-inspector-link" data-testid={`pr-thread-reply-open-${comment.id}`} onClick={() => setReplyOpen((open) => !open)}>Reply</button>
      {onSendToOrchestrator && <button type="button" className="pr-inspector-link" onClick={() => onSendToOrchestrator(`PR #${number} · ${location}\n${comment.author}: ${comment.body}`)}>Send to orchestrator</button>}
    </div>
    {replyOpen && <div className="pr-inspector-reply">
      <textarea data-testid={`pr-thread-reply-${thread.id}`} aria-label={`Reply to the thread on ${thread.path ?? 'a file'}`} rows={2} value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Reply to this discussion" />
      <div className="pr-inspector-reply-actions">
        <Button variant="secondary" size="sm" data-testid={`pr-thread-reply-send-${thread.id}`} disabled={busy || reply.trim().length === 0} onClick={() => { onReply(thread.id, reply); setReply(''); setReplyOpen(false) }}>Reply</Button>
        <Button variant="ghost" size="sm" onClick={() => setReplyOpen(false)}>Cancel</Button>
      </div>
    </div>}
  </article>
}

export function PrInspectorSections({ detail, approvalsRequired, approvalsReceived, number, busy, onReply, onSendToOrchestrator, checkState }: {
  detail: PrDetail
  approvalsRequired: number
  approvalsReceived: number
  number: number
  busy: boolean
  onReply: (threadId: string, body: string) => void
  onSendToOrchestrator?: (text: string) => void
  checkState: PrChecksState
}): React.JSX.Element {
  const openThreads = detail.threads.filter((thread) => !thread.resolved)
  return <>
    <section className="pr-inspector-checks" data-testid="pr-checks">
      <PrChecksPanel state={checkState} />
    </section>
    <section className="pr-inspector-review" data-testid="pr-inspector-review">
      <div className="pr-inspector-section-caption" data-testid="pr-review-requirement">
        <span>Review · {approvalsRequired} approval{approvalsRequired === 1 ? '' : 's'} required</span>
        <span className="pr-inspector-review-count" data-review-count>{Math.min(approvalsReceived, approvalsRequired)} / {approvalsRequired}</span>
      </div>
      <div className="pr-inspector-comments">
        {openThreads.flatMap((thread) => thread.comments.map((comment) => <ReviewComment key={comment.id} thread={thread} comment={comment} number={number} busy={busy} onReply={onReply} onSendToOrchestrator={onSendToOrchestrator} />))}
      </div>
    </section>
  </>
}
