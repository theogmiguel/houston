import { Button } from '../ui/Button'
import { PullRequestRole, PullRequestNumberField } from '../ui/PullRequestRoles'
import { TextArea } from '../ui/TextArea'
import { MetadataRow } from '../ui/MetadataRow'
import { Card } from '../ui/Card'
import { SectionHead } from '../ui/SectionHead'
import { PullRequestState, PullRequestDescription, PullRequestReviewBody, CheckStateDot, CheckSummary } from '../ui/PullRequestState'
import { materialAttrs } from '../ui/material'
import { useEffect, useRef, useState } from 'react'
import type {
  GhState,
  HoustonClient,
  PrCheck,
  PrCheckState,
  PrDetail,
  PrMergeMethod,
  PrReviewDraft,
  PrReviewVerdict,
  PullRequestLink
} from '../../houston/client'
import { Segmented } from '../ui/SegmentedControl'
import { ScmNotice } from './ScmNotice'
import { Disclosure } from '../ui/Disclosure'
import { Icon } from '../ui/Icon'
import { IconLoaderCircle, IconPencil, IconExternal, IconGitPullRequest } from '../icons'
import { Tooltip } from '../ui/Tooltip'
import { prDecisionLabel } from './changes'
import { PrBrowse } from './PrBrowse'
import { PrComments, PrThreads } from './PrDiscussion'
import { PrFiles } from './PrFiles'
import { PrEmptyStates } from './PrEmptyStates'
import { PrLabelPicker, PrReactions, PrReviewerPicker } from './PrPickers'
import { PrReviewBar } from './PrReviewBar'
import { PrSummary } from './PrSummary'
import { PrStackSection } from './PrStack'
import { PrFooterBar } from './PrFooterBar'
import { PrWatchRow, PrWatchStack } from '../ui/PrWatch'
import { PrInspectorSections } from '../ui/PrInspectorSections'
import { usePrWatch } from './usePrWatch'
import {
  usePrDetail,
  usePrList,
  type PrDetailController,
  type PrDetailView
} from './usePrDetailSubscription'

export interface PullRequestTabProps {
  client: HoustonClient | null
  dir: string | null
  session?: number | null
  onOpenUrlInPane?: (url: string) => void
  onSendToOrchestrator?: (text: string) => void
  onShowChanges?: () => void
  active?: boolean
  onPrPresenceChange?: (exists: boolean, tone?: PrPresenceTone) => void
  /** A changing counter from the panel header's Refresh; re-reads the detail. */
  compact?: boolean
  refreshSignal?: number
}

export type PrPresenceTone = 'ok' | 'warn' | 'stop'

/** A PR number is a positive u32; the wire refuses anything wider. */
export const PR_NUMBER_MAX = 4_294_967_295

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
        <PullRequestRole as="span" role="pull-request-command">gh</PullRequestRole> is not on PATH, so Houston cannot read pull requests. Install it and press
        Retry — nothing else in source control depends on it.
      </>
    ) : (
      'gh is not authenticated, so Houston cannot read pull requests.'
    ))
  return (
    <PullRequestRole data-testid="pr-detail-blocked" as="div" role="empty-panel">
      <PullRequestRole as="div" role="empty-heading">{headline}</PullRequestRole>
      <PullRequestRole as="p" role="empty-description">{body}</PullRequestRole>
      <Button type="button" variant="legacy-secondary" data-testid="pr-retry" onClick={onRetry}>
        Retry
      </Button>
    </PullRequestRole>
  )
}

function PrLinkForm({ pr }: { pr: PrDetailController }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const parsed = parsePrNumber(draft)
  const invalid = draft.trim() !== '' && parsed === null
  return (
    <PullRequestRole as="div" role="link-form">
      <PullRequestRole as="form" role="action-row"
        onSubmit={(e) => {
          e.preventDefault()
          if (parsed !== null) pr.link(parsed)
        } }
      >
        <PullRequestNumberField
          data-testid="pr-link-number"
          aria-label="Pull request number"
          inputMode="numeric"
          placeholder="Number"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button variant="legacy-secondary"
          type="submit"
          data-testid="pr-link"
          disabled={parsed === null || pr.linkBusy}
        >
          Link pull request
        </Button>
      </PullRequestRole>
      {invalid && (
        <PullRequestRole data-testid="pr-link-invalid" as="div" role="error-message">
          A pull request number is 1-{PR_NUMBER_MAX}.
        </PullRequestRole>
      )}
    </PullRequestRole>
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
    <PullRequestRole as="div" role="action-row">
      <Button type="button" variant="legacy-secondary"
        data-testid="pr-retry"
        onClick={pr.refresh}
      >
        Retry
      </Button>
      {view.linked && (
        <Button type="button" variant="legacy-secondary"
          data-testid="pr-unlink"
          disabled={pr.linkBusy}
          onClick={pr.unlink}
        >
          Unlink
        </Button>
      )}
    </PullRequestRole>
  )
}

function PrDescription({ body }: { body: string | null | undefined }): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  if (body === null || body === undefined || body.length === 0) return null
  return (
    <>
      <PullRequestDescription clamped={!expanded}>{body}</PullRequestDescription>
      {body.length > 240 && (
        <Button variant="compact-self-start-action"
          type="button"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      )}
    </>
  )
}

function PrEmpty({
  view,
  pr,
  onShowChanges,
  onBrowse,
  linkMessage
}: {
  view: PrDetailView
  pr: PrDetailController
  onShowChanges?: () => void
  onBrowse: () => void
  linkMessage: React.ReactNode
}): React.JSX.Element {
  return (
    <PullRequestRole data-testid="pr-detail-empty" as="div" role="detail-error-panel">
      {view.message !== null ? (
        <>
          <PullRequestRole data-testid="pr-message" as="div" role="error-message">
            {view.message}
          </PullRequestRole>
          <PrRetryRow pr={pr} view={view} />
        </>
      ) : (
        <>
          <PullRequestRole as="div" role="empty-heading">No pull request</PullRequestRole>
          <PullRequestRole as="p" role="empty-description">
            {view.hasUpstream
              ? 'This branch has no pull request yet.'
              : 'This branch has no upstream, so it cannot have a pull request yet.'}
          </PullRequestRole>
          <PullRequestRole as="div" role="action-row">
            <Tooltip
              inline
              label={view.hasUpstream ? undefined : 'This branch has no upstream, so it cannot have a pull request yet.'}
            >
              <Button type="button" variant="pull-request-primary-action"
                data-testid="pr-create"
                disabled={!view.hasUpstream || pr.createBusy}
                onClick={pr.create}
              >
                {pr.createBusy ? 'Creating…' : 'Create pull request'}
              </Button>
            </Tooltip>
          </PullRequestRole>
          {!view.hasUpstream && onShowChanges && (
            <div>
              <Button type="button" variant="legacy-secondary"
                data-testid="pr-show-changes"
                onClick={onShowChanges}
              >
                Changes
              </Button>
            </div>
          )}
        </>
      )}
      {view.message === null ? (
        <PullRequestRole as="div" role="header-actions">
          <PullRequestRole as="span" role="viewed-label">or link an existing one</PullRequestRole>
          <PrLinkForm pr={pr} />
          <Button type="button" variant="legacy-ghost"
            data-testid="pr-browse-open"
            onClick={onBrowse}
          >
            Browse…
          </Button>
        </PullRequestRole>
      ) : (
        <Button type="button" variant="legacy-ghost"
          data-testid="pr-browse-open"
          onClick={onBrowse}
        >
          Browse…
        </Button>
      )}
      {linkMessage}
      {pr.createMessage !== null && (
        <PullRequestRole data-testid="pr-create-message" as="div" role="error-message">
          {pr.createMessage}
        </PullRequestRole>
      )}
    </PullRequestRole>
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
    <PullRequestRole data-testid="pr-detail-error" as="div" role="detail-error-panel">
      <PullRequestRole data-testid="pr-message" as="div" role="error-message">
        {view.message ?? `Pull request #${link.number} could not be read; refresh to try again.`}
      </PullRequestRole>
      <PrRetryRow pr={pr} view={view} />
      {linkMessage}
    </PullRequestRole>
  )
}

/** Title, branch pair, and the edit form that rewrites them. */
function PrHeaderMetadata({ link, detail, onOpenUrlInPane }: {
  link: PullRequestLink
  detail: PrDetail
  onOpenUrlInPane?: (url: string) => void
}): React.JSX.Element {
  const head = detail.head_ref ?? null
  const base = detail.base_ref ?? null
  const branchPair = head !== null && base !== null ? `${head} → ${base}` : null
  return <>
    <div data-testid="pr-header-top">
      <PullRequestState data-testid="pr-state" state={link.state} isDraft={link.is_draft}>
        <Icon glyph={IconGitPullRequest} role="small" />{stateLabel(link)}
      </PullRequestState>
      <span data-testid="pr-number">#{link.number}</span>
      {onOpenUrlInPane && <Button variant="pull-request-external-action" type="button" onClick={() => onOpenUrlInPane(link.url)}><Icon glyph={IconExternal} role="small" />Open on GitHub</Button>}
    </div>
    <PullRequestRole data-testid="pr-title" as="div" role="pull-request-title">{link.title ?? `Pull request #${link.number}`}</PullRequestRole>
    <PullRequestRole data-testid="pr-sub" as="div" role="branch-summary">
      {branchPair ? `${branchPair} · ` : ''}{detail.commit_count === 1 ? '1 commit' : `${detail.commit_count} commits`}
      {' · '}<span data-testid="pr-additions">+{link.additions}</span>{' '}<span data-testid="pr-deletions">−{link.deletions}</span>
      {detail.behind_by !== null && detail.behind_by !== undefined ? (detail.behind_by === 0 ? ' · up to date' : ` · ${detail.behind_by} behind`) : ''}
      {detail.auto_merge_enabled === true ? ` · auto-merge ${detail.auto_merge_method ?? 'merge'}` : ''}
    </PullRequestRole>
  </>
}

function PrHeaderEditor({ link, detail, busy, editBusy, onEdit, onReact }: {
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
  return <>
    <Tooltip label="Edit title and description">
      <Button variant="compact-trailing-action" type="button" data-testid="pr-edit-open" disabled={busy} onClick={() => {
        setTitle(link.title ?? '')
        setBody(detail.body ?? '')
        setEditing((value) => !value)
      }}>
        <Icon glyph={IconPencil} role="small" />
      </Button>
    </Tooltip>
    {editing ? <PullRequestRole data-testid="pr-edit-form" as="div" role="edit-form">
      <PullRequestNumberField variant="full" data-testid="pr-edit-title" aria-label="Pull request title" value={title} onChange={(event) => setTitle(event.target.value)} />
      <TextArea surface="content" data-testid="pr-edit-body" aria-label="Pull request description" rows={5} value={body} onChange={(event) => setBody(event.target.value)}  />
      <PullRequestRole as="div" role="action-row">
        <Button variant="legacy-primary" type="button" data-testid="pr-edit-save" disabled={editBusy || title.trim().length === 0} onClick={() => { setEditing(false); onEdit(title, body) }}>Save</Button>
        <Button variant="legacy-secondary" type="button" data-testid="pr-edit-cancel" onClick={() => setEditing(false)}>Cancel</Button>
      </PullRequestRole>
    </PullRequestRole> : <PrDescription body={detail.body} />}
    {!editing && <PrReactions reactions={detail.reactions} busy={busy} onToggle={onReact} />}
  </>
}

function PrHeader({ link, detail, busy, editBusy, onEdit, onReact, onOpenUrlInPane, compact = false }: {
  link: PullRequestLink
  detail: PrDetail
  busy: boolean
  editBusy: boolean
  onEdit: (title: string, body: string) => void
  onReact: (content: PrDetail['reactions'][number]['content'], reacted: boolean) => void
  onOpenUrlInPane?: (url: string) => void
  compact?: boolean
}): React.JSX.Element {
  return <PullRequestRole as="div" role="checks-panel">
    <PullRequestRole as="div" role="edit-form">
      <PrHeaderMetadata link={link} detail={detail} onOpenUrlInPane={onOpenUrlInPane} />
      {!compact && <PrHeaderEditor link={link} detail={detail} busy={busy} editBusy={editBusy} onEdit={onEdit} onReact={onReact} />}
    </PullRequestRole>
  </PullRequestRole>
}

function PrCheckRow({ check }: { check: PrCheck }): React.JSX.Element {
  return (
    <PullRequestRole
      data-testid="pr-check-row" as="div" role="check-row"
    >
      <CheckStateDot state={check.state} size="check" />
      <PullRequestRole as="span" role="check-name">{check.name}</PullRequestRole>
      <PullRequestRole as="span" role="check-meta">
        {checkMeta(check)}
      </PullRequestRole>
    </PullRequestRole>
  )
}

function PrEditDetails({ link, detail, busy, editBusy, onEdit }: {
  link: PullRequestLink
  detail: PrDetail
  busy: boolean
  editBusy: boolean
  onEdit: (title: string, body: string) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(link.title ?? '')
  const [body, setBody] = useState(detail.body ?? '')
  return <PullRequestRole as="div" role="checks-panel">
    <Button variant="legacy-ghost" type="button" data-testid="pr-edit-open" disabled={busy} onClick={() => {
      setTitle(link.title ?? '')
      setBody(detail.body ?? '')
      setEditing((value) => !value)
    }}>
      <Icon glyph={IconPencil} role="small" />Edit title and description
    </Button>
    {editing && <PullRequestRole data-testid="pr-edit-form" as="div" role="edit-form">
      <PullRequestNumberField variant="full" data-testid="pr-edit-title" aria-label="Pull request title" value={title} onChange={(event) => setTitle(event.target.value)} />
      <TextArea surface="content" data-testid="pr-edit-body" aria-label="Pull request description" rows={5} value={body} onChange={(event) => setBody(event.target.value)}  />
      <PullRequestRole as="div" role="action-row">
        <Button variant="legacy-primary" type="button" data-testid="pr-edit-save" disabled={editBusy || title.trim().length === 0} onClick={() => { setEditing(false); onEdit(title, body) }}>Save</Button>
        <Button variant="legacy-secondary" type="button" data-testid="pr-edit-cancel" onClick={() => setEditing(false)}>Cancel</Button>
      </PullRequestRole>
    </PullRequestRole>}
  </PullRequestRole>
}

function checkSummary(checks: PrCheck[]): { text: string; failed: number; running: number } {
  const running = checks.filter((check) => check.state === 'running' || check.state === 'queued' || check.state === 'unknown').length
  const passed = checks.filter((check) => check.state === 'passing').length
  const failed = checks.filter((check) => check.state === 'failing').length
  const parts = [
    failed > 0 ? `${failed} failed` : '',
    running > 0 ? `${running} running` : '',
    passed > 0 ? `${passed} passed` : ''
  ].filter(Boolean)
  return { text: parts.length > 0 ? parts.join(', ') : 'No checks reported', failed, running }
}

function PrChecks({ checks }: { checks: PrCheck[] }): React.JSX.Element {
  const summary = checkSummary(checks)
  const passed = checks.filter((check) => check.state === 'passing').length
  const ordered = [...checks].sort((left, right) => CHECK_PRIORITY[left.state] - CHECK_PRIORITY[right.state])
  return (
    <div data-testid="pr-checks">
      <Disclosure
        defaultOpen
        scrollBody={false}
        variant="flush"
        summary={
          <PullRequestRole as="span" role="check-details">
            <CheckSummary failed={summary.failed} running={summary.running} count={checks.length} size="check" />
            <span data-testid="pr-check-summary">CHECKS · {passed} OF {checks.length} PASSED</span>
          <PullRequestRole as="span" role="right-meta-label">Details</PullRequestRole>
          </PullRequestRole>
        }
      >
        {checks.length === 0 ? (
          <PullRequestRole as="div" role="viewed-label">No checks reported.</PullRequestRole>
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
      <MetadataRow>
        <PullRequestRole as="span" role="metadata-label">Review</PullRequestRole>
        <PullRequestRole as="span" role="metadata-value">{reviewLabel(link.review_decision)}</PullRequestRole>
      </MetadataRow>
      <MetadataRow tone={mergeReason !== null ? 'danger' : 'default'}>
        <PullRequestRole as="span" role="metadata-label">Mergeable</PullRequestRole>
        <PullRequestRole data-testid="pr-merge-reason" as="span" role="metadata-value">
          {mergeReason ?? 'Ready to merge'}
        </PullRequestRole>
      </MetadataRow>
      {detail.viewer_message !== null && detail.viewer_message !== undefined && (
        <MetadataRow tone="danger">
          <PullRequestRole as="span" role="metadata-label">Permissions</PullRequestRole>
          <PullRequestRole data-testid="pr-viewer-message" as="span" role="danger-metadata-value">
            {detail.viewer_message}
          </PullRequestRole>
        </MetadataRow>
      )}
    </div>
  )
}

function PrReviews({ detail }: { detail: PrDetail }): React.JSX.Element {
  return (
    <Disclosure
      summary="Reviews"
      count={detail.reviews_total}
      defaultOpen
      scrollBody={false}
      variant="flush"
    >
      <PullRequestRole data-testid="pr-reviews" as="div" role="review-list">
        {detail.reviews.map((review, index) => (
          <PullRequestRole key={`${review.id ?? review.author}-${index}`} data-testid="pr-review-row" as="div" role="review-row">
            <PullRequestRole as="span" role="review-author">
              {review.author} · {REVIEW_LABEL[review.state] ?? review.state.toLowerCase()}
            </PullRequestRole>
            {review.body.length > 0 && (
              <PullRequestReviewBody>
                {review.body}
              </PullRequestReviewBody>
            )}
          </PullRequestRole>
        ))}
      </PullRequestRole>
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

export function pendingMergeReason(detail: PrDetail): string | null {
  const reason = detail.merge_disabled_reason ?? null
  const pending = detail.checks.filter((check) => ['running', 'queued', 'unknown'].includes(check.state))
  if ((reason === 'Checks are still running' || /^PR #\d+ is waiting on \d+ checks?: /.test(reason ?? '')) && pending.length > 0) {
    return `Merge waits for ${pending[0].name}${pending.length > 1 ? ` +${pending.length - 1}` : ''}`
  }
  return reason
}

function PrInspectorBoard({ link, detail, pr, number, busy, mergeReason, approvalsRequired, approvalsReceived, onOpenUrlInPane, onSendToOrchestrator, reviewBar, watchRows, openPicker, setOpenPicker }: {
  link: PullRequestLink
  detail: PrDetail
  pr: PrDetailController
  number: number
  busy: boolean
  mergeReason: string | null
  approvalsRequired: number
  approvalsReceived: number
  onOpenUrlInPane?: (url: string) => void
  onSendToOrchestrator?: (text: string) => void
  reviewBar: React.ReactNode
  watchRows: React.ReactNode
  openPicker: 'reviewers' | 'labels' | 'stack' | null
  setOpenPicker: (value: 'reviewers' | 'labels' | 'stack' | null) => void
}): React.JSX.Element {
  return <PrSummary>
    <PullRequestRole as="div" role="inspector-header"><PrHeader link={link} detail={detail} busy={busy} editBusy={false} onEdit={() => {}} onReact={() => {}} onOpenUrlInPane={onOpenUrlInPane} compact /></PullRequestRole>
    {watchRows}
    <PrInspectorSections checks={detail.checks} detail={detail} approvalsRequired={approvalsRequired} approvalsReceived={approvalsReceived} number={number} busy={busy} onReply={(threadId, body) => pr.threadReply(number, threadId, body)} onSendToOrchestrator={onSendToOrchestrator} onOpenChecks={onOpenUrlInPane ? () => onOpenUrlInPane(`${link.url}/checks`) : undefined} />
    <Card tone="material-inset" shape="inset" data-testid="pr-details"  {...materialAttrs('inset')}>
      <Disclosure summary="Details" scrollBody={false}
      variant="flush">
        <PullRequestRole as="div" role="detail-content">
          <PrEditDetails link={link} detail={detail} busy={busy} editBusy={pr.write.busy === `edit:${number}`} onEdit={(title, body) => pr.edit(number, title, body)} />
          <PrMeta link={link} detail={detail} mergeReason={mergeReason} />
          {detail.reviews_total > 0 && <PrReviews detail={detail} />}
          {(detail.threads.length > 0 || detail.threads_message !== null || detail.threads_truncated) && <PrThreads detail={detail} busy={busy} number={number} onSendToOrchestrator={onSendToOrchestrator} onReply={(threadId, body) => pr.threadReply(number, threadId, body)} onResolve={(threadId, resolved) => pr.threadResolve(number, threadId, resolved)} onReact={(subjectId, content, reacted) => pr.react(number, subjectId, content, reacted)} />}
          <PrComments detail={detail} busy={busy} onComment={(body) => pr.comment(number, body)} onCommentEdit={(commentId, body) => pr.commentEdit(number, commentId, 'issue_comment', body)} onReact={(subjectId, content, reacted) => pr.react(number, subjectId, content, reacted)} />
          {reviewBar}
          <div><SectionHead density="row" tone="muted" title="People & labels" />
            <PrReviewerPicker detail={detail} busy={busy} candidates={pr.reviewers} loading={pr.reviewersBusy} message={pr.reviewersMessage} onLoad={() => pr.loadReviewers(number)} onApply={(added, removed) => pr.reviewerApply(number, added, removed)} open={openPicker === 'reviewers'} onOpenChange={(open) => setOpenPicker(open ? 'reviewers' : null)} />
            <PrLabelPicker detail={detail} busy={busy} candidates={pr.labels} loading={pr.labelsBusy} message={pr.labelsMessage} onLoad={() => pr.loadLabels(number)} onToggle={(name, applied) => pr.labelSet(number, [name], applied)} open={openPicker === 'labels'} onOpenChange={(open) => setOpenPicker(open ? 'labels' : null)} />
            <PrStackSection number={number} busy={busy} stack={pr.stack} checked={pr.stackChecked} loading={pr.stackBusy} message={pr.stackMessage} onLoad={() => pr.loadStack(number)} open={openPicker === 'stack'} onOpenChange={(open) => setOpenPicker(open ? 'stack' : null)} />
          </div>
        </PullRequestRole>
      </Disclosure>
    </Card>
  </PrSummary>
}

function PrDetailView({
  view,
  link,
  detail,
  pr,
  method,
  setMethod,
  onOpenUrlInPane,
  onSendToOrchestrator,
  onBrowse,
  linkMessage,
  compact,
  watchRows
}: {
  compact: boolean
  view: PrDetailView
  link: PullRequestLink
  detail: PrDetail
  pr: PrDetailController
  method: PrMergeMethod
  setMethod: (method: PrMergeMethod) => void
  onOpenUrlInPane?: (url: string) => void
  onSendToOrchestrator?: (text: string) => void
  onBrowse: () => void
  linkMessage: React.ReactNode
  watchRows: React.ReactNode
}): React.JSX.Element {
  const [pane, setPane] = useState<'summary' | 'files'>('summary')
  const [drafts, setDrafts] = useState<PrReviewDraft[]>([])
  const [reviewVerdict, setReviewVerdict] = useState<PrReviewVerdict>('comment')
  const [reviewBody, setReviewBody] = useState('')
  const [reviewDraftsOpen, setReviewDraftsOpen] = useState(false)
  const [openPicker, setOpenPicker] = useState<'reviewers' | 'labels' | 'stack' | null>(null)
  const mergeReason = pendingMergeReason(detail)
  const busy = pr.write.busy !== null
  const number = link.number
  const approvalsRequired = detail.reviewers.length
  const approvalsReceived = detail.reviews.filter((review) => review.state === 'APPROVED').length

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
    <PullRequestRole data-testid="pr-tab" as="div" role="tab-frame">
      {!compact && <PullRequestRole as="div" role="tab-toolbar">
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
        <Button variant="compact-action"
          type="button"
          data-testid="pr-browse-open"
          onClick={onBrowse}
        >
          Browse…
        </Button>
        {pr.viewed !== null && (
          <PullRequestRole data-testid="pr-browsed" as="span" role="viewed-label">
            Viewing #{pr.viewed}, not this branch's pull request
          </PullRequestRole>
        )}
        {pr.viewed !== null && (
          <Button variant="legacy-secondary"
            type="button"
            data-testid="pr-back-to-branch"
            onClick={pr.showBranch}
          >
            Back
          </Button>
        )}
        <PullRequestRole as="span" role="merge-status">
          {detail.mergeable === 'conflicting' ? 'conflicts' : ''}
        </PullRequestRole>
      </PullRequestRole>}
      <PrNotices pr={pr} linkMessage={linkMessage} />
      <PullRequestRole data-testid="pr-scroll-area" as="div" role="scroll-area">
        {compact ? <PrInspectorBoard
          link={link}
          detail={detail}
          pr={pr}
          number={number}
          busy={busy}
          mergeReason={mergeReason}
          approvalsRequired={approvalsRequired}
          approvalsReceived={approvalsReceived}
          onOpenUrlInPane={onOpenUrlInPane}
          onSendToOrchestrator={onSendToOrchestrator}
          reviewBar={reviewBar}
          watchRows={watchRows}
          openPicker={openPicker}
          setOpenPicker={setOpenPicker}
        /> : pane === 'files' ? (
          <PullRequestRole as="div" role="file-pane">
            <PrFiles
              diff={pr.diff}
              loading={pr.diffBusy}
              drafts={drafts}
              writeBusy={busy}
              onAddDraft={addDraft}
              onReload={() => pr.loadDiff(number)}
            />
          </PullRequestRole>
        ) : (
          <PrSummary>
            <Card tone="material-inset" shape="inset"  {...materialAttrs('inset')}>
              <PrHeader
                link={link}
                detail={detail}
                busy={busy}
                editBusy={pr.write.busy === `edit:${number}`}
                onEdit={(title, body) => pr.edit(number, title, body)}
                onReact={(content, reacted) => pr.react(number, null, content, reacted)}
                onOpenUrlInPane={onOpenUrlInPane}
              />
            </Card>
            <Card tone="material-inset" shape="inset"  {...materialAttrs('inset')}>
              <SectionHead density="row" tone="muted" title="Status" />
              <PrChecks checks={detail.checks} />
              <PrMeta link={link} detail={detail} mergeReason={mergeReason} />
            </Card>
            <Card tone="material-inset" shape="inset"  {...materialAttrs('inset')}>
              <SectionHead density="row" tone="muted" title="People & labels" />
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
            </Card>
            <Card tone="material-inset" shape="inset"  {...materialAttrs('inset')}>
              {link.review_decision === 'REVIEW_REQUIRED' && approvalsRequired > 0 && (
                <PullRequestRole data-testid="pr-review-requirement" as="div" role="approval-requirement">
                  <span>Review · {approvalsRequired} approval{approvalsRequired === 1 ? '' : 's'} required</span>
                  <span data-review-count>{Math.min(approvalsReceived, approvalsRequired)} / {approvalsRequired}</span>
                </PullRequestRole>
              )}
              {detail.reviews_total > 0 && <PrReviews detail={detail} />}
              {(detail.threads.length > 0 ||
                detail.threads_message !== null ||
                detail.threads_truncated) && (
                <PrThreads
                  detail={detail}
                  busy={busy}
                  number={number}
                  onSendToOrchestrator={onSendToOrchestrator}
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
            </Card>
          </PrSummary>
        )}
      </PullRequestRole>
      {!compact && pane === 'files' && reviewBar}
      {((compact && pane === 'summary') || (!compact && pane === 'summary')) && actionBar}
    </PullRequestRole>
  )
}

export function PullRequestTab({
  client,
  dir,
  session = null,
  onOpenUrlInPane,
  onSendToOrchestrator,
  onShowChanges,
  active = true,
  onPrPresenceChange,
  refreshSignal = 0,
  compact = false
}: PullRequestTabProps): React.JSX.Element {
  const pr = usePrDetail(client, dir, active, refreshSignal)
  const watches = usePrWatch(client, session)
  const watchRows = watches.map((watch) => (
    <PrWatchRow
      key={`${watch.number}:${watch.url}`}
      number={watch.number}
      lastCheckedAtMs={watch.last_checked_at_ms}
      compact={compact}
      onStop={() => {
        if (client && session != null) client.send({ type: 'pr_watch_unwatch', session, number: watch.number })
      }}
    />
  ))
  const withWatchRows = (content: React.ReactNode, showWatchRows = true): React.JSX.Element => (
    <PrWatchStack>
      {showWatchRows && watchRows}
      {content}
    </PrWatchStack>
  )
  const [browsing, setBrowsing] = useState(false)
  const list = usePrList(client, dir, active && browsing)
  const [method, setMethod] = useState<PrMergeMethod>('squash')
  const present = pr.view?.link != null
  const presenceTone = prPresenceTone(pr.view)

  useEffect(() => {
    onPrPresenceChange?.(present, presenceTone)
  }, [onPrPresenceChange, presenceTone, present])

  useEffect(() => {
    setBrowsing(false)
  }, [dir])

  if (!dir || !client) return <PrIdle />
  if (!active) return <PullRequestRole data-testid="pr-idle" as="div" role="fill" />

  if (browsing) {
    return (
      withWatchRows(
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
    )
  }

  if (pr.view === null) {
    return withWatchRows(
      <PullRequestRole data-testid="pr-loading" as="div" role="empty-panel">
        <PullRequestRole as="span" role="loading-indicator">
          <Icon glyph={IconLoaderCircle} role="subhead" />
        </PullRequestRole>
      </PullRequestRole>
    )
  }

  const view = pr.view
  const linkMessage =
    pr.linkMessage !== null ? (
      <ScmNotice tone="danger" testId="pr-link-message">
        {pr.linkMessage}
      </ScmNotice>
    ) : null

  if (view.gh !== 'ready') return withWatchRows(<PrBlocked gh={view.gh} hint={view.hint} onRetry={pr.refresh} />)
  if (view.message !== null || view.link === null) {
    return withWatchRows(
      <PrEmpty
        view={view}
        pr={pr}
        onShowChanges={onShowChanges}
        onBrowse={() => setBrowsing(true)}
        linkMessage={linkMessage}
      />
    )
  }
  if (view.detail === null) {
    return withWatchRows(<PrReadError view={view} link={view.link} pr={pr} linkMessage={linkMessage} />)
  }
  return withWatchRows(
    <PrDetailView
      compact={compact}
      view={view}
      link={view.link}
      detail={view.detail}
      pr={pr}
      method={method}
      setMethod={setMethod}
      onOpenUrlInPane={onOpenUrlInPane}
      onSendToOrchestrator={onSendToOrchestrator}
      onBrowse={() => setBrowsing(true)}
      linkMessage={linkMessage}
      watchRows={compact ? watchRows : null}
    />,
    !compact
  )
}
