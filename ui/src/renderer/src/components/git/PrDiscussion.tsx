import { PrTab } from '../ui/PrTab'
import { Button } from '../ui/Button'
import { ReviewButton } from '../ui/ReviewButtonRoles'
import { TextArea } from '../ui/TextArea'
import { DiscussionEntry, DiscussionBody, DiscussionMeta, DiscussionActionsRow, DiscussionComposer, DiscussionCommentRow, DiscussionThreadHeader, DiscussionCommentMetaRow, DiscussionThreadList, DiscussionErrorMessage, DiscussionComposerPanel, DiscussionAuthor, DiscussionPath, DiscussionResolveAction } from '../ui/DiscussionEntry'
import { useState } from 'react'
import type { PrComment, PrDetail, PrReaction, PrThread } from '../../houston/client'
import { Disclosure } from '../ui/Disclosure'
import { Icon } from '../ui/Icon'
import { Tooltip } from '../ui/Tooltip'
import { IconCheck, IconRefresh } from '../icons'
import { PrReactions } from './PrPickers'
import { ScmNotice } from './ScmNotice'

type ReactFn = (subjectId: string | null, content: PrReaction, reacted: boolean) => void

function CommentRow({
  comment,
  busy,
  onReact,
  onEdit
}: {
  comment: PrComment
  busy: boolean
  onReact: ReactFn
  onEdit?: (commentId: string, body: string) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(comment.body)
  const id = comment.id ?? null
  return (
    <DiscussionEntry data-testid="pr-comment-row">
      <DiscussionActionsRow>
        <DiscussionAuthor>{comment.author}</DiscussionAuthor>
        {onEdit !== undefined && id !== null && (
          <ReviewButton
            type="button"
            data-testid={`pr-comment-edit-${id}`}
            disabled={busy}
            onClick={() => {
              setDraft(comment.body)
              setEditing((v) => !v)
            }}
            variant="discussion-edit-action"
          >
            Edit
          </ReviewButton>
        )}
      </DiscussionActionsRow>
      {editing ? (
        <DiscussionComposer>
          <TextArea surface="background"
            data-testid={`pr-comment-editor-${id}`}
            aria-label={`Edit comment by ${comment.author}`}
            rows={4}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}

          />
          <DiscussionActionsRow>
            <ReviewButton
              type="button"
              data-testid={`pr-comment-save-${id}`}
              disabled={busy || draft.trim().length === 0}
              onClick={() => {
                setEditing(false)
                if (id !== null) onEdit?.(id, draft)
              }}
              variant="primary-action"
            >
              Save
            </ReviewButton>
            <ReviewButton
              type="button"
              data-testid={`pr-comment-cancel-${id}`}
              onClick={() => setEditing(false)}
              variant="secondary-action"
            >
              Cancel
            </ReviewButton>
          </DiscussionActionsRow>
        </DiscussionComposer>
      ) : (
        <DiscussionBody>{comment.body}</DiscussionBody>
      )}
      <PrReactions
        reactions={comment.reactions}
        busy={busy}
        onToggle={(content, reacted) => onReact(id, content, reacted)}
      />
    </DiscussionEntry>
  )
}

function ThreadRow({
  thread,
  busy,
  allowResolve,
  resolveReason,
  number,
  onSendToOrchestrator,
  onReply,
  onResolve,
  onReact
}: {
  thread: PrThread
  busy: boolean
  allowResolve: boolean
  resolveReason: string | null
  number: number
  onSendToOrchestrator?: (text: string) => void
  onReply: (body: string) => void
  onResolve: (resolved: boolean) => void
  onReact: ReactFn
}): React.JSX.Element {
  const [reply, setReply] = useState('')
  return (
    <DiscussionEntry data-testid="pr-thread">
      <DiscussionThreadHeader>
        <DiscussionPath>
          {thread.path ?? 'a file'}
          {thread.line !== null && thread.line !== undefined ? `:${thread.line}` : ''}
        </DiscussionPath>
        {thread.outdated && <DiscussionMeta>outdated</DiscussionMeta>}
        <DiscussionMeta data-testid={`pr-thread-state-${thread.id}`} tone={thread.resolved ? 'ok' : 'faint'}>
          {thread.resolved ? 'resolved' : 'open'}
        </DiscussionMeta>
        <DiscussionResolveAction><Tooltip label={!allowResolve ? (resolveReason ?? undefined) : undefined}>
          <ReviewButton
            type="button"
            data-testid={`pr-thread-resolve-${thread.id}`}
            disabled={busy || !allowResolve}
            onClick={() => onResolve(!thread.resolved)}
            variant="compact-action"
          >
            <Icon glyph={thread.resolved ? IconRefresh : IconCheck} role="small" />
            {thread.resolved ? 'Reopen' : 'Resolve'}
          </ReviewButton>
        </Tooltip></DiscussionResolveAction>
      </DiscussionThreadHeader>
      {thread.comments.map((comment) => (
        <DiscussionCommentRow key={comment.id} data-testid="pr-thread-comment">
          <DiscussionCommentMetaRow>
            <DiscussionAuthor>{comment.author}</DiscussionAuthor>
            <DiscussionMeta align="end" data-testid="pr-thread-comment-time">
              {Math.max(0, Math.floor((Date.now() / 1000 - comment.created_at) / 60))}m
            </DiscussionMeta>
          </DiscussionCommentMetaRow>
          <DiscussionBody>{comment.body}</DiscussionBody>
          {onSendToOrchestrator && <ReviewButton variant="compact-action" type="button" onClick={() => onSendToOrchestrator(`PR #${number} · ${thread.path ?? 'review'}${thread.line ? `:${thread.line}` : ''}\n${comment.author}: ${comment.body}`)}>Send to orchestrator</ReviewButton>}
          <PrReactions
            reactions={comment.reactions}
            busy={busy}
            onToggle={(content, reacted) => onReact(comment.id, content, reacted)}
          />
        </DiscussionCommentRow>
      ))}
      <DiscussionComposer>
        <TextArea surface="background"
          data-testid={`pr-thread-reply-${thread.id}`}
          aria-label={`Reply to the thread on ${thread.path ?? 'a file'}`}
          rows={2}
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          placeholder="Reply to this discussion"

        />
        <DiscussionActionsRow>
          <ReviewButton
            type="button"
            data-testid={`pr-thread-reply-send-${thread.id}`}
            disabled={busy || reply.trim().length === 0}
            onClick={() => {
              onReply(reply)
              setReply('')
            }}
            variant="discussion-reply-action"
          >
            Reply
          </ReviewButton>
        </DiscussionActionsRow>
      </DiscussionComposer>
    </DiscussionEntry>
  )
}

export function PrThreads({
  detail,
  busy,
  number,
  onSendToOrchestrator,
  onReply,
  onResolve,
  onReact
}: {
  detail: PrDetail
  busy: boolean
  number: number
  onSendToOrchestrator?: (text: string) => void
  onReply: (threadId: string, body: string) => void
  onResolve: (threadId: string, resolved: boolean) => void
  onReact: ReactFn
}): React.JSX.Element {
  const resolveReason = detail.viewer
    ? detail.viewer.can_write || detail.viewer.did_author
      ? null
      : 'resolving needs write access or authorship'
    : 'permissions could not be read — refresh'
  return (
    <Disclosure
      summary="Discussions"
      count={detail.threads.length}
      defaultOpen={detail.threads.length > 0}
      scrollBody={false}
      variant="flush"
    >
      <DiscussionThreadList data-testid="pr-threads">
        {detail.threads_truncated && (
          <ScmNotice tone="info" testId="pr-threads-capped">
            GitHub had more discussions than this read carried.
          </ScmNotice>
        )}
        {detail.threads_message !== null && (
          <DiscussionErrorMessage data-testid="pr-threads-message">
            {detail.threads_message}
          </DiscussionErrorMessage>
        )}
        {detail.threads.map((thread) => (
          <ThreadRow
            key={thread.id}
            thread={thread}
            busy={busy}
            allowResolve={resolveReason === null}
            resolveReason={resolveReason}
            number={number}
            onSendToOrchestrator={onSendToOrchestrator}
            onReply={(body) => onReply(thread.id, body)}
            onResolve={(resolved) => onResolve(thread.id, resolved)}
            onReact={onReact}
          />
        ))}
      </DiscussionThreadList>
    </Disclosure>
  )
}

export function PrInspectorComments({
  detail,
  approvalsRequired,
  approvalsReceived,
  number,
  busy,
  onReply,
  onResolve,
  onSendToOrchestrator,
  issueComments
}: {
  detail: PrDetail
  approvalsRequired: number
  approvalsReceived: number
  number: number
  busy: boolean
  onReply: (threadId: string, body: string) => void
  onResolve: (threadId: string, resolved: boolean) => void
  onSendToOrchestrator?: (text: string) => void
  issueComments: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const [newestFirst, setNewestFirst] = useState(true)
  const [replyThread, setReplyThread] = useState<string | null>(null)
  const [reply, setReply] = useState('')
  const threads = detail.threads.filter((thread) => !thread.resolved)
  const comments = [
    ...detail.comments.map((comment) => ({ thread: null as PrThread | null, comment })),
    ...threads.flatMap((thread) => thread.comments.map((comment) => ({ thread, comment }))),
  ]
  comments.sort((a, b) => newestFirst
    ? b.comment.created_at - a.comment.created_at
    : a.comment.created_at - b.comment.created_at)
  const count = detail.comments_total + comments.length - detail.comments.length
  const resolveReason = detail.viewer?.can_write || detail.viewer?.did_author
    ? null
    : detail.viewer
      ? 'resolving needs write access or authorship'
      : 'permissions could not be read — refresh'

  return <PrTab as="section" surface="pr-inspector-comments-section" data-testid="pr-inspector-comments-section">
    <PrTab as="div" surface="pr-inspector-comments-sticky">
      <PrTab as="button" surface="pr-inspector-comments-toggle" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        Comments ({count}) <span aria-hidden="true">›</span>
      </PrTab>
      <PrTab as={Button} surface="pr-inspector-comments-sort" type="button" variant="ghost" size="sm" onClick={() => setNewestFirst((value) => !value)}>
        {newestFirst ? 'Newest first' : 'Oldest first'}
      </PrTab>
    </PrTab>
    {open && <PrTab as="div" surface="pr-inspector-comments-body">
      {detail.threads_truncated && <ScmNotice tone="info" testId="pr-threads-capped">GitHub had more discussions than this read carried.</ScmNotice>}
      {detail.threads_message !== null && <ScmNotice tone="danger" testId="pr-threads-message">{detail.threads_message}</ScmNotice>}
      <PrTab as="div" surface="pr-inspector-review" data-testid="pr-inspector-review">
        <PrTab as="div" surface="pr-inspector-section-caption" data-testid="pr-review-requirement">
          <span>Review · {approvalsRequired} approval{approvalsRequired === 1 ? '' : 's'} required</span>
          <PrTab as="span" surface="pr-inspector-review-count" data-review-count>{Math.min(approvalsReceived, approvalsRequired)} / {approvalsRequired}</PrTab>
        </PrTab>
        <PrTab as="div" surface="pr-inspector-comments">
        {comments.map(({ thread, comment }) => {
          const age = Math.max(0, Math.floor((Date.now() / 1000 - comment.created_at) / 60))
          const location = thread ? `${thread.path ?? 'a file'}${thread.line != null ? `:${thread.line}` : ''}` : 'conversation'
          const replyOpen = thread !== null && replyThread === thread.id
          return <PrTab as="article" surface="pr-inspector-comment" key={comment.id} data-testid="pr-inspector-comment">
            <PrTab as="div" surface="pr-inspector-comment-head">
              <PrTab as="span" surface="pr-inspector-comment-avatar" aria-hidden="true">{comment.author.slice(0, 1).toUpperCase()}</PrTab>
              <strong>{comment.author}</strong><span aria-hidden="true">·</span>
              <PrTab as="time" surface="pr-inspector-comment-age">{age}m ago</PrTab>
            </PrTab>
            <PrTab as="p" surface="pr-inspector-comment-body">{comment.body}</PrTab>
            <PrTab as="div" surface="pr-inspector-comment-links">
              {thread && <PrTab as="button" surface="pr-inspector-link" type="button" data-testid={`pr-thread-reply-open-${comment.id}`} onClick={() => { setReplyThread(replyOpen ? null : thread.id); setReply('') }}>Reply</PrTab>}
              {onSendToOrchestrator && <PrTab as="button" surface="pr-inspector-link" type="button" onClick={() => onSendToOrchestrator(`PR #${number} · ${location}\n${comment.author}: ${comment.body}`)}>Send to orchestrator</PrTab>}
            </PrTab>
            {replyOpen && thread && <PrTab as="div" surface="pr-inspector-reply">
              <textarea data-testid={`pr-thread-reply-${thread.id}`} aria-label={`Reply to the thread on ${thread.path ?? 'a file'}`} rows={2} value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Reply to this discussion" />
              <PrTab as="div" surface="pr-inspector-reply-actions">
                <Button variant="secondary" size="sm" data-testid={`pr-thread-reply-send-${thread.id}`} disabled={busy || reply.trim().length === 0} onClick={() => { onReply(thread.id, reply); setReply(''); setReplyThread(null) }}>Reply</Button>
                <Button variant="ghost" size="sm" onClick={() => setReplyThread(null)}>Cancel</Button>
              </PrTab>
            </PrTab>}
          </PrTab>
        })}
        </PrTab>
      </PrTab>
      {threads.length > 0 && <PrTab as="div" surface="pr-inspector-thread-actions">
        {threads.map((thread) => <Button key={thread.id} type="button" variant="ghost" size="sm" data-testid={`pr-thread-resolve-${thread.id}`} disabled={busy || resolveReason !== null} onClick={() => onResolve(thread.id, true)}>Resolve thread on {thread.path ?? 'a file'}</Button>)}
      </PrTab>}
      {issueComments}
    </PrTab>}
  </PrTab>
}

export function PrComments({
  detail,
  busy,
  onComment,
  onCommentEdit,
  onReact
}: {
  detail: PrDetail
  busy: boolean
  onComment: (body: string) => void
  onCommentEdit: (commentId: string, body: string) => void
  onReact: ReactFn
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  return (
    <Disclosure
      summary="Comments"
      count={detail.comments_total}
      scrollBody={false}
      variant="flush"
    >
      <DiscussionThreadList data-testid="pr-comments">
        {detail.comments.length < detail.comments_total && (
          <ScmNotice tone="info" testId="pr-comments-capped">
            Showing {detail.comments.length} of {detail.comments_total} comments — open on GitHub
            for the rest.
          </ScmNotice>
        )}
        {detail.comments.map((comment, index) => (
          <CommentRow
            key={comment.id ?? `${comment.author}-${index}`}
            comment={comment}
            busy={busy}
            onReact={onReact}
            onEdit={onCommentEdit}
          />
        ))}
        <DiscussionComposerPanel>
          <TextArea surface="background"
            data-testid="pr-comment-composer"
            aria-label="New comment"
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Write a comment"

          />
          <DiscussionActionsRow>
            <ReviewButton
              type="button"
              data-testid="pr-comment-send"
              disabled={busy || draft.trim().length === 0}
              onClick={() => {
                onComment(draft)
                setDraft('')
              }}
            variant="primary-action"
            >
              Comment
            </ReviewButton>
          </DiscussionActionsRow>
        </DiscussionComposerPanel>
      </DiscussionThreadList>
    </Disclosure>
  )
}
