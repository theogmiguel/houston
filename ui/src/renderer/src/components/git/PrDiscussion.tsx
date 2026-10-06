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
              variant="discussion-submit-action"
            >
              Save
            </ReviewButton>
            <ReviewButton
              type="button"
              data-testid={`pr-comment-cancel-${id}`}
              onClick={() => setEditing(false)}
              variant="discussion-cancel-action"
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
            variant="discussion-submit-action"
            >
              Comment
            </ReviewButton>
          </DiscussionActionsRow>
        </DiscussionComposerPanel>
      </DiscussionThreadList>
    </Disclosure>
  )
}
