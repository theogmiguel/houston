import { PrTab } from '../ui/PrTab'
import { LazyLegacyButton } from '../ui/LazyLegacyButtonRoles'
import { ReviewButton } from '../ui/ReviewButtonRoles'
import { Button } from '../ui/Button'
import { PullRequestRole, PullRequestNumberField } from '../ui/PullRequestRoles'
import { TextArea } from '../ui/TextArea'
import { MetadataRow } from '../ui/MetadataRow'
import { Card } from '../ui/Card'
import { SectionHead } from '../ui/SectionHead'
import { PullRequestState, PullRequestDescription, PullRequestReviewBody } from '../ui/PullRequestState'
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
import { Segmented, type SegmentedOption } from '../ui/SegmentedControl'
import { ScmNotice } from './ScmNotice'
import { Disclosure } from '../ui/Disclosure'
import { Icon } from '../ui/Icon'
import { IconLoaderCircle, IconPencil, IconExternal, IconGitPullRequest, IconCheck, IconFile, IconClose, IconChevronDown, IconMessageSquare } from '../icons'
import { Tooltip } from '../ui/Tooltip'
import { useExitAnimation } from '../ui/AnimOut'
import { prDecisionLabel } from './changes'
import { PrBrowse } from './PrBrowse'
import { PrComments, PrInspectorComments, PrThreads } from './PrDiscussion'
import { PrFiles } from './PrFiles'
import { PrEmptyStates } from './PrEmptyStates'
import { PrLabelPicker, PrReactions, PrReviewerPicker } from './PrPickers'
import { PrReviewBar } from './PrReviewBar'
import { PrSummary } from './PrSummary'
import { PrStackSection } from './PrStack'
import { PrFooterBar } from './PrFooterBar'
import { PrBranchSummary } from './PrSummary'
import { PrWatchRow, PrWatchStack } from '../ui/PrWatch'
import { PrChecksPanel } from '../prs/PrChecksPanel'
import { ChecksList, checkKey, type CheckAgentTarget } from '../prs/ChecksList'
import { PrChecksList, usePrChecksState } from '../prs/usePrChecksState'
import { CopyChip } from '../ui/CopyChip'
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
  /** Grid-local agents supplied by the surface host for check-log handoff. */
  checkAgentTargets?: CheckAgentTarget[]
  /** Paste check context into the selected agent's prompt without submitting it. */
  onPasteToAgent?: (session: number, text: string) => void
  onCreateCheckAgent?: ((provider: string, text: string) => void) | ((provider: string, text: string) => Promise<number | null>)
  onShowChanges?: () => void
  active?: boolean
  onPrPresenceChange?: (exists: boolean, tone?: PrPresenceTone) => void
  /** A changing counter from the panel header's Refresh; re-reads the detail. */
  compact?: boolean
  refreshSignal?: number
  requestedPr?: { number: number; nonce: number } | null
  onOpenPane?: (session: number) => void
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

function PrWatchContent({
  rows,
  showRows = true,
  children,
}: {
  rows: React.ReactNode
  showRows?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return <PrWatchStack>{showRows && rows}{children}</PrWatchStack>
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
      <LazyLegacyButton type="button" variant="legacy-secondary" data-testid="pr-retry" onClick={onRetry}>
        Retry
      </LazyLegacyButton>
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
        <LazyLegacyButton variant="legacy-secondary"
          type="submit"
          data-testid="pr-link"
          disabled={parsed === null || pr.linkBusy}
        >
          Link pull request
        </LazyLegacyButton>
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
      <LazyLegacyButton type="button" variant="legacy-secondary"
        data-testid="pr-retry"
        onClick={pr.refresh}
      >
        Retry
      </LazyLegacyButton>
      {view.linked && (
        <LazyLegacyButton type="button" variant="legacy-secondary"
          data-testid="pr-unlink"
          disabled={pr.linkBusy}
          onClick={pr.unlink}
        >
          Unlink
        </LazyLegacyButton>
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
        <ReviewButton variant="compact-self-start-action"
          type="button"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </ReviewButton>
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
              <ReviewButton type="button" variant="pull-request-primary-action"
                data-testid="pr-create"
                disabled={!view.hasUpstream || pr.createBusy}
                onClick={pr.create}
              >
                {pr.createBusy ? 'Creating…' : 'Create pull request'}
              </ReviewButton>
            </Tooltip>
          </PullRequestRole>
          {!view.hasUpstream && onShowChanges && (
            <div>
              <LazyLegacyButton type="button" variant="legacy-secondary"
                data-testid="pr-show-changes"
                onClick={onShowChanges}
              >
                Changes
              </LazyLegacyButton>
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
      {onOpenUrlInPane && <ReviewButton variant="pull-request-external-action" type="button" onClick={() => onOpenUrlInPane(link.url)}><Icon glyph={IconExternal} role="small" />Open on GitHub</ReviewButton>}
    </div>
    <PullRequestRole data-testid="pr-title" as="div" role="pull-request-title">{link.title ?? `Pull request #${link.number}`}</PullRequestRole>
    <PullRequestRole data-testid="pr-sub" as="div" role="branch-summary">
      {head && <PrTab as={CopyChip} surface="pr-head-ref" value={head}>{head}</PrTab>}{branchPair ? ` → ${base} · ` : ''}{detail.commit_count === 1 ? '1 commit' : `${detail.commit_count} commits`}
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
      <ReviewButton variant="compact-trailing-action" type="button" data-testid="pr-edit-open" disabled={busy} onClick={() => {
        setTitle(link.title ?? '')
        setBody(detail.body ?? '')
        setEditing((value) => !value)
      }}>
        <Icon glyph={IconPencil} role="small" />
      </ReviewButton>
    </Tooltip>
    {editing ? <PullRequestRole data-testid="pr-edit-form" as="div" role="edit-form">
      <PullRequestNumberField variant="full" data-testid="pr-edit-title" aria-label="Pull request title" value={title} onChange={(event) => setTitle(event.target.value)} />
      <TextArea surface="content" data-testid="pr-edit-body" aria-label="Pull request description" rows={5} value={body} onChange={(event) => setBody(event.target.value)}  />
      <PullRequestRole as="div" role="action-row">
        <Button variant="legacy-primary" type="button" data-testid="pr-edit-save" disabled={editBusy || title.trim().length === 0} onClick={() => { setEditing(false); onEdit(title, body) }}>Save</Button>
        <LazyLegacyButton variant="legacy-secondary" type="button" data-testid="pr-edit-cancel" onClick={() => setEditing(false)}>Cancel</LazyLegacyButton>
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
        <LazyLegacyButton variant="legacy-secondary" type="button" data-testid="pr-edit-cancel" onClick={() => setEditing(false)}>Cancel</LazyLegacyButton>
      </PullRequestRole>
    </PullRequestRole>}
  </PullRequestRole>
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

function CompactPrChecks({ state }: { state: ReturnType<typeof usePrChecksState> }): React.JSX.Element {
  const { failedCount, passedCount, sectionOpen, setSectionOpen, listProps } = state
  const checks = listProps.checks
  return <PrTab as="section" surface="pr-compact-checks" data-testid="pr-checks">
    <PrTab as="div" surface="pr-compact-checks-heading">
      <button type="button" aria-expanded={sectionOpen} onClick={() => setSectionOpen((open) => !open)}>
        <Icon glyph={IconChevronDown} role="small" className={sectionOpen ? '' : '-rotate-90'} />Checks
      </button>
      <span data-testid="pr-check-summary">{failedCount > 0 ? `${failedCount} of ${checks.length} failing` : `${passedCount} passed`}</span>
    </PrTab>
    {sectionOpen && <div data-testid="pr-check-popover" aria-label="Pull request checks"><PrChecksList state={state} /></div>}
  </PrTab>
}

function PrInspectorBoard({ link, detail, pr, number, busy, mergeReason, approvalsRequired, approvalsReceived, onSendToOrchestrator, checkState, reviewBar, watchRows, openPicker, setOpenPicker }: {
  link: PullRequestLink
  detail: PrDetail
  pr: PrDetailController
  number: number
  busy: boolean
  mergeReason: string | null
  approvalsRequired: number
  approvalsReceived: number
  onSendToOrchestrator?: (text: string) => void
  checkState: ReturnType<typeof usePrChecksState>
  reviewBar: React.ReactNode
  watchRows: React.ReactNode
  openPicker: 'reviewers' | 'labels' | 'stack' | null
  setOpenPicker: (value: 'reviewers' | 'labels' | 'stack' | null) => void
}): React.JSX.Element {
  return <PrBranchSummary
    detail={detail}
    people={<PrTab as="section" surface="pr-branch-people">
      <PrReviewerPicker compact detail={detail} busy={busy} candidates={pr.reviewers} loading={pr.reviewersBusy} message={pr.reviewersMessage} onLoad={() => pr.loadReviewers(number)} onApply={(added, removed) => pr.reviewerApply(number, added, removed)} open={openPicker === 'reviewers'} onOpenChange={(open) => setOpenPicker(open ? 'reviewers' : null)} />
      <PrLabelPicker compact detail={detail} busy={busy} candidates={pr.labels} loading={pr.labelsBusy} message={pr.labelsMessage} onLoad={() => pr.loadLabels(number)} onToggle={(name, applied) => pr.labelSet(number, [name], applied)} open={openPicker === 'labels'} onOpenChange={(open) => setOpenPicker(open ? 'labels' : null)} />
    </PrTab>}
    checks={<CompactPrChecks state={checkState} />}
    descriptionAction={<PrEditDetails link={link} detail={detail} busy={busy} editBusy={pr.write.busy === `edit:${number}`} onEdit={(title, body) => pr.edit(number, title, body)} />}
    footer={<>
      {watchRows}
      <PrInspectorComments
        detail={detail}
        approvalsRequired={approvalsRequired}
        approvalsReceived={approvalsReceived}
        number={number}
        busy={busy}
        onReply={(threadId, body) => pr.threadReply(number, threadId, body)}
        onResolve={(threadId, resolved) => pr.threadResolve(number, threadId, resolved)}
        onSendToOrchestrator={onSendToOrchestrator}
        issueComments={null}
      />
      <div data-testid="pr-details">
        <PrTab as={Disclosure} surface="pr-compact-details" summary="Details" scrollBody={false} variant="flush">
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
        </PrTab>
      </div>
    </>}
  />
}

function PrDetailToolbar({
  compact,
  pane,
  detail,
  checkState,
  onBrowse,
  pr,
  preloadCode,
  onChangePane
}: {
  compact: boolean
  pane: 'summary' | 'timeline' | 'files'
  detail: PrDetail
  checkState: ReturnType<typeof usePrChecksState>
  onBrowse: () => void
  pr: PrDetailController
  preloadCode: (target: EventTarget) => void
  onChangePane: (pane: 'summary' | 'timeline' | 'files') => void
}): React.JSX.Element {
  const [popoverExpanded, setPopoverExpanded] = useState<string | null>(null)
  const popoverMotion = useExitAnimation(compact && pane === 'summary' && checkState.popoverOpen, 150)
  useEffect(() => {
    if (!checkState.popoverOpen) return
    const closeOnOutside = (event: PointerEvent): void => {
      if (event.target instanceof Element && event.target.closest('[data-testid="pr-check-popover"], [data-testid="pr-check-strip-summary"]')) return
      checkState.setPopoverOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') checkState.setPopoverOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [checkState.popoverOpen, checkState.setPopoverOpen])
  return (
    <>
    <PrTab
      as={PullRequestRole}
      surface="pr-tab-toolbar"
      state={compact ? 'compact' : null}
      role="tab-toolbar"
      onMouseOver={(event) => preloadCode(event.target)}
      onFocusCapture={(event) => preloadCode(event.target)}
    >
      <Segmented<'summary' | 'timeline' | 'files'>
        aria-label="Pull request view"
        value={pane}
        onChange={(value) => {
          checkState.setPopoverOpen(false)
          onChangePane(value)
        }}
        options={[
          { value: 'summary', label: 'Summary', testId: 'pr-pane-summary' },
          ...(compact ? [{ value: 'timeline' as const, label: 'Timeline', testId: 'pr-pane-timeline' }] : []),
          { value: 'files', label: compact ? 'Code' : 'Files', testId: compact ? 'pr-pane-code' : 'pr-pane-files' }
        ] satisfies SegmentedOption<'summary' | 'timeline' | 'files'>[]}
      />
      {compact && pane === 'timeline' && (
        <PrTab as="span" surface="pr-timeline-counts"><Icon glyph={IconMessageSquare} role="small" /> {detail.comments_total} <span>·</span> {detail.commit_count} commits</PrTab>
      )}
      {compact && pane === 'summary' && (
        <>
          <Button
            variant="link"
            size="sm"
            type="button"
            data-testid="pr-check-strip-summary"
            aria-expanded={checkState.popoverOpen}
            style={{ color: checkState.failedCount > 0 ? 'var(--stop)' : 'var(--text-secondary)' }}
            onClick={() => checkState.setPopoverOpen((open) => !open)}
          >
            {checkState.failedCount > 0 ? (
              <>
                <PrTab as="span" surface="pr-check-failed-icon"><Icon glyph={IconClose} role="small" /></PrTab>
                {checkState.failedCount} of {detail.checks.length} failing
              </>
            ) : (
              <>
                <Icon glyph={IconCheck} role="small" />All checks passed
              </>
            )}
          </Button>
        </>
      )}
      {popoverMotion.mounted && (
        <PrTab as="div" surface="pr-check-popover" state={popoverMotion.closing ? 'closing' : undefined} data-testid="pr-check-popover" data-failing={checkState.failedCount > 0} aria-label="Pull request checks" aria-hidden={popoverMotion.closing || undefined}>
          <PrTab as="div" surface="pr-check-popover-title">{checkState.failedCount > 0 ? `${checkState.failedCount} check failed` : 'All checks have passed'}</PrTab>
          <PrTab as="div" surface="pr-check-popover-subtitle">{checkState.passedCount} passed{checkState.failedCount > 0 ? ` · ${checkState.failedCount} failed` : ''}</PrTab>
          <ChecksList
            {...checkState.listProps}
            expanded={popoverExpanded}
            onToggle={(check) => {
              const key = checkKey(check)
              setPopoverExpanded((current) => current === key ? null : key)
              if (checkState.listProps.expanded !== key) checkState.listProps.onToggle(check)
            }}
          />
        </PrTab>
      )}
      {!compact && (
        <ReviewButton variant="compact-action" type="button" data-testid="pr-browse-open" onClick={onBrowse}>
          Browse…
        </ReviewButton>
      )}
      <PullRequestRole as="span" role="merge-status">
        {detail.mergeable === 'conflicting' ? 'conflicts' : ''}
      </PullRequestRole>
    </PrTab>
    {pr.viewed !== null && (
      <PrTab as="div" surface="pr-viewed-notice">
        <PullRequestRole data-testid="pr-browsed" as="span" role="viewed-label">
          Viewing #{pr.viewed}, not this branch's pull request
        </PullRequestRole>
        <LazyLegacyButton variant="legacy-secondary" type="button" data-testid="pr-back-to-branch" onClick={pr.showBranch}>
          Back
        </LazyLegacyButton>
      </PrTab>
    )}
    </>
  )
}

function PrBranchHeader({ link, detail, actionBar, condensed, foldRef, condensedRef }: {
  link: PullRequestLink
  detail: PrDetail
  actionBar: React.ReactNode
  condensed: boolean
  foldRef: React.RefObject<HTMLDivElement | null>
  condensedRef: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const updatedMinutes = Math.max(0, Math.floor((Date.now() / 1000 - detail.updated_at) / 60))
  const number = (testId?: string): React.JSX.Element => <PrTab as="a" surface="pr-crumb-number" state={link.is_draft && link.state === 'open' ? 'draft' : link.state} href={link.url} data-testid={testId}>#{link.number}<Icon glyph={IconExternal} role="small" /></PrTab>
  return <PrTab as="div" surface="pr-scroll-header" data-testid="pr-scroll-header" data-condensed={condensed}>
    <PrTab as="div" surface="pr-branch-topline" data-testid="pr-header-top">
      <PrTab as="div" surface="pr-crumb-cell">
        <PrTab as="div" surface="pr-crumb-expanded" state={condensed ? 'hidden' : undefined}>
          <PrTab as="span" surface="pr-crumb-repo">{link.repository}</PrTab><span data-testid="pr-state">{number('pr-number')}</span>
        </PrTab>
        <PrTab as="div" surface="pr-crumb-condensed" state={condensed ? undefined : 'hidden'}>
          {number()}<span>{link.title ?? `Pull request #${link.number}`}</span>
        </PrTab>
      </PrTab>
      {actionBar}
    </PrTab>
    <PrTab as="div" surface="pr-header-fold" state={condensed ? 'shut' : undefined}>
    <div><PrTab as="div" surface="pr-branch-heading" ref={foldRef}>
      <PullRequestRole data-testid="pr-title" as="h2" role="pull-request-title">{link.title ?? `Pull request #${link.number}`}</PullRequestRole>
      <PrTab as="div" surface="pr-branch-author">
        <PrTab as="span" surface="pr-branch-avatar" aria-hidden="true">{(detail.author ?? 'M').slice(0, 1).toUpperCase()}</PrTab>
        <span>{detail.author ?? 'maintainer'}</span><span aria-hidden="true">·</span>
        <span>updated {updatedMinutes}m ago</span>
        <PrTab as={CopyChip} surface="pr-branch-checkout" value={`gh pr checkout ${link.number}`}>gh pr checkout {link.number}</PrTab>
      </PrTab>
      <PrTab as="div" surface="pr-branch-refs" data-testid="pr-sub">
        <PrTab as="span" surface="pr-branch-ref-pair"><span>{detail.base_ref ?? 'main'}</span><span aria-hidden="true">←</span><span>{detail.head_ref ?? 'branch'}</span></PrTab>
        <PrTab as="span" surface="pr-branch-stat"><Icon glyph={IconFile} role="small" /><span>{link.changed_files} files</span><PrTab as="span" surface="pr-branch-diff"><span>+{link.additions}</span><span>−{link.deletions}</span></PrTab></PrTab>
      </PrTab>
    </PrTab></div>
    </PrTab>
    <PrTab as="div" surface="pr-condensed-row" state={condensed ? 'open' : undefined}>
      <div><PrTab as="div" surface="pr-condensed-inner" ref={condensedRef}>
        <PrTab as="span" surface="pr-branch-avatar" aria-hidden="true">{(detail.author ?? 'M').slice(0, 1).toUpperCase()}</PrTab>
        <span>{updatedMinutes}m ago</span><span aria-hidden="true">·</span>
        <PrTab as="span" surface="pr-condensed-refs"><span>{detail.base_ref ?? 'main'}</span><span aria-hidden="true">←</span><span>{detail.head_ref ?? 'branch'}</span></PrTab>
        <PrTab as="span" surface="pr-branch-stat"><Icon glyph={IconFile} role="small" /><span>{link.changed_files} files</span><PrTab as="span" surface="pr-branch-diff"><span>+{link.additions}</span><span>−{link.deletions}</span></PrTab></PrTab>
      </PrTab></div>
    </PrTab>
  </PrTab>
}

function PrTimelineSummary({
  detail,
}: {
  detail: PrDetail
}): React.JSX.Element {
  const age = (timestamp: number): string => {
    const minutes = Math.max(0, Math.floor(Date.now() / 1000 - timestamp) / 60)
    if (minutes < 60) return `${Math.floor(minutes)}m ago`
    if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`
    return `${Math.floor(minutes / 1440)}d ago`
  }
  const events = [
    { key: 'opened', at: detail.created_at, icon: IconGitPullRequest, content: <><strong>{detail.author ?? 'Author'}</strong> opened this pull request</> },
    ...(detail.commit_count > 0 ? [{ key: 'commits', at: detail.updated_at, icon: IconFile, content: <><strong>{detail.commit_count} commits</strong> on this branch <PrTab as="span" surface="pr-timeline-sha">{detail.head_sha.slice(0, 7)}</PrTab></> }] : []),
    ...detail.comments.map((comment, index) => ({ key: comment.id ?? `comment-${index}`, at: comment.created_at, icon: IconMessageSquare, content: <><strong>{comment.author}</strong> commented</> })),
    ...(detail.checks.length > 0 && detail.checks.every((check) => check.state === 'passing')
      ? [{ key: 'checks', at: detail.updated_at, icon: IconCheck, content: <strong>All checks passed</strong> }]
      : []),
  ].sort((a, b) => a.at - b.at)
  return (
      <PrTab as="div" surface="pr-timeline" data-testid="pr-timeline-events">
        {events.map((event) => (
          <PrTab as="div" surface="pr-timeline-event" key={event.key}>
            <PrTab as="span" surface="pr-timeline-mark" state={event.key === 'checks' ? 'passing' : undefined}><Icon glyph={event.icon} role="small" /></PrTab>
            <span>{event.content}</span>
            <PrTab as="time" surface="pr-timeline-age">{age(event.at)}</PrTab>
          </PrTab>
        ))}
      </PrTab>
  )
}

function PrDetailStandardSummary({
  link,
  detail,
  pr,
  number,
  busy,
  mergeReason,
  approvalsRequired,
  approvalsReceived,
  onOpenUrlInPane,
  onSendToOrchestrator,
  checkState,
  openPicker,
  setOpenPicker,
  reviewBar
}: {
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
  checkState: ReturnType<typeof usePrChecksState>
  openPicker: 'reviewers' | 'labels' | 'stack' | null
  setOpenPicker: (value: 'reviewers' | 'labels' | 'stack' | null) => void
  reviewBar: React.ReactNode
}): React.JSX.Element {
  return (
    <PrSummary>
      <Card tone="material-inset" shape="inset" {...materialAttrs('inset')}>
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
      <Card tone="material-inset" shape="inset" {...materialAttrs('inset')}>
        <PrChecksPanel state={checkState} />
        <PrMeta link={link} detail={detail} mergeReason={mergeReason} />
      </Card>
      <Card tone="material-inset" shape="inset" {...materialAttrs('inset')}>
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
      <Card tone="material-inset" shape="inset" {...materialAttrs('inset')}>
        {link.review_decision === 'REVIEW_REQUIRED' && approvalsRequired > 0 && (
          <PullRequestRole data-testid="pr-review-requirement" as="div" role="approval-requirement">
            <span>Review · {approvalsRequired} approval{approvalsRequired === 1 ? '' : 's'} required</span>
            <span data-review-count>{Math.min(approvalsReceived, approvalsRequired)} / {approvalsRequired}</span>
          </PullRequestRole>
        )}
        {detail.reviews_total > 0 && <PrReviews detail={detail} />}
        {(detail.threads.length > 0 || detail.threads_message !== null || detail.threads_truncated) && (
          <PrThreads
            detail={detail}
            busy={busy}
            number={number}
            onSendToOrchestrator={onSendToOrchestrator}
            onReply={(threadId, body) => pr.threadReply(number, threadId, body)}
            onResolve={(threadId, resolved) => pr.threadResolve(number, threadId, resolved)}
            onReact={(subjectId, content, reacted) => pr.react(number, subjectId, content, reacted)}
          />
        )}
        <PrComments
          detail={detail}
          busy={busy}
          onComment={(body) => pr.comment(number, body)}
          onCommentEdit={(commentId, body) => pr.commentEdit(number, commentId, 'issue_comment', body)}
          onReact={(subjectId, content, reacted) => pr.react(number, subjectId, content, reacted)}
        />
        {reviewBar}
      </Card>
    </PrSummary>
  )
}

function PrDetailBody({
  pane,
  compact,
  link,
  detail,
  pr,
  number,
  busy,
  mergeReason,
  approvalsRequired,
  approvalsReceived,
  onOpenUrlInPane,
  onSendToOrchestrator,
  checkState,
  reviewBar,
  watchRows,
  openPicker,
  setOpenPicker,
  drafts,
  onAddDraft,
  scrollRef,
  onScroll
}: {
  pane: 'summary' | 'timeline' | 'files'
  compact: boolean
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
  checkState: ReturnType<typeof usePrChecksState>
  reviewBar: React.ReactNode
  watchRows: React.ReactNode
  openPicker: 'reviewers' | 'labels' | 'stack' | null
  setOpenPicker: (value: 'reviewers' | 'labels' | 'stack' | null) => void
  drafts: PrReviewDraft[]
  onAddDraft: (draft: PrReviewDraft) => void
  scrollRef: React.RefObject<HTMLDivElement | null>
  onScroll?: React.UIEventHandler<HTMLDivElement>
}): React.JSX.Element {
  return (
    <PrTab as="div" surface="pr-scroll-area"
      ref={scrollRef}
      data-testid="pr-scroll-area"
      onScroll={onScroll}
    >
      {compact && pane === 'summary' ? (
        <PrInspectorBoard
          link={link}
          detail={detail}
          pr={pr}
          number={number}
          busy={busy}
          mergeReason={mergeReason}
          approvalsRequired={approvalsRequired}
          approvalsReceived={approvalsReceived}
          onSendToOrchestrator={onSendToOrchestrator}
          checkState={checkState}
          reviewBar={reviewBar}
          watchRows={watchRows}
          openPicker={openPicker}
          setOpenPicker={setOpenPicker}
        />
      ) : pane === 'files' ? (
        <PullRequestRole as="div" role="file-pane" className={compact ? '!p-0 !gap-0' : ''}>
          <PrFiles
            key={number}
            diff={pr.diff}
            loading={pr.diffBusy}
            drafts={drafts}
            writeBusy={busy}
            onAddDraft={onAddDraft}
            onReload={() => pr.loadDiff(number)}
          />
        </PullRequestRole>
      ) : compact && pane === 'timeline' ? (
        <PrTimelineSummary detail={detail} />
      ) : (
        <PrDetailStandardSummary
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
          checkState={checkState}
          openPicker={openPicker}
          setOpenPicker={setOpenPicker}
          reviewBar={reviewBar}
        />
      )}
    </PrTab>
  )
}

function PrDetailView({
  view,
  client,
  dir,
  link,
  detail,
  pr,
  method,
  setMethod,
  onOpenUrlInPane,
  onSendToOrchestrator,
  checkAgentTargets,
  onPasteToAgent,
  onCreateCheckAgent,
  onOpenPane,
  onBrowse,
  linkMessage,
  compact,
  watchRows
}: {
  client: HoustonClient | null
  dir: string | null
  compact: boolean
  view: PrDetailView
  link: PullRequestLink
  detail: PrDetail
  pr: PrDetailController
  method: PrMergeMethod
  setMethod: (method: PrMergeMethod) => void
  onOpenUrlInPane?: (url: string) => void
  onSendToOrchestrator?: (text: string) => void
  checkAgentTargets?: CheckAgentTarget[]
  onPasteToAgent?: (session: number, text: string) => void
  onCreateCheckAgent?: ((provider: string, text: string) => void) | ((provider: string, text: string) => Promise<number | null>)
  onOpenPane?: (session: number) => void
  onBrowse: () => void
  linkMessage: React.ReactNode
  watchRows: React.ReactNode
}): React.JSX.Element {
  const [pane, setPane] = useState<'summary' | 'timeline' | 'files'>('summary')
  const [drafts, setDrafts] = useState<PrReviewDraft[]>([])
  const [reviewVerdict, setReviewVerdict] = useState<PrReviewVerdict>('comment')
  const [reviewBody, setReviewBody] = useState('')
  const [reviewDraftsOpen, setReviewDraftsOpen] = useState(false)
  const [commentOpen, setCommentOpen] = useState(false)
  const [commentDraft, setCommentDraft] = useState('')
  const commentMotion = useExitAnimation(compact && commentOpen, 150)
  const [openPicker, setOpenPicker] = useState<'reviewers' | 'labels' | 'stack' | null>(null)
  const [condensed, setCondensed] = useState(false)
  const condensedState = useRef(false)
  const foldRef = useRef<HTMLDivElement | null>(null)
  const condensedRef = useRef<HTMLDivElement | null>(null)
  const checkState = usePrChecksState({ client, dir, number: link.number, url: link.url, branch: detail.head_ref ?? null, checks: detail.checks, agents: checkAgentTargets, onPasteToAgent, onCreateAgent: onCreateCheckAgent ? (provider, text) => Promise.resolve(onCreateCheckAgent(provider, text)).then((session) => session ?? null) : undefined, onOpenUrl: onOpenUrlInPane, onOpenPane })
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const preloadedCodePr = useRef<number | null>(null)
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
    setCommentOpen(false)
    setCommentDraft('')
    setOpenPicker(null)
    condensedState.current = false
    setCondensed(false)
  }, [number])

  const onDetailScroll = (event: React.UIEvent<HTMLDivElement>): void => {
    if (!compact) return
    const scroll = event.currentTarget
    const foldHeight = foldRef.current?.scrollHeight ?? 0
    if (!condensedState.current && scroll.scrollTop > foldHeight + 32) {
      condensedState.current = true
      setCondensed(true)
      scroll.scrollTop -= Math.max(0, foldHeight - (condensedRef.current?.scrollHeight ?? 0))
    } else if (condensedState.current && scroll.scrollTop < 4) {
      condensedState.current = false
      setCondensed(false)
    }
  }

  const preloadCode = (target: EventTarget): void => {
    if (!compact || !(target instanceof Element) || !target.closest('[data-testid="pr-pane-code"]') || preloadedCodePr.current === number) return
    preloadedCodePr.current = number
    pr.loadDiff(number)
  }

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
      compact={compact}
    />
  )


  return (
    <PullRequestRole data-testid="pr-tab" as="div" role="tab-frame">
      {compact && <PrBranchHeader link={link} detail={detail} actionBar={actionBar} condensed={condensed} foldRef={foldRef} condensedRef={condensedRef} />}
      <PrDetailToolbar
        compact={compact}
        pane={pane}
        detail={detail}
        checkState={checkState}
        onBrowse={onBrowse}
        pr={pr}
        preloadCode={preloadCode}
        onChangePane={(value) => {
          setPane(value)
          condensedState.current = false
          setCondensed(false)
          if (scrollRef.current) scrollRef.current.scrollTop = 0
          if (value === 'files' && preloadedCodePr.current !== number) {
            preloadedCodePr.current = number
            pr.loadDiff(number)
          }
        }}
      />
      <PrNotices pr={pr} linkMessage={linkMessage} />
      <PrDetailBody
        pane={pane}
        compact={compact}
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
        checkState={checkState}
        reviewBar={reviewBar}
        watchRows={watchRows}
        openPicker={openPicker}
        setOpenPicker={setOpenPicker}
        drafts={drafts}
        onAddDraft={addDraft}
        scrollRef={scrollRef}
        onScroll={onDetailScroll}
      />
      {compact && <>
        {commentMotion.mounted && <PrTab as="div" surface="pr-comment-composer" state={commentMotion.closing ? 'closing' : undefined} data-testid="pr-comment-popover" aria-hidden={commentMotion.closing || undefined}>
          <TextArea surface="background" aria-label="New pull request comment" rows={3} value={commentDraft} onChange={(event) => setCommentDraft(event.target.value)} placeholder="Write a comment" autoFocus />
          <PrTab as="div" surface="pr-comment-actions">
            <Button variant="ghost" size="sm" type="button" onClick={() => setCommentOpen(false)}>Cancel</Button>
            <ReviewButton variant="primary-action" size="sm" type="button" disabled={busy || commentDraft.trim().length === 0} onClick={() => { pr.comment(number, commentDraft); setCommentDraft(''); setCommentOpen(false) }}>Comment</ReviewButton>
          </PrTab>
        </PrTab>}
        <PrTab as="div" surface="pr-comment-fab-host"><Tooltip label="Comment on pull request">
          <PrTab as="button" surface="pr-comment-fab" type="button" aria-label="Comment on pull request" aria-expanded={commentOpen} onClick={() => setCommentOpen((open) => !open)}><Icon glyph={IconMessageSquare} role="small" /></PrTab>
        </Tooltip></PrTab>
      </>}
      {!compact && pane === 'files' && reviewBar}
      {!compact && pane === 'summary' && actionBar}
    </PullRequestRole>
  )
}

function PullRequestTabContent({
  client,
  dir,
  active,
  browsing,
  setBrowsing,
  list,
  pr,
  view,
  linkMessageText,
  method,
  setMethod,
  compact,
  watchRows,
  onOpenUrlInPane,
  onSendToOrchestrator,
  checkAgentTargets,
  onPasteToAgent,
  onCreateCheckAgent,
  onOpenPane,
  onShowChanges,
}: {
  client: HoustonClient | null
  dir: string | null
  active: boolean
  browsing: boolean
  setBrowsing: React.Dispatch<React.SetStateAction<boolean>>
  list: ReturnType<typeof usePrList>
  pr: PrDetailController
  view: PrDetailView | null
  linkMessageText: string | null
  method: PrMergeMethod
  setMethod: React.Dispatch<React.SetStateAction<PrMergeMethod>>
  compact: boolean
  watchRows: React.ReactNode[]
  onOpenUrlInPane?: (url: string) => void
  onSendToOrchestrator?: (text: string) => void
  checkAgentTargets?: CheckAgentTarget[]
  onPasteToAgent?: (session: number, text: string) => void
  onCreateCheckAgent?: PullRequestTabProps['onCreateCheckAgent']
  onOpenPane?: (session: number) => void
  onShowChanges?: () => void
}): React.JSX.Element {
  if (!dir || !client) return <PrIdle />
  if (!active) return <PullRequestRole data-testid="pr-idle" as="div" role="fill" />

  if (browsing) {
    return (
      <PrWatchContent rows={watchRows}>
        <PrBrowse
          list={list}
          active
          onBack={() => setBrowsing(false)}
          onSelect={(number) => {
            setBrowsing(false)
            pr.show(number)
          }}
        />
      </PrWatchContent>
    )
  }

  if (view === null) {
    return (
      <PrWatchContent rows={watchRows}>
        <PullRequestRole data-testid="pr-loading" as="div" role="empty-panel">
          <PullRequestRole as="span" role="loading-indicator">
            <Icon glyph={IconLoaderCircle} role="subhead" />
          </PullRequestRole>
        </PullRequestRole>
      </PrWatchContent>
    )
  }

  const linkMessage = linkMessageText !== null ? (
    <ScmNotice tone="danger" testId="pr-link-message">
      {linkMessageText}
    </ScmNotice>
  ) : null

  if (view.gh !== 'ready') return <PrWatchContent rows={watchRows}><PrBlocked gh={view.gh} hint={view.hint} onRetry={pr.refresh} /></PrWatchContent>
  if (view.message !== null || view.link === null) {
    return (
      <PrWatchContent rows={watchRows}>
        <PrEmpty
          view={view}
          pr={pr}
          onShowChanges={onShowChanges}
          onBrowse={() => setBrowsing(true)}
          linkMessage={linkMessage}
        />
      </PrWatchContent>
    )
  }
  if (view.detail === null) {
    return <PrWatchContent rows={watchRows}><PrReadError view={view} link={view.link} pr={pr} linkMessage={linkMessage} /></PrWatchContent>
  }
  return (
    <PrWatchContent rows={watchRows} showRows={!compact}>
      <PrDetailView
        compact={compact}
        client={client}
        dir={dir}
        view={view}
        link={view.link}
        detail={view.detail}
        pr={pr}
        method={method}
        setMethod={setMethod}
        onOpenUrlInPane={onOpenUrlInPane}
        onSendToOrchestrator={onSendToOrchestrator}
        checkAgentTargets={checkAgentTargets}
        onPasteToAgent={onPasteToAgent}
        onCreateCheckAgent={onCreateCheckAgent}
        onOpenPane={onOpenPane}
        onBrowse={() => setBrowsing(true)}
        linkMessage={linkMessage}
        watchRows={compact ? watchRows : null}
      />
    </PrWatchContent>
  )
}

export function PullRequestTab({
  client,
  dir,
  session = null,
  onOpenUrlInPane,
  onSendToOrchestrator,
  checkAgentTargets,
  onPasteToAgent,
  onCreateCheckAgent,
  onOpenPane,
  onShowChanges,
  active = true,
  onPrPresenceChange,
  refreshSignal = 0,
  compact = false,
  requestedPr = null
}: PullRequestTabProps): React.JSX.Element {
  const pr = usePrDetail(client, dir, active, refreshSignal)
  const handledRequestedPr = useRef<string | null>(null)
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

  useEffect(() => {
    const requestKey = requestedPr ? `${requestedPr.number}:${requestedPr.nonce}` : null
    if (requestedPr && active && pr.view !== null && pr.view.link?.number !== requestedPr.number && handledRequestedPr.current !== requestKey) {
      handledRequestedPr.current = requestKey
      pr.show(requestedPr.number)
    }
  }, [active, pr.show, pr.view, requestedPr?.number, requestedPr?.nonce])

  return (
    <PullRequestTabContent
      client={client}
      dir={dir}
      active={active}
      browsing={browsing}
      setBrowsing={setBrowsing}
      list={list}
      pr={pr}
      view={pr.view}
      linkMessageText={pr.linkMessage}
      method={method}
      setMethod={setMethod}
      compact={compact}
      watchRows={watchRows}
      onOpenUrlInPane={onOpenUrlInPane}
      onSendToOrchestrator={onSendToOrchestrator}
      checkAgentTargets={checkAgentTargets}
      onPasteToAgent={onPasteToAgent}
      onCreateCheckAgent={onCreateCheckAgent}
      onOpenPane={onOpenPane}
      onShowChanges={onShowChanges}
    />
  )
}
