import { useState } from 'react'
import type { PrCheck, PrDetail, PrThread } from '../../houston/client'
import { Button } from './Button'
import { Icon } from '../Icon'
import { IconCheck, IconLoaderCircle } from '../icons'

const SPIN_CLASS = 'loop-anim motion-safe:animate-[git-spin_0.9s_linear_infinite]'

function checkAge(check: PrCheck): string {
  if (check.duration_ms == null) return ({ queued: 'queued', running: 'running', passing: 'passing', failing: 'failing', skipped: 'skipped', unknown: 'unknown' } as const)[check.state]
  const seconds = Math.round(check.duration_ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
}

function CheckRow({ check }: { check: PrCheck }): React.JSX.Element {
  const running = check.state === 'running'
  return <div data-testid="pr-check-row" className="pr-inspector-check-row">
    <span className={`pr-inspector-check-icon ${running ? 'is-running' : 'is-passing'}`} data-testid="pr-check-icon">
      {check.state === 'passing' ? <Icon glyph={IconCheck} role="small" /> : running ? <span className={SPIN_CLASS}><Icon glyph={IconLoaderCircle} role="small" /></span> : <span className="pr-inspector-check-dot" />}
    </span>
    <span className={`pr-inspector-check-name ${running ? 'is-running' : ''}`}>{check.name}</span>
    <span className={`pr-inspector-check-time ${running ? 'is-running' : ''}`}>{running ? `running ${checkAge(check)}` : checkAge(check)}</span>
  </div>
}

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

export function PrInspectorSections({ checks, detail, approvalsRequired, approvalsReceived, number, busy, onReply, onSendToOrchestrator, onOpenChecks }: {
  checks: PrCheck[]
  detail: PrDetail
  approvalsRequired: number
  approvalsReceived: number
  number: number
  busy: boolean
  onReply: (threadId: string, body: string) => void
  onSendToOrchestrator?: (text: string) => void
  onOpenChecks?: () => void
}): React.JSX.Element {
  const passed = checks.filter((check) => check.state === 'passing').length
  const openThreads = detail.threads.filter((thread) => !thread.resolved)
  return <>
    <section className="pr-inspector-checks" data-testid="pr-checks">
      <div className="pr-inspector-check-caption">
        <span data-testid="pr-check-summary">Checks · {passed} of {checks.length} passed</span>
        {onOpenChecks && <Button type="button" variant="link" size="sm" data-testid="pr-check-details" onClick={onOpenChecks}>Details</Button>}
      </div>
      {checks.map((check, index) => <CheckRow key={`${check.name}-${index}`} check={check} />)}
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
