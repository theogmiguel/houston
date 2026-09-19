import { useState } from 'react'
import type { PrComment, PrDetail, PrReaction, PrThread } from '../../houston/client'
import { BTN_GHOST, BTN_PRIMARY, BTN_SECONDARY } from '../buttonChrome'
import { Disclosure } from '../Disclosure'
import { Icon } from '../Icon'
import { Tooltip } from '../Tooltip'
import { IconCheck, IconRefresh } from '../icons'
import { PrReactions } from './PrPickers'
import { ScmNotice } from './ScmNotice'

const SMALL = 'text-[length:var(--tr-text-small-size)]'
const ACTION = 'inline-flex items-center gap-1.5'
const ROW = 'flex flex-col gap-1 px-3 py-2 border-t border-t-[var(--divider)] first:border-t-0'
const BODY = `${SMALL} text-[var(--text-secondary)] whitespace-pre-wrap break-words`
const META = `${SMALL} text-[var(--text-faint)]`
const TEXTAREA =
  'w-full resize-none rounded-[var(--tr-radius-input)] border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 ' +
  'text-[length:var(--tr-text-small-size)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] ' +
  'focus-visible:outline-none focus-visible:border-[var(--border-focus)]'

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
    <div className={ROW} data-testid="pr-comment-row">
      <div className="flex items-center gap-2">
        <span className={`${SMALL} [font-weight:var(--tr-text-small-weight)] text-[var(--text-primary)]`}>
          {comment.author}
        </span>
        {onEdit !== undefined && id !== null && (
          <button
            type="button"
            data-testid={`pr-comment-edit-${id}`}
            disabled={busy}
            onClick={() => {
              setDraft(comment.body)
              setEditing((v) => !v)
            }}
            className={`btn ${BTN_GHOST} ${ACTION} h-[var(--h-ctl-mini)] px-1 ${SMALL} text-[var(--text-muted)] disabled:opacity-55`}
          >
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <div className="flex flex-col gap-1.5">
          <textarea
            data-testid={`pr-comment-editor-${id}`}
            aria-label={`Edit comment by ${comment.author}`}
            rows={4}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className={TEXTAREA}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid={`pr-comment-save-${id}`}
              disabled={busy || draft.trim().length === 0}
              onClick={() => {
                setEditing(false)
                if (id !== null) onEdit?.(id, draft)
              }}
              className={`btn ${ACTION} ${BTN_PRIMARY} disabled:opacity-55`}
            >
              Save
            </button>
            <button
              type="button"
              data-testid={`pr-comment-cancel-${id}`}
              onClick={() => setEditing(false)}
              className={`btn ${ACTION} ${BTN_SECONDARY}`}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <span className={BODY}>{comment.body}</span>
      )}
      <PrReactions
        reactions={comment.reactions}
        busy={busy}
        onToggle={(content, reacted) => onReact(id, content, reacted)}
      />
    </div>
  )
}

function ThreadRow({
  thread,
  busy,
  allowResolve,
  resolveReason,
  onReply,
  onResolve,
  onReact
}: {
  thread: PrThread
  busy: boolean
  allowResolve: boolean
  resolveReason: string | null
  onReply: (body: string) => void
  onResolve: (resolved: boolean) => void
  onReact: ReactFn
}): React.JSX.Element {
  const [reply, setReply] = useState('')
  return (
    <div className={ROW} data-testid="pr-thread">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`font-mono ${SMALL} text-[var(--text-primary)] break-all`}>
          {thread.path ?? 'a file'}
          {thread.line !== null && thread.line !== undefined ? `:${thread.line}` : ''}
        </span>
        {thread.outdated && <span className={META}>outdated</span>}
        <span
          data-testid={`pr-thread-state-${thread.id}`}
          className={thread.resolved ? `${META} text-[var(--ok)]` : META}
        >
          {thread.resolved ? 'resolved' : 'open'}
        </span>
        <Tooltip label={!allowResolve ? (resolveReason ?? undefined) : undefined} className="ml-auto">
          <button
            type="button"
            data-testid={`pr-thread-resolve-${thread.id}`}
            disabled={busy || !allowResolve}
            onClick={() => onResolve(!thread.resolved)}
            className={`btn ${BTN_GHOST} ${ACTION} h-[var(--h-ctl-mini)] px-1.5 ${SMALL} text-[var(--text-muted)] disabled:opacity-55`}
          >
            <Icon glyph={thread.resolved ? IconRefresh : IconCheck} role="small" />
            {thread.resolved ? 'Reopen' : 'Resolve'}
          </button>
        </Tooltip>
      </div>
      {thread.comments.map((comment) => (
        <div key={comment.id} className="flex flex-col gap-0.5" data-testid="pr-thread-comment">
          <span className={`${SMALL} [font-weight:var(--tr-text-small-weight)] text-[var(--text-primary)]`}>
            {comment.author}
          </span>
          <span className={BODY}>{comment.body}</span>
          <PrReactions
            reactions={comment.reactions}
            busy={busy}
            onToggle={(content, reacted) => onReact(comment.id, content, reacted)}
          />
        </div>
      ))}
      <div className="flex flex-col gap-1.5">
        <textarea
          data-testid={`pr-thread-reply-${thread.id}`}
          aria-label={`Reply to the thread on ${thread.path ?? 'a file'}`}
          rows={2}
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          placeholder="Reply to this discussion"
          className={TEXTAREA}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid={`pr-thread-reply-send-${thread.id}`}
            disabled={busy || reply.trim().length === 0}
            onClick={() => {
              onReply(reply)
              setReply('')
            }}
            className={`btn ${ACTION} ${BTN_SECONDARY} disabled:opacity-55`}
          >
            Reply
          </button>
        </div>
      </div>
    </div>
  )
}

export function PrThreads({
  detail,
  busy,
  onReply,
  onResolve,
  onReact
}: {
  detail: PrDetail
  busy: boolean
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
      scrollBody={false}
      className="rounded-none border-0 bg-transparent"
    >
      <div className="flex flex-col" data-testid="pr-threads">
        {detail.threads_truncated && (
          <ScmNotice tone="info" testId="pr-threads-capped">
            GitHub had more discussions than this read carried.
          </ScmNotice>
        )}
        {detail.threads_message !== null && (
          <div
            className={`px-3 py-1.5 ${SMALL} text-[var(--danger)] break-words [overflow-wrap:anywhere]`}
            data-testid="pr-threads-message"
          >
            {detail.threads_message}
          </div>
        )}
        {detail.threads.map((thread) => (
          <ThreadRow
            key={thread.id}
            thread={thread}
            busy={busy}
            allowResolve={resolveReason === null}
            resolveReason={resolveReason}
            onReply={(body) => onReply(thread.id, body)}
            onResolve={(resolved) => onResolve(thread.id, resolved)}
            onReact={onReact}
          />
        ))}
      </div>
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
      className="rounded-none border-0 bg-transparent"
    >
      <div className="flex flex-col" data-testid="pr-comments">
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
        <div className="flex flex-col gap-1.5 p-3 border-t border-t-[var(--divider)]">
          <textarea
            data-testid="pr-comment-composer"
            aria-label="New comment"
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Write a comment"
            className={TEXTAREA}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="pr-comment-send"
              disabled={busy || draft.trim().length === 0}
              onClick={() => {
                onComment(draft)
                setDraft('')
              }}
              className={`btn ${ACTION} ${BTN_PRIMARY} disabled:opacity-55`}
            >
              Comment
            </button>
          </div>
        </div>
      </div>
    </Disclosure>
  )
}
