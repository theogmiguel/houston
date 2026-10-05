import { useNativeSuppression } from '../layout/nativeSuppression'
import { saveReview } from '../houston/bridge'
import { buildStructuredReviewPrompt, structuredReviewPrompt } from '../git/review'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { HoustonClient } from '../houston/client'
import type { ReviewDiffsData } from '../git/review'
import { branchChipLabel } from './git/changes'
import type { ChangesReview, ChangesSummary } from './ChangesPane'
import { BTN_ICO_STRUCTURE } from './buttonChrome'
import {
  SEG_ITEM_CLS,
  SEG_ITEM_OFF_CLS,
  SEG_ITEM_ON_CLS,
  SEG_TRACK_CLS
} from './segmentedChrome'
import { CONTROL_SIZE_SQUARE_CLS } from './controlSize'
import { IconGitBranch, IconRefresh } from './icons'
import { Tooltip } from './Tooltip'
import { Icon } from './Icon'
import { MATERIAL_CLS, materialAttrs } from './material'
import {
  SCM_WIDTH_MIN,
  clampScmWidth,
  scmWidthMax,
  stepScmWidth,
  type ScmTab
} from '../scmPanel'
import type { PrPresenceTone } from './git/PullRequestTab'

const ChangesPane = lazy(() =>
  import('./ChangesPane').then((m) => ({ default: m.ChangesPane }))
)

const PullRequestTab = lazy(() =>
  import('./git/PullRequestTab').then((m) => ({ default: m.PullRequestTab }))
)

const ICO_BASE =
  `${CONTROL_SIZE_SQUARE_CLS.mini} rounded-[var(--tr-radius-sm)] bg-transparent ` +
  'text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] ' +
  'hover:bg-[color-mix(in_srgb,var(--text-primary)_10%,transparent)] hover:text-[var(--text-primary)] ' +
  'focus-visible:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] focus-visible:text-[var(--text-primary)] focus-visible:outline-none ' +
  'disabled:opacity-45 disabled:cursor-not-allowed'

const PR_DOT_TONE: Record<PrPresenceTone, string> = {
  ok: 'bg-[var(--ok)]',
  warn: 'bg-[var(--warn)]',
  stop: 'bg-[var(--stop)]'
}

export interface SourceControlPanelProps {
  onChangedCount?: (count: number) => void
  hideHeader?: boolean
  onSummaryChange?: (summary: ChangesSummary) => void
  reviewTarget?: number
  embedded?: boolean
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
  onReviewPacket?: (data: ReviewDiffsData) => void
  review?: ChangesReview | null
  // The grid hides rather than unmounts under an overlay; the panel keeps its
  // place (and its commit draft) the same way, but stops taking input.
  hiddenByOverlay?: boolean
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
  return (
    <button
      type="button"
      role="tab"
      data-tab={tab}
      data-testid={`scm-tab-${tab}`}
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={() => onSelect(tab)}
      onKeyDown={onKeyDown}
      className={`${SEG_ITEM_CLS} gap-1.5 ${active ? SEG_ITEM_ON_CLS : SEG_ITEM_OFF_CLS}`}
    >
      {compactLabel !== undefined ? (
        <>
          <span className="[@container_(max-width:420px)]:hidden">{label}</span>
          <span className="hidden [@container_(max-width:420px)]:inline">{compactLabel}</span>
        </>
      ) : (
        label
      )}
      {badge}
    </button>
  )
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
    <div
      data-testid="scm-resize-handle"
      data-dragging={dragging ? 'true' : undefined}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize source control"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={rendered}
      tabIndex={0}
      className="absolute inset-y-0 -left-1 z-[var(--z-pane)] w-2 cursor-col-resize touch-none bg-transparent focus-visible:outline-none after:content-[''] after:absolute after:inset-0 after:mx-auto after:w-px after:rounded-full after:bg-transparent motion-safe:after:[transition:background-color_0.1s_ease-out] focus-visible:after:bg-[var(--text-faint)] data-[dragging]:after:bg-[var(--text-faint)]"
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
  onReviewPacket,
  review = null,
  hiddenByOverlay = false
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
  const [prVisited, setPrVisited] = useState(false)
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
    <aside
      ref={rootRef}
      data-testid="source-control-panel"
      data-tab={tab}
      data-dir={dir ?? undefined}
      aria-label="Source control"
      aria-hidden={hiddenByOverlay || undefined}
      inert={hiddenByOverlay}
      className={`relative flex-none h-full min-h-0 flex flex-col overflow-visible @container ${MATERIAL_CLS.shell} ${hiddenByOverlay ? 'invisible' : ''}`}
      style={{ width: embedded ? "100%" : rendered, maxWidth: '100%' }}
      {...materialAttrs('shell')}
    >
      {!embedded && <ScmResizeHandle
        requested={width}
        rendered={rendered}
        hostWidth={hostWidth}
        onWidth={onWidth}
        onReset={onResetWidth}
      />}
      <div className="flex-1 min-h-0 flex flex-col gap-1 overflow-hidden">
      {!hideHeader && <SourceControlHeader dir={dir} client={client} tab={tab} onTab={onTab} summary={summary} hasPr={hasPr} prTone={prTone} branchText={branchText} review={review} refresh={refresh} />}
      <div className="flex-1 min-h-0 flex flex-col">
        <div
          className={`flex-1 min-h-0 flex-col ${tab === 'changes' ? 'flex' : 'hidden'}`}
          data-testid="scm-changes-tab"
        >
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
              onSummary={onSummary}
              refreshSignal={changesRefresh}
            />
          </Suspense>
        </div>
        {prVisited && (
          <div
            className={`flex-1 min-h-0 flex-col ${tab === 'pull-request' ? 'flex' : 'hidden'}`}
            data-testid="scm-pr-tab"
          >
            <Suspense fallback={<div className="flex-1" />}>
              <PullRequestTab
                key={dir ?? 'none'}
                client={client}
                dir={dir}
                session={session}
                onOpenUrlInPane={onOpenUrlInPane}
                onShowChanges={() => onTab('changes')}
                compact={embedded}
                active={tab === 'pull-request'}
                refreshSignal={prRefresh}
                onPrPresenceChange={onPrPresenceChange}
              />
            </Suspense>
          </div>
        )}
      </div>
      {reviewTarget != null && <ReviewForm reviewTarget={reviewTarget} client={client} dir={dir} comments={comments} setComments={setComments} reviewError={reviewError} setReviewError={setReviewError} pendingChildReview={pendingChildReview} />}
      </div>
    </aside>
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
  return <form aria-label={`Review session ${reviewTarget}`} className="flex-none flex flex-col gap-2 p-2 border-t border-[var(--divider)]" onSubmit={submit}>
    <textarea aria-label="Diff comments" placeholder={`Comments for session ${reviewTarget}`} value={comments} onChange={(event) => setComments(event.target.value)} className="min-w-0 bg-[var(--tool-code-bg)] text-[var(--text-primary)]" />
    <button className="btn border-none" disabled={!client || !dir || !comments.trim()}>Send comments to child</button>
    {reviewError && <span role="alert">{reviewError}</span>}
  </form>
}

function SourceControlHeader({ dir, client, tab, onTab, summary, hasPr, prTone, branchText, review, refresh }: Pick<SourceControlPanelProps, 'dir' | 'client' | 'tab' | 'onTab' | 'review'> & {
  summary: ChangesSummary | null
  hasPr: boolean
  prTone: PrPresenceTone
  branchText: string
  refresh: () => void
}): React.JSX.Element {
  return (<header className="scbar flex-none flex items-center gap-2 h-[var(--h-pane-head)] pl-2.5 pr-1.5 overflow-hidden">
        <span className="min-w-0 truncate text-[length:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-primary)]">
          {dir ? repoName(dir) : 'No workspace'}
        </span>
        <span
          data-testid="scm-head-sub"
          className="flex-none inline-flex items-center gap-1.5 font-mono text-[length:var(--tr-text-small-size)] text-[var(--text-faint)] min-w-0 truncate"
        >
          {!review && summary ? (
            <Icon glyph={IconGitBranch} role="label" className="flex-none" />
          ) : null}
          {branchText}
        </span>
        <span className="flex-1" />
      <div
        role="tablist"
        aria-label="Source control"
        className={`${SEG_TRACK_CLS} flex-none`}
      >
        <PanelTab
          tab="changes"
          label="Changes"
          active={tab === 'changes'}
          onSelect={onTab}
          badge={
            summary && summary.changed > 0 ? (
              <span
                data-testid="scm-changes-count"
                className="font-mono text-[length:var(--tr-text-small-size)] text-[var(--text-faint)] tabular-nums"
              >
                {summary.changed}
              </span>
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
              <span
                data-testid="scm-pr-dot"
                aria-hidden
                className={`w-1.5 h-1.5 rounded-full ${PR_DOT_TONE[prTone]}`}
              />
            ) : undefined
          }
        />
      </div>
        <Tooltip label="Refresh">
          <button
            className={`btn ${BTN_ICO_STRUCTURE} ${ICO_BASE}`}
            aria-label="Refresh"
            data-testid="scm-refresh"
            disabled={!client || !dir}
            onClick={refresh}
          >
            <Icon glyph={IconRefresh} role="ui" />
          </button>
        </Tooltip>
      </header>)
}
