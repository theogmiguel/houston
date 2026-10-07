import { useNativeSuppression } from '../layout/nativeSuppression'
import { saveReview } from '../houston/bridge'
import { buildStructuredReviewPrompt, structuredReviewPrompt } from '../git/review'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { HoustonClient } from '../houston/client'
import type { ReviewDiffsData } from '../git/review'
import { branchChipLabel } from './git/changes'
import type { ChangesReview, ChangesSummary } from './ChangesPane'
import { IconGitBranch, IconRefresh } from './icons'
import { Tooltip } from './ui/Tooltip'
import { Icon } from './ui/Icon'
import { Button } from './ui/Button'
import { Text } from './ui/Text'
import { CompactTab, CompactTabList, GitPresenceDot, SourceControlContentStack, SourceControlHeaderBar, SourceControlPanelSurface, SourceControlResizeSurface, SourceControlReviewField, SourceControlReviewFormSurface, SourceControlReviewSubmit, SourceControlTabSurface, SourceControlViewStack } from './ui'
import {
  SCM_WIDTH_MIN,
  clampScmWidth,
  scmWidthMax,
  stepScmWidth,
  type ScmTab
} from '../scmPanel'
import type { PrPresenceTone } from './git/PullRequestTab'
import type { CheckAgentTarget } from './prs/ChecksList'

const ChangesPane = lazy(() =>
  import('./ChangesPane').then((m) => ({ default: m.ChangesPane }))
)

const PullRequestTab = lazy(() =>
  import('./git/PullRequestTab').then((m) => ({ default: m.PullRequestTab }))
)

export interface SourceControlPanelProps {
  onChangedCount?: (count: number) => void
  hideHeader?: boolean
  onSummaryChange?: (summary: ChangesSummary) => void
  reviewTarget?: number
  embedded?: boolean
  checkoutLabel?: string
  dir: string | null
  session?: number | null
  client: HoustonClient | null
  width: number
  onWidth: (px: number) => void
  onResetWidth: () => void
  tab: ScmTab
  onTab: (tab: ScmTab) => void
  onOpenFileInEditor?: (absPath: string) => void
  onOpenUrlInPane?: (url: string) => void
  onSendToTerminal?: (text: string) => void
  onReviewPacket?: (data: ReviewDiffsData) => void
  review?: ChangesReview | null
  // The grid hides rather than unmounts under an overlay; the panel keeps its
  // place (and its commit draft) the same way, but stops taking input.
  hiddenByOverlay?: boolean
  checkAgentTargets?: CheckAgentTarget[]
  onPasteToAgent?: (session: number, text: string) => void
  onCreateCheckAgent?: (provider: string, text: string) => void
  onOpenPane?: (session: number) => void
  requestedPr?: { number: number; nonce: number } | null
}

function repoName(dir: string): string {
  const parts = dir.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || dir
}

function PanelTab({
  tab,
  label,
  compactLabel,
  badge,
  active,
  onSelect
}: {
  tab: ScmTab
  label: string
  compactLabel?: string
  badge?: React.ReactNode
  active: boolean
  onSelect: (tab: ScmTab) => void
}): React.JSX.Element {
  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const next: ScmTab = tab === 'changes' ? 'pull-request' : 'changes'
    onSelect(next)
    e.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)
      ?.focus()
  }
  return <CompactTab value={tab} label={label} compactLabel={compactLabel} badge={badge} selected={active} onSelect={() => onSelect(tab)} onKeyDown={onKeyDown} />
}

// The divider between the grid and the panel, deliberately the terminal
// splitter's own clothes: an 8px strip with a 1px line that only shows while
// dragging or focused, arrow keys on the same 4% step, double-click resets.
export function ScmResizeHandle({
  requested,
  rendered,
  hostWidth,
  onWidth,
  onReset
}: {
  requested: number
  rendered: number
  hostWidth: number
  onWidth: (px: number) => void
  onReset: () => void
}): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  useNativeSuppression('animating', dragging)
  // `requested` is the stored preference a cancel falls back to; `base` is
  // what the divider actually shows, so a clamp-shortened panel still tracks
  // the pointer instead of waiting for the delta to exceed the clamp gap.
  const drag = useRef<{
    pointerId: number
    requested: number
    base: number
    startX: number
  } | null>(null)
  const latestX = useRef(0)
  const frame = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (frame.current !== null) window.cancelAnimationFrame(frame.current)
    },
    []
  )

  const flush = (): void => {
    frame.current = null
    const d = drag.current
    if (!d) return
    onWidth(clampScmWidth(d.base - (latestX.current - d.startX), hostWidth))
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>, commit: boolean): void => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    if (frame.current !== null) {
      window.cancelAnimationFrame(frame.current)
      frame.current = null
    }
    if (commit && e.clientX !== d.startX) {
      // Commit the pointerup position itself: a quick drag can release before
      // the last animation frame ever ran.
      onWidth(clampScmWidth(d.base - (e.clientX - d.startX), hostWidth))
    } else {
      onWidth(d.requested)
    }
    drag.current = null
    setDragging(false)
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }

  const max = scmWidthMax(hostWidth)
  const min = Math.min(SCM_WIDTH_MIN, max)

  return (
    <SourceControlResizeSurface
      data-testid="scm-resize-handle"
      data-dragging={dragging ? 'true' : undefined}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize source control"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={rendered}
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault()
        drag.current = {
          pointerId: e.pointerId,
          requested,
          base: rendered,
          startX: e.clientX
        }
        e.currentTarget.setPointerCapture?.(e.pointerId)
        setDragging(true)
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d || d.pointerId !== e.pointerId) return
        latestX.current = e.clientX
        if (frame.current !== null) return
        frame.current = window.requestAnimationFrame(flush)
      }}
      onPointerUp={(e) => endDrag(e, true)}
      onPointerCancel={(e) => endDrag(e, false)}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          onWidth(stepScmWidth(rendered, 1, hostWidth))
        } else if (e.key === 'ArrowRight') {
          e.preventDefault()
          onWidth(stepScmWidth(rendered, -1, hostWidth))
        } else if (e.key === 'Home') {
          e.preventDefault()
          onReset()
        }
      }}
    />
  )
}

export function SourceControlPanel({
  onChangedCount,
  hideHeader = false,
  onSummaryChange,
  reviewTarget,
  embedded = false,
  checkoutLabel,
  dir,
  session,
  client,
  width,
  onWidth,
  onResetWidth,
  tab,
  onTab,
  onOpenFileInEditor,
  onOpenUrlInPane,
  onSendToTerminal,
  onReviewPacket,
  review = null,
  hiddenByOverlay = false,
  checkAgentTargets,
  onPasteToAgent,
  onCreateCheckAgent,
  onOpenPane,
  requestedPr
}: SourceControlPanelProps): React.JSX.Element {
  const [comments, setComments] = useState('')
  const [reviewError, setReviewError] = useState<string | null>(null)
  const reviewPacketCallback = useRef(onReviewPacket)
  reviewPacketCallback.current = onReviewPacket
  const pendingChildReview = useRef<{ target: number; comments: string } | null>(null)
  useEffect(() => {
    setComments('')
    pendingChildReview.current = null
    if (!client || !dir || reviewTarget == null) return
    const off = client.subscribe('git_review_diffs', (data) => {
      const request = pendingChildReview.current
      if (data.dir !== dir || !request) return
      pendingChildReview.current = null
      void saveReview(`${buildStructuredReviewPrompt(data)}\n\nOperator comments:\n${request.comments}`)
        .then((file) => {
          reviewPacketCallback.current?.(data)
          if (!client.sendStdin(request.target, `\x1b[200~${structuredReviewPrompt(file)}\x1b[201~`)) throw new Error(`Cannot send review to session ${request.target}: expected an attached terminal transport`)
        }).catch((error) => setReviewError(String(error)))
    })
    return off
  }, [client, dir, reviewTarget])
  const rootRef = useRef<HTMLElement | null>(null)
  const [hostWidth, setHostWidth] = useState(0)
  const [summary, setSummary] = useState<ChangesSummary | null>(null)
  const [prVisited, setPrVisited] = useState(tab === 'pull-request')
  const [hasPr, setHasPr] = useState(false)
  const [prTone, setPrTone] = useState<PrPresenceTone>('ok')
  const [changesRefresh, setChangesRefresh] = useState(0)
  const [prRefresh, setPrRefresh] = useState(0)

  // The host is the row that holds the grid and the panel; its width is what
  // the clamp spends. Measuring it here keeps the panel self-contained.
  useEffect(() => {
    const host = rootRef.current?.parentElement
    if (!host || typeof ResizeObserver === 'undefined') return
    const measure = (): void => setHostWidth(host.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    setSummary(null)
    setHasPr(false)
    setPrTone('ok')
  }, [dir])

  useEffect(() => {
    if (tab === 'pull-request') setPrVisited(true)
  }, [tab])

  const onSummary = useCallback((next: ChangesSummary): void => {
    setSummary(next)
    onChangedCount?.(next.changed)
    onSummaryChange?.(next)
    setHasPr(next.hasPr)
    setPrTone(next.prTone)
  }, [onChangedCount, onSummaryChange])

  const onPrPresenceChange = useCallback((exists: boolean, tone: PrPresenceTone = 'ok'): void => {
    setHasPr(exists)
    setPrTone(tone)
  }, [])

  // The refresh belongs to the visible tab: Changes re-asks its status, the PR
  // tab gets a new signal and keeps whatever the user was doing.
  const refresh = (): void => {
    if (tab === 'pull-request') setPrRefresh((n) => n + 1)
    else setChangesRefresh((n) => n + 1)
  }

  const rendered = clampScmWidth(width, hostWidth)
  const branchText = review
    ? `reviewing by ${review.codename}`
    : summary
      ? branchChipLabel(summary.branch, summary.ahead, summary.behind)
      : ''

  return (
    <SourceControlPanelSurface
      ref={rootRef}
      data-testid="source-control-panel"
      data-tab={tab}
      data-dir={dir ?? undefined}
      aria-label="Source control"
      aria-hidden={hiddenByOverlay || undefined}
      inert={hiddenByOverlay}
      hidden={hiddenByOverlay}
      style={{ width: embedded ? "100%" : rendered, maxWidth: '100%' }}
    >
      {!embedded && <ScmResizeHandle
        requested={width}
        rendered={rendered}
        hostWidth={hostWidth}
        onWidth={onWidth}
        onReset={onResetWidth}
      />}
      <SourceControlContentStack>
      {!hideHeader && <SourceControlHeader dir={dir} client={client} tab={tab} onTab={onTab} summary={summary} hasPr={hasPr} prTone={prTone} branchText={branchText} review={review} refresh={refresh} />}
      <SourceControlViewStack>
        <SourceControlTabSurface active={tab === 'changes'} testId="scm-changes-tab">
          <Suspense fallback={<div className="flex-1" />}>
            <ChangesPane
              key={dir ?? 'none'}
              client={client}
              dir={dir}
              onOpenFileInEditor={onOpenFileInEditor}
              onOpenUrlInPane={onOpenUrlInPane}
              onReviewPacket={onReviewPacket}
              review={review}
              compact={embedded}
              checkoutLabel={checkoutLabel}
              onSummary={onSummary}
              refreshSignal={changesRefresh}
            />
          </Suspense>
        </SourceControlTabSurface>
        {prVisited && (
          <SourceControlTabSurface active={tab === 'pull-request'} testId="scm-pr-tab">
            <Suspense fallback={<div className="flex-1" />}>
              <PullRequestTab
                key={dir ?? 'none'}
                client={client}
                dir={dir}
                session={session}
                onOpenUrlInPane={onOpenUrlInPane}
                onSendToOrchestrator={onSendToTerminal}
                onShowChanges={() => onTab('changes')}
                compact={embedded}
                active={tab === 'pull-request'}
                refreshSignal={prRefresh}
                onPrPresenceChange={onPrPresenceChange}
                checkAgentTargets={checkAgentTargets}
                onPasteToAgent={onPasteToAgent}
                onCreateCheckAgent={onCreateCheckAgent}
                onOpenPane={onOpenPane}
                requestedPr={requestedPr}
              />
            </Suspense>
          </SourceControlTabSurface>
        )}
      </SourceControlViewStack>
      {reviewTarget != null && <ReviewForm reviewTarget={reviewTarget} client={client} dir={dir} comments={comments} setComments={setComments} reviewError={reviewError} setReviewError={setReviewError} pendingChildReview={pendingChildReview} />}
      </SourceControlContentStack>
    </SourceControlPanelSurface>
  )
}

function ReviewForm({ reviewTarget, client, dir, comments, setComments, reviewError, setReviewError, pendingChildReview }: {
  reviewTarget: number
  client: HoustonClient | null
  dir: string | null
  comments: string
  setComments: (value: string) => void
  reviewError: string | null
  setReviewError: (value: string | null) => void
  pendingChildReview: { current: { target: number; comments: string } | null }
}): React.JSX.Element {
  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!client || !dir || !comments.trim()) return
    setReviewError(null)
    pendingChildReview.current = { target: reviewTarget, comments }
    client.gitReviewDiffs(dir)
  }
  return <SourceControlReviewFormSurface aria-label={`Review session ${reviewTarget}`} onSubmit={submit}>
    <SourceControlReviewField aria-label="Diff comments" placeholder={`Comments for session ${reviewTarget}`} value={comments} onChange={(event) => setComments(event.target.value)} />
    <SourceControlReviewSubmit disabled={!client || !dir || !comments.trim()}>Send comments to child</SourceControlReviewSubmit>
    {reviewError && <span role="alert">{reviewError}</span>}
  </SourceControlReviewFormSurface>
}

function SourceControlHeader({ dir, client, tab, onTab, summary, hasPr, prTone, branchText, review, refresh }: Pick<SourceControlPanelProps, 'dir' | 'client' | 'tab' | 'onTab' | 'review'> & {
  summary: ChangesSummary | null
  hasPr: boolean
  prTone: PrPresenceTone
  branchText: string
  refresh: () => void
}): React.JSX.Element {
  return (<SourceControlHeaderBar>
        <Text size="small" weight="small" tone="primary" className="min-w-0 truncate">
          {dir ? repoName(dir) : 'No workspace'}
        </Text>
        <Text
          as="span" size="small" mono tone="faint"
          data-testid="scm-head-sub"
          className="flex-none inline-flex items-center gap-1.5 min-w-0 truncate"
        >
          {!review && summary ? (
            <Icon glyph={IconGitBranch} role="label" className="flex-none" />
          ) : null}
          {branchText}
        </Text>
        <span className="flex-1" />
      <CompactTabList aria-label="Source control" className="flex-none">
        <PanelTab
          tab="changes"
          label="Changes"
          active={tab === 'changes'}
          onSelect={onTab}
          badge={
            summary && summary.changed > 0 ? (
              <Text
                as="span" size="small" mono tone="faint" tabular
                data-testid="scm-changes-count"
              >
                {summary.changed}
              </Text>
            ) : undefined
          }
        />
        <PanelTab
          tab="pull-request"
          label="Pull request"
          active={tab === 'pull-request'}
          onSelect={onTab}
          badge={
            hasPr ? (
              <GitPresenceDot
                tone={prTone}
                data-testid="scm-pr-dot"
              />
            ) : undefined
          }
        />
      </CompactTabList>
        <Tooltip label="Refresh">
          <Button
            variant="icon-structure"
            icon={IconRefresh}
            aria-label="Refresh"
            data-testid="scm-refresh"
            disabled={!client || !dir}
            onClick={refresh}
          />
        </Tooltip>
      </SourceControlHeaderBar>)
}
