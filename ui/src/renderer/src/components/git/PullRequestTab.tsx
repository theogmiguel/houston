import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  GhState,
  HoustonClient,
  PrCheck,
  PrCheckState,
  PrDetail,
  PrMergeMethod,
  PrReviewDraft,
  PrReviewVerdict,
  PullRequestLink,
  PullRequestState
} from '../../houston/client'
import { BTN_GHOST, BTN_PRIMARY, BTN_SECONDARY } from '../buttonChrome'
import { Segmented } from '../Segmented'
import { META_ROW_CLS, SCM_CARD_ATTRS, SCM_CARD_CLS, SECTION_HEAD_CLS } from './scmChrome'
import { ScmNotice } from './ScmNotice'
import { Disclosure } from '../Disclosure'
import { Icon } from '../Icon'
import { IconLoaderCircle, IconPencil, IconSparkles } from '../icons'
import { Tooltip } from '../Tooltip'
import { prDecisionLabel } from './changes'
import { SPIN_CLASS } from './DiffBody'
import { PrBrowse } from './PrBrowse'
import { PrComments, PrThreads } from './PrDiscussion'
import { PrFiles } from './PrFiles'
import { PrEmptyStates } from './PrEmptyStates'
import { PrComposeModal } from './PrComposeModal'
import { PrLabelPicker, PrReactions, PrReviewerPicker } from './PrPickers'
import { PrReviewBar } from './PrReviewBar'
import { PrSummary } from './PrSummary'
import { PrStackSection } from './PrStack'
import { PrFooterBar } from './PrFooterBar'
import {
  usePrDetail,
  usePrList,
  type PrDetailController,
  type PrDetailView
} from './usePrDetailSubscription'
import { useGitWriter, type GitWriter } from './useGitWriter'

export interface PullRequestTabProps {
  client: HoustonClient | null
  dir: string | null
  onOpenUrlInPane?: (url: string) => void
  onShowChanges?: () => void
  active?: boolean
  onPrPresenceChange?: (exists: boolean, tone?: PrPresenceTone) => void
  /** A changing counter from the panel header's Refresh; re-reads the detail. */
  refreshSignal?: number
}

export type PrPresenceTone = 'ok' | 'warn' | 'stop'

/** A PR number is a positive u32; the wire refuses anything wider. */
export const PR_NUMBER_MAX = 4_294_967_295

const EMPTY = 'flex-1 min-h-0 flex flex-col items-center justify-center gap-2 p-6 text-center'
const TITLE =
  'text-[length:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-[var(--text-primary)]'
const HINT = 'text-[length:var(--tr-text-small-size)] text-[var(--text-muted)] max-w-[46ch]'
const ERROR_LINE =
  'text-[length:var(--tr-text-small-size)] text-[var(--danger)] break-words [overflow-wrap:anywhere]'
const SECTION_HEAD = 'flex flex-col gap-1.5 p-3'
const ACTION = 'inline-flex items-center gap-1.5'
const SMALL = 'text-[length:var(--tr-text-small-size)]'
const ROW = 'flex flex-col gap-0.5 px-3 py-1.5 border-t border-t-[var(--divider)] first:border-t-0'
const META_DANGER_GROUND = 'bg-[color-mix(in_srgb,var(--danger)_7%,transparent)]'
const META_DANGER_INK = 'text-[color-mix(in_srgb,var(--danger)_88%,var(--text-primary))]'
const INPUT =
  'h-[var(--h-ctl)] px-2 rounded-[var(--tr-radius-input)] border border-[var(--border)] bg-[var(--content-bg)] ' +
  `${SMALL} text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus-visible:outline-none focus-visible:border-[var(--border-focus)]`
const TEXTAREA =
  'w-full resize-none rounded-[var(--tr-radius-input)] border border-[var(--border)] bg-[var(--content-bg)] px-2 py-1.5 ' +
  `${SMALL} text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus-visible:outline-none focus-visible:border-[var(--border-focus)]`

const STATE_PILL: Record<PullRequestState, string> = {
  open: 'bg-[color-mix(in_srgb,var(--ok)_16%,transparent)] text-[var(--ok)]',
  merged: 'bg-[color-mix(in_srgb,var(--info)_16%,transparent)] text-[var(--info)]',
  closed: 'bg-[color-mix(in_srgb,var(--text-muted)_18%,transparent)] text-[var(--text-muted)]'
}
const DRAFT_PILL = 'bg-[color-mix(in_srgb,var(--warn)_18%,transparent)] text-[var(--warn)]'

const CHECK_DOT: Record<PrCheckState, string> = {
  passing: 'bg-[var(--ok)]',
  running: 'bg-[var(--warn)]',
  queued: 'bg-[var(--warn)]',
  failing: 'bg-[var(--danger)]',
  skipped: 'bg-[var(--text-faint)]',
  unknown: 'bg-[var(--warn)]'
}

const CHECK_LABEL: Record<PrCheckState, string> = {
  passing: 'passed',
  running: 'running',
  queued: 'queued',
  failing: 'failed',
  skipped: 'skipped',
  unknown: 'unknown'
}

const CHECK_PRIORITY: Record<PrCheckState, number> = {
  failing: 0,
  running: 1,
  queued: 2,
  unknown: 3,
  passing: 4,
  skipped: 5
}

const REVIEW_LABEL: Record<string, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
  PENDING: 'pending'
}

/** Returns null for anything that is not a positive integer within u32. */
export function parsePrNumber(raw: string): number | null {
  const trimmed = raw.trim()
  if (!/^[1-9][0-9]*$/.test(trimmed)) return null
  const value = Number.parseInt(trimmed, 10)
  if (!Number.isSafeInteger(value) || value > PR_NUMBER_MAX) return null
  return value
}

export function stateLabel(link: PullRequestLink): string {
  if (link.is_draft && link.state === 'open') return 'Draft'
  return link.state.charAt(0).toUpperCase() + link.state.slice(1)
}

export function stateTone(link: PullRequestLink): string {
  return link.is_draft && link.state === 'open' ? DRAFT_PILL : STATE_PILL[link.state]
}

function prPresenceTone(view: PrDetailView | null): PrPresenceTone {
  if (!view?.link) return 'ok'
  if (view.link.checks === 'failing' || view.detail?.checks.some((check) => check.state === 'failing')) {
    return 'stop'
  }
  if (
    view.link.checks === 'running' ||
    view.detail?.checks.some(
      (check) => check.state === 'running' || check.state === 'queued' || check.state === 'unknown'
    )
  ) {
    return 'warn'
  }
  return view.link.is_draft && view.link.state === 'open' ? 'warn' : 'ok'
}

/** The mock's right column: a real duration when gh carried one, else state. */
export function checkMeta(check: PrCheck): string {
  if (check.duration_ms === null || check.duration_ms === undefined) {
    return CHECK_LABEL[check.state]
  }
  const seconds = Math.round(check.duration_ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export function reviewLabel(decision: string | null | undefined): string {
  if (decision === null || decision === undefined) return 'No review yet'
  return prDecisionLabel(decision) ?? decision
}

function PrIdle(): React.JSX.Element {
  return (
    <PrEmptyStates
      testId="pr-idle"
      headline="No workspace selected"
      description="Select a workspace to see its pull request."
    />
  )
}

function PrBlocked({
  gh,
  hint,
  onRetry
}: {
  gh: GhState
  hint: string | null
  onRetry: () => void
}): React.JSX.Element {
  const headline = gh === 'missing' ? 'GitHub CLI not found' : 'GitHub CLI needs authentication'
  const body =
    hint ??
    (gh === 'missing' ? (
      <>
        <span className="font-mono">gh</span> is not on PATH, so Houston cannot read pull requests. Install it and press
        Retry — nothing else in source control depends on it.
      </>
    ) : (
      'gh is not authenticated, so Houston cannot read pull requests.'
    ))
  return (
    <div className={EMPTY} data-testid="pr-detail-blocked">
      <div className={TITLE}>{headline}</div>
      <p className={HINT}>{body}</p>
      <button className={`btn ${ACTION} ${BTN_SECONDARY}`} data-testid="pr-retry" onClick={onRetry}>
        Retry
      </button>
    </div>
  )
}

function PrLinkForm({ pr }: { pr: PrDetailController }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const parsed = parsePrNumber(draft)
  const invalid = draft.trim() !== '' && parsed === null
  return (
    <div className="flex flex-col gap-1">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (parsed !== null) pr.link(parsed)
        }}
      >
        <input
          data-testid="pr-link-number"
          aria-label="Pull request number"
          inputMode="numeric"
          placeholder="Number"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className={`${INPUT} w-[96px]`}
        />
        <button
          type="submit"
          className={`btn ${ACTION} ${BTN_SECONDARY}`}
          data-testid="pr-link"
          disabled={parsed === null || pr.linkBusy}
        >
          Link pull request
        </button>
      </form>
      {invalid && (
        <div className={ERROR_LINE} data-testid="pr-link-invalid">
          A pull request number is 1-{PR_NUMBER_MAX}.
        </div>
      )}
    </div>
  )
}

function PrRetryRow({
  pr,
  view
}: {
  pr: PrDetailController
  view: PrDetailView
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <button
        className={`btn ${ACTION} ${BTN_SECONDARY}`}
        data-testid="pr-retry"
        onClick={pr.refresh}
      >
        Retry
      </button>
      {view.linked && (
        <button
          className={`btn ${ACTION} ${BTN_SECONDARY}`}
          data-testid="pr-unlink"
          disabled={pr.linkBusy}
          onClick={pr.unlink}
        >
          Unlink
        </button>
      )}
    </div>
  )
}

function PrDescription({ body }: { body: string | null | undefined }): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  if (body === null || body === undefined || body.length === 0) return null
  return (
    <>
      <p className={`text-[length:var(--tr-text-body-size)] text-[var(--text-secondary)] whitespace-pre-wrap break-words ${expanded ? '' : 'line-clamp-4'}`}>
        {body}
      </p>
      {body.length > 240 && (
        <button
          type="button"
          className={`btn ${BTN_GHOST} ${ACTION} h-[var(--h-ctl-mini)] self-start px-[var(--space-1)] text-[var(--text-muted)]`}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  )
}

function PrEmpty({
  view,
  pr,
  onShowChanges,
  onBrowse,
  linkMessage,
  writer,
  offered
}: {
  view: PrDetailView
  pr: PrDetailController
  onShowChanges?: () => void
  onBrowse: () => void
  linkMessage: React.ReactNode
  writer: GitWriter
  offered: boolean
}): React.JSX.Element {
  return (
    <div className={SECTION_HEAD} data-testid="pr-detail-empty">
      {view.message !== null ? (
        <>
          <div className={ERROR_LINE} data-testid="pr-message">
            {view.message}
          </div>
          <PrRetryRow pr={pr} view={view} />
        </>
      ) : (
        <>
          <div className={TITLE}>No pull request</div>
          <p className={HINT}>
            {view.hasUpstream
              ? 'This branch has no pull request yet.'
              : 'This branch has no upstream, so it cannot have a pull request yet.'}
          </p>
          <div className="flex items-center gap-2">
            <Tooltip
              label={view.hasUpstream ? undefined : 'This branch has no upstream, so it cannot have a pull request yet.'}
              className="inline-flex"
            >
              <button
                className={`btn ${ACTION} ${BTN_PRIMARY} disabled:opacity-45 disabled:cursor-not-allowed`}
                data-testid="pr-create"
                disabled={!view.hasUpstream || pr.createBusy}
                onClick={pr.create}
              >
                {pr.createBusy ? 'Creating…' : 'Create pull request'}
              </button>
            </Tooltip>
            <Tooltip label="Write the title and body with AI">
              <button
                type="button"
                className={`btn ${BTN_GHOST}`}
                data-testid="pr-create-ai"
                aria-label="Write the pull request with AI"
                disabled={!offered || writer.compose.creating}
                onClick={writer.openCompose}
              >
                <Icon glyph={IconSparkles} role="small" />
              </button>
            </Tooltip>
          </div>
          {!view.hasUpstream && onShowChanges && (
            <div>
              <button
                className={`btn ${ACTION} ${BTN_SECONDARY}`}
                data-testid="pr-show-changes"
                onClick={onShowChanges}
              >
                Changes
              </button>
            </div>
          )}
        </>
      )}
      {view.message === null ? (
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`${SMALL} text-[var(--text-muted)]`}>or link an existing one</span>
          <PrLinkForm pr={pr} />
          <button
            className={`btn ${ACTION} ${BTN_GHOST}`}
            data-testid="pr-browse-open"
            onClick={onBrowse}
          >
            Browse…
          </button>
        </div>
      ) : (
        <button
          className={`btn ${ACTION} ${BTN_GHOST}`}
          data-testid="pr-browse-open"
          onClick={onBrowse}
        >
          Browse…
        </button>
      )}
      {linkMessage}
      {pr.createMessage !== null && (
        <div className={ERROR_LINE} data-testid="pr-create-message">
          {pr.createMessage}
        </div>
      )}
      {writer.compose.open && offered && (
        <PrComposeModal
          base={null}
          generating={writer.compose.generating}
          creating={writer.compose.creating}
          error={writer.compose.error}
          initialTitle={writer.compose.title}
          initialBody={writer.compose.body}
          onGenerate={writer.generatePrContent}
          onCreate={writer.createComposedPr}
          onCancel={writer.cancelCompose}
        />
      )}
    </div>
  )
}

function PrReadError({
  view,
  link,
  pr,
  linkMessage
}: {
  view: PrDetailView
  link: PullRequestLink
  pr: PrDetailController
  linkMessage: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={SECTION_HEAD} data-testid="pr-detail-error">
      <div className={ERROR_LINE} data-testid="pr-message">
        {view.message ?? `Pull request #${link.number} could not be read; refresh to try again.`}
      </div>
      <PrRetryRow pr={pr} view={view} />
      {linkMessage}
    </div>
  )
}

/** Title, branch pair, and the edit form that rewrites them. */
function PrHeader({
  link,
  detail,
  busy,
  editBusy,
  onEdit,
  onReact
}: {
  link: PullRequestLink
  detail: PrDetail
  busy: boolean
  editBusy: boolean
  onEdit: (title: string, body: string) => void
  onReact: (content: PrDetail['reactions'][number]['content'], reacted: boolean) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(link.title ?? `Pull request #${link.number}`)
  const [body, setBody] = useState(detail.body ?? '')
  const head = detail.head_ref ?? null
  const base = detail.base_ref ?? null
  const branchPair = head !== null && base !== null ? `${head} → ${base}` : null
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <span
          data-testid="pr-state"
          className={`flex-none px-1.5 rounded-[var(--tr-radius-pill)] text-[length:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] uppercase tracking-[0.1em] leading-4 ${stateTone(link)}`}
        >
          {stateLabel(link)}
        </span>
        <div className="min-w-0 flex flex-col gap-0.5">
          <div
            data-testid="pr-title"
            className="text-[length:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-[var(--text-primary)] break-words"
          >
            {link.title ?? `Pull request #${link.number}`}
          </div>
          <div
            data-testid="pr-sub"
            className={`font-mono ${SMALL} text-[var(--text-faint)] break-words`}
          >
            #{link.number}
            {branchPair ? ` · ${branchPair}` : ''} ·{' '}
            {detail.commit_count === 1 ? '1 commit' : `${detail.commit_count} commits`}
            {detail.behind_by !== null && detail.behind_by !== undefined
              ? detail.behind_by === 0
                ? ' · up to date'
                : ` · ${detail.behind_by} behind`
              : ''}
            {detail.auto_merge_enabled === true
              ? ` · auto-merge ${detail.auto_merge_method ?? 'merge'}`
              : ''}
          </div>
        </div>
        <Tooltip label="Edit title and description">
          <button
            type="button"
            data-testid="pr-edit-open"
            disabled={busy}
            onClick={() => {
              setTitle(link.title ?? '')
              setBody(detail.body ?? '')
              setEditing((v) => !v)
            }}
            className={`btn ${BTN_GHOST} ${ACTION} h-[var(--h-ctl-mini)] px-1.5 ml-auto text-[var(--text-muted)] disabled:opacity-55`}
          >
            <Icon glyph={IconPencil} role="small" />
          </button>
        </Tooltip>
      </div>
      {editing ? (
        <div className="flex flex-col gap-1.5" data-testid="pr-edit-form">
          <input
            data-testid="pr-edit-title"
            aria-label="Pull request title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={`${INPUT} w-full`}
          />
          <textarea
            data-testid="pr-edit-body"
            aria-label="Pull request description"
            rows={5}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className={TEXTAREA}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="pr-edit-save"
              disabled={editBusy || title.trim().length === 0}
              onClick={() => {
                setEditing(false)
                onEdit(title, body)
              }}
              className={`btn ${ACTION} ${BTN_PRIMARY} disabled:opacity-55`}
            >
              Save
            </button>
            <button
              type="button"
              data-testid="pr-edit-cancel"
              onClick={() => setEditing(false)}
              className={`btn ${ACTION} ${BTN_SECONDARY}`}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <PrDescription body={detail.body} />
      )}
      {!editing && (
        <PrReactions reactions={detail.reactions} busy={busy} onToggle={onReact} />
      )}
    </div>
  )
}

function PrCheckRow({ check }: { check: PrCheck }): React.JSX.Element {
  return (
    <div
      data-testid="pr-check-row"
      className={`flex items-center gap-2 h-[var(--h-row)] px-2.5 ${SMALL} border-t border-t-[var(--divider)] first:border-t-0`}
    >
      <span className={`flex-none w-[7px] h-[7px] rounded-full ${CHECK_DOT[check.state]}`} />
      <span className="flex-1 min-w-0 truncate text-[var(--text-primary)]">{check.name}</span>
      <span className={`flex-none font-mono ${SMALL} text-[var(--text-faint)]`}>
        {checkMeta(check)}
      </span>
    </div>
  )
}

function checkSummary(checks: PrCheck[]): { text: string; tone: string } {
  const running = checks.filter((check) => check.state === 'running' || check.state === 'queued' || check.state === 'unknown').length
  const passed = checks.filter((check) => check.state === 'passing').length
  const failed = checks.filter((check) => check.state === 'failing').length
  const parts = [
    failed > 0 ? `${failed} failed` : '',
    running > 0 ? `${running} running` : '',
    passed > 0 ? `${passed} passed` : ''
  ].filter(Boolean)
  const tone = failed > 0 ? 'bg-[var(--stop)]' : running > 0 ? 'bg-[var(--warn)]' : checks.length > 0 ? 'bg-[var(--ok)]' : 'bg-[var(--text-faint)]'
  return { text: parts.length > 0 ? parts.join(', ') : 'No checks reported', tone }
}

function PrChecks({ checks }: { checks: PrCheck[] }): React.JSX.Element {
  const summary = checkSummary(checks)
  const ordered = [...checks].sort((left, right) => CHECK_PRIORITY[left.state] - CHECK_PRIORITY[right.state])
  return (
    <div data-testid="pr-checks">
      <Disclosure
        className="rounded-none border-0 bg-transparent"
        scrollBody={false}
        summary={
          <span className="flex items-center gap-[var(--space-2)]">
            <span className={`h-[7px] w-[7px] rounded-full ${summary.tone}`} />
            <span>{summary.text}</span>
            <span className="text-[var(--text-muted)]">· Details</span>
          </span>
        }
      >
        {checks.length === 0 ? (
          <div className={`${SMALL} text-[var(--text-muted)]`}>No checks reported.</div>
        ) : (
          ordered.map((check, index) => <PrCheckRow key={`${check.name}-${index}`} check={check} />)
        )}
      </Disclosure>
    </div>
  )
}

function PrMeta({
  link,
  detail,
  mergeReason
}: {
  link: PullRequestLink
  detail: PrDetail
  mergeReason: string | null
}): React.JSX.Element {
  return (
    <div>
      <div className={META_ROW_CLS}>
        <span className="w-[92px] flex-none text-[var(--text-muted)]">Review</span>
        <span className="min-w-0 flex-1 text-[var(--text-primary)]">{reviewLabel(link.review_decision)}</span>
      </div>
      <div className={`${META_ROW_CLS} ${mergeReason !== null ? META_DANGER_GROUND : ''}`}>
        <span className="w-[92px] flex-none text-[var(--text-muted)]">Mergeable</span>
        <span className={`min-w-0 flex-1 ${mergeReason !== null ? META_DANGER_INK : 'text-[var(--text-primary)]'}`} data-testid="pr-merge-reason">
          {mergeReason ?? 'Ready to merge'}
        </span>
      </div>
      {detail.viewer_message !== null && detail.viewer_message !== undefined && (
        <div className={`${META_ROW_CLS} ${META_DANGER_GROUND}`}>
          <span className="w-[92px] flex-none text-[var(--text-muted)]">Permissions</span>
          <span className={`${ERROR_LINE} ${META_DANGER_INK} min-w-0 flex-1`} data-testid="pr-viewer-message">
            {detail.viewer_message}
          </span>
        </div>
      )}
    </div>
  )
}

function PrReviews({ detail }: { detail: PrDetail }): React.JSX.Element {
  return (
    <Disclosure
      summary="Reviews"
      count={detail.reviews_total}
      scrollBody={false}
      className="rounded-none border-0 bg-transparent"
    >
      <div className="flex flex-col" data-testid="pr-reviews">
        {detail.reviews.map((review, index) => (
          <div key={`${review.id ?? review.author}-${index}`} data-testid="pr-review-row" className={ROW}>
            <span className={`${SMALL} text-[var(--text-primary)]`}>
              {review.author} · {REVIEW_LABEL[review.state] ?? review.state.toLowerCase()}
            </span>
            {review.body.length > 0 && (
              <span
                className={`${SMALL} text-[var(--text-muted)] whitespace-pre-wrap break-words line-clamp-3`}
              >
                {review.body}
              </span>
            )}
          </div>
        ))}
      </div>
    </Disclosure>
  )
}

function PrNotices({
  pr,
  linkMessage
}: {
  pr: PrDetailController
  linkMessage: React.ReactNode
}): React.JSX.Element {
  return (
    <>
      {pr.mergeMessage !== null && (
        <ScmNotice tone="danger" testId="pr-merge-message">
          {pr.mergeMessage}
        </ScmNotice>
      )}
      {pr.write.message !== null && (
        <ScmNotice tone="danger" testId="pr-write-message">
          {pr.write.message}
        </ScmNotice>
      )}
      {pr.write.notice !== null && (
        <ScmNotice tone="info" testId="pr-write-notice">
          {pr.write.notice}
        </ScmNotice>
      )}
      {linkMessage}
      {pr.createMessage !== null && (
        <ScmNotice tone="danger" testId="pr-create-message">
          {pr.createMessage}
        </ScmNotice>
      )}
    </>
  )
}

function PrDetailView({
  view,
  link,
  detail,
  pr,
  method,
  setMethod,
  onOpenUrlInPane,
  onBrowse,
  linkMessage
}: {
  view: PrDetailView
  link: PullRequestLink
  detail: PrDetail
  pr: PrDetailController
  method: PrMergeMethod
  setMethod: (method: PrMergeMethod) => void
  onOpenUrlInPane?: (url: string) => void
  onBrowse: () => void
  linkMessage: React.ReactNode
}): React.JSX.Element {
  const [pane, setPane] = useState<'summary' | 'files'>('summary')
  const [drafts, setDrafts] = useState<PrReviewDraft[]>([])
  const [reviewVerdict, setReviewVerdict] = useState<PrReviewVerdict>('comment')
  const [reviewBody, setReviewBody] = useState('')
  const [reviewDraftsOpen, setReviewDraftsOpen] = useState(false)
  const [openPicker, setOpenPicker] = useState<'reviewers' | 'labels' | 'stack' | null>(null)
  const mergeReason = detail.merge_disabled_reason ?? null
  const busy = pr.write.busy !== null
  const number = link.number

  // A different pull request is a different review: drafts never travel with a
  // subject change.
  useEffect(() => {
    setDrafts([])
    setPane('summary')
    setReviewVerdict('comment')
    setReviewBody('')
    setReviewDraftsOpen(false)
    setOpenPicker(null)
  }, [number])

  const paneRef = useRef(pane)
  paneRef.current = pane
  useEffect(() => {
    if (paneRef.current === 'files') pr.loadDiff(number)
    // The reload belongs to the subject changing; switching panes loads on the
    // click itself, so the diff reply does not re-trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [number])

  const addDraft = (draft: PrReviewDraft): void => {
    setDrafts((prev) => {
      const key = `${draft.path}:${draft.side}:${draft.line}`
      const rest = prev.filter((d) => `${d.path}:${d.side}:${d.line}` !== key)
      return [...rest, draft]
    })
  }

  const removeDraft = (draft: PrReviewDraft): void => {
    setDrafts((prev) =>
      prev.filter((d) => `${d.path}:${d.side}:${d.line}` !== `${draft.path}:${draft.side}:${draft.line}`)
    )
  }

  const reviewBar = (
    <PrReviewBar
      detail={detail}
      busy={busy}
      drafts={drafts}
      onRemoveDraft={removeDraft}
      verdict={reviewVerdict}
      onVerdictChange={setReviewVerdict}
      body={reviewBody}
      onBodyChange={setReviewBody}
      draftsOpen={reviewDraftsOpen}
      onDraftsOpenChange={setReviewDraftsOpen}
      disclosure={pane === 'summary'}
      onSubmit={(verdict, body) => {
        pr.review(number, verdict, body, drafts)
        setDrafts([])
        setReviewBody('')
      }}
    />
  )

  const actionBar = (
    <PrFooterBar
      link={link}
      detail={detail}
      pr={pr}
      linked={view.linked}
      method={method}
      setMethod={setMethod}
      onOpenUrlInPane={onOpenUrlInPane}
      mergeReason={mergeReason}
    />
  )

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="pr-tab">
      <div className="flex-none flex items-center gap-[var(--space-2)] px-[var(--space-2-5)] py-[var(--space-1-5)] border-b border-b-[var(--divider)]">
        <Segmented
          aria-label="Pull request view"
          value={pane}
          onChange={(value) => {
            setPane(value)
            if (value === 'files') pr.loadDiff(number)
          }}
          options={[
            { value: 'summary', label: 'Summary', testId: 'pr-pane-summary' },
            { value: 'files', label: 'Files', testId: 'pr-pane-files' }
          ]}
        />
        <button
          type="button"
          data-testid="pr-browse-open"
          onClick={onBrowse}
          className={`btn ${BTN_GHOST} ${ACTION} h-[var(--h-ctl-mini)] px-1.5 ${SMALL} text-[var(--text-muted)]`}
        >
          Browse…
        </button>
        {pr.viewed !== null && (
          <span className={`${SMALL} text-[var(--text-muted)]`} data-testid="pr-browsed">
            Viewing #{pr.viewed}, not this branch's pull request
          </span>
        )}
        {pr.viewed !== null && (
          <button
            type="button"
            data-testid="pr-back-to-branch"
            onClick={pr.showBranch}
            className={`btn ${BTN_SECONDARY}`}
          >
            Back
          </button>
        )}
        <span className={`ml-auto font-mono ${SMALL} text-[var(--text-faint)]`}>
          {detail.mergeable === 'conflicting' ? 'conflicts' : ''}
        </span>
      </div>
      <PrNotices pr={pr} linkMessage={linkMessage} />
      <div className="flex-1 min-h-0 overflow-y-auto [scrollbar-width:thin]">
        {pane === 'files' ? (
          <div className="flex flex-col gap-2.5 p-3">
            <PrFiles
              diff={pr.diff}
              loading={pr.diffBusy}
              drafts={drafts}
              writeBusy={busy}
              onAddDraft={addDraft}
              onReload={() => pr.loadDiff(number)}
            />
          </div>
        ) : (
          <PrSummary>
            <div className={SCM_CARD_CLS} {...SCM_CARD_ATTRS}>
              <PrHeader
                link={link}
                detail={detail}
                busy={busy}
                editBusy={pr.write.busy === `edit:${number}`}
                onEdit={(title, body) => pr.edit(number, title, body)}
                onReact={(content, reacted) => pr.react(number, null, content, reacted)}
              />
            </div>
            <div className={SCM_CARD_CLS} {...SCM_CARD_ATTRS}>
              <div className={SECTION_HEAD_CLS}>Status</div>
              <PrChecks checks={detail.checks} />
              <PrMeta link={link} detail={detail} mergeReason={mergeReason} />
            </div>
            <div className={SCM_CARD_CLS} {...SCM_CARD_ATTRS}>
              <div className={SECTION_HEAD_CLS}>People &amp; labels</div>
              <PrReviewerPicker
                detail={detail}
                busy={busy}
                candidates={pr.reviewers}
                loading={pr.reviewersBusy}
                message={pr.reviewersMessage}
                onLoad={() => pr.loadReviewers(number)}
                onApply={(added, removed) => pr.reviewerApply(number, added, removed)}
                open={openPicker === 'reviewers'}
                onOpenChange={(open) => setOpenPicker(open ? 'reviewers' : null)}
              />
              <PrLabelPicker
                detail={detail}
                busy={busy}
                candidates={pr.labels}
                loading={pr.labelsBusy}
                message={pr.labelsMessage}
                onLoad={() => pr.loadLabels(number)}
                onToggle={(name, applied) => pr.labelSet(number, [name], applied)}
                open={openPicker === 'labels'}
                onOpenChange={(open) => setOpenPicker(open ? 'labels' : null)}
              />
              <PrStackSection
                number={number}
                busy={busy}
                stack={pr.stack}
                checked={pr.stackChecked}
                loading={pr.stackBusy}
                message={pr.stackMessage}
                onLoad={() => pr.loadStack(number)}
                open={openPicker === 'stack'}
                onOpenChange={(open) => setOpenPicker(open ? 'stack' : null)}
              />
            </div>
            <div className={SCM_CARD_CLS} {...SCM_CARD_ATTRS}>
              {detail.reviews_total > 0 && <PrReviews detail={detail} />}
              {(detail.threads.length > 0 ||
                detail.threads_message !== null ||
                detail.threads_truncated) && (
                <PrThreads
                  detail={detail}
                  busy={busy}
                  onReply={(threadId, body) => pr.threadReply(number, threadId, body)}
                  onResolve={(threadId, resolved) => pr.threadResolve(number, threadId, resolved)}
                  onReact={(subjectId, content, reacted) =>
                    pr.react(number, subjectId, content, reacted)
                  }
                />
              )}
              <PrComments
                detail={detail}
                busy={busy}
                onComment={(body) => pr.comment(number, body)}
                onCommentEdit={(commentId, body) =>
                  pr.commentEdit(number, commentId, 'issue_comment', body)
                }
                onReact={(subjectId, content, reacted) =>
                  pr.react(number, subjectId, content, reacted)
                }
              />
              {reviewBar}
            </div>
          </PrSummary>
        )}
      </div>
      {pane === 'files' && reviewBar}
      {pane === 'summary' && actionBar}
    </div>
  )
}

export function PullRequestTab({
  client,
  dir,
  onOpenUrlInPane,
  onShowChanges,
  active = true,
  onPrPresenceChange,
  refreshSignal = 0
}: PullRequestTabProps): React.JSX.Element {
  const pr = usePrDetail(client, dir, active, refreshSignal)
  const pendingCompose = useRef<string | null>(null)
  const ignoreCommitMessage = useCallback((_message: string | null): void => {}, [])
  const ignoreCommitError = useCallback((_message: string | null): void => {}, [])
  const offered = pr.view?.gh === 'ready' && pr.view.hasUpstream && pr.view.link === null
  const writer = useGitWriter({
    client,
    repoDir: dir,
    offered,
    pendingCompose,
    onCommitMessage: ignoreCommitMessage,
    onCommitError: ignoreCommitError
  })
  const [browsing, setBrowsing] = useState(false)
  const list = usePrList(client, dir, active && browsing)
  const [method, setMethod] = useState<PrMergeMethod>('squash')
  const present = pr.view?.link != null
  const presenceTone = prPresenceTone(pr.view)

  useEffect(() => {
    onPrPresenceChange?.(present, presenceTone)
  }, [onPrPresenceChange, presenceTone, present])

  useEffect(() => {
    if (!client || !dir) return
    return client.subscribe('error', (message) => {
      if (pendingCompose.current !== null) writer.composeFailed(message.message)
    })
  }, [client, dir, writer.composeFailed])

  useEffect(() => {
    setBrowsing(false)
  }, [dir])

  if (!dir || !client) return <PrIdle />
  if (!active) return <div className="flex-1" data-testid="pr-idle" />

  if (browsing) {
    return (
      <PrBrowse
        list={list}
        active
        onBack={() => setBrowsing(false)}
        onSelect={(number) => {
          setBrowsing(false)
          pr.show(number)
        }}
      />
    )
  }

  if (pr.view === null) {
    return (
      <div className={EMPTY} data-testid="pr-loading">
        <span className={SPIN_CLASS}>
          <Icon glyph={IconLoaderCircle} role="subhead" />
        </span>
      </div>
    )
  }

  const view = pr.view
  const linkMessage =
    pr.linkMessage !== null ? (
      <ScmNotice tone="danger" testId="pr-link-message">
        {pr.linkMessage}
      </ScmNotice>
    ) : null

  if (view.gh !== 'ready') return <PrBlocked gh={view.gh} hint={view.hint} onRetry={pr.refresh} />
  if (view.message !== null || view.link === null) {
    return (
      <PrEmpty
        view={view}
        pr={pr}
        onShowChanges={onShowChanges}
        onBrowse={() => setBrowsing(true)}
        linkMessage={linkMessage}
        writer={writer}
        offered={offered}
      />
    )
  }
  if (view.detail === null) {
    return <PrReadError view={view} link={view.link} pr={pr} linkMessage={linkMessage} />
  }
  return (
    <PrDetailView
      view={view}
      link={view.link}
      detail={view.detail}
      pr={pr}
      method={method}
      setMethod={setMethod}
      onOpenUrlInPane={onOpenUrlInPane}
      onBrowse={() => setBrowsing(true)}
      linkMessage={linkMessage}
    />
  )
}
