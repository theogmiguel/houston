import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RING_ACCENT_ICON, RING_ACCENT_INSET_45 } from './shadowChrome'
import type { AgentKind, GitFileStatus, HoustonClient } from '../houston/client'
import { DIFF_EMPTY_CLASS, SPIN_CLASS } from './git/DiffBody'
import { DiffArea } from './git/DiffArea'
import {
  bulkLabelFor,
  discardConfirmLabel,
  discardConfirmMessage,
  discardKindFor,
  flatRows,
  groupBulkDisabledReason,
  groupBulkPaths,
  groupRows,
  pushDisabledReason,
  paneStateFor,
  prChecksLabel,
  prDecisionLabel,
  pushLabel,
  scopeLabels,
  stageActionFor,
  stageAllPaths,
  stagedCount,
  unstageAllPaths,
  GROUP_LABEL,
  type ChangeRow
} from './git/changes'
import type { ReviewDiffsData } from '../git/review'
import { useGitStatusSubscription, type DiffState } from './git/useGitStatusSubscription'
import { usePrSubscription, type PrState } from './git/usePrSubscription'
import { useReviewSubscription, type ReviewNotice } from './git/useReviewSubscription'
import { ReviewProviderModal } from './git/ReviewProviderModal'
import { useGitToolsSubscription } from './git/useGitToolsSubscription'
import { useGitErrorRouter } from './git/useGitErrorRouter'
import { GitToolsBar } from './git/GitToolsBar'
import { PullQuickButton, ToolsNoticeLine } from './git/ChangesControls'
import { ScmNotice } from './git/ScmNotice'
import { MARK_TONE, SCM_ROW_CLS, SECTION_HEAD_CLS } from './git/scmChrome'
import { ConfirmModal } from './ConfirmModal'
import { OpenInMenu } from './OpenInMenu'
import { loadScmDraft, saveScmDraft } from '../scmPanel'
import {
  IconAlertTriangle,
  IconArrowDown,
  IconArrowUp,
  IconExternal,
  IconLoaderCircle,
  IconShieldAlert,
  IconSparkles
} from './icons'
import { HIT_TARGET_28 } from './hitTarget'
import { Tooltip } from './Tooltip'
import { Icon } from './Icon'
import { BTN_GHOST, BTN_PRIMARY, BTN_SECONDARY } from './buttonChrome'
import { MATERIAL_CLS, materialAttrs } from './material'
import { Segmented } from './Segmented'
import { SplitButton } from './SplitButton'

const SCROLL = 'min-h-0 overflow-y-auto [scrollbar-width:thin]'

const STATE_BODY =
  'flex-1 min-h-0 flex flex-col items-center justify-center gap-2 p-6 text-center'
const STATE_TITLE =
  'text-[length:var(--tr-text-base)] [font-weight:var(--tr-text-ui-weight)] text-[var(--text-primary)]'
const STATE_HINT = 'text-[length:var(--tr-text-sm)] text-[var(--text-muted)] max-w-[46ch]'

export interface ChangesReview {
  session: number
  codename: string
  data: ReviewDiffsData
}

export interface ChangesSummary {
  branch: string | null
  ahead: number
  behind: number
  changed: number
  hasPr: boolean
  prTone: 'ok' | 'warn' | 'stop'
}

export interface ChangesPaneProps {
  client: HoustonClient | null
  dir: string | null
  onOpenFileInEditor?: (absPath: string) => void
  onOpenUrlInPane?: (url: string) => void
  onReviewPacket?: (data: ReviewDiffsData) => void
  review?: ChangesReview | null
  onSummary?: (summary: ChangesSummary) => void
  refreshSignal?: number
}

function toEditorPath(dir: string, relPath: string): string {
  return `${dir.replace(/\/+$/, '')}/${relPath}`
}

type GitTools = ReturnType<typeof useGitToolsSubscription>

function prToneForSummary(pr: PrState | null): 'ok' | 'warn' | 'stop' {
  if (pr?.pr?.checks === 'failing') return 'stop'
  if (pr?.pr?.checks === 'running') return 'warn'
  return 'ok'
}

const MARK_GLYPH: Record<GitFileStatus['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: 'C'
}

function ChangesStrip({
  scope,
  setScope,
  defaultBase,
  client,
  repoDir,
  reviewBusy,
  openReview,
  tools,
  toolsBusy,
  toolsError,
  behind,
  upstream,
  onAddWorkspace
}: {
  scope: 'working' | 'branch'
  setScope: (scope: 'working' | 'branch') => void
  defaultBase: string | null
  client: HoustonClient | null
  repoDir: string
  reviewBusy: boolean
  openReview: () => void
  tools: GitTools
  toolsBusy: boolean
  toolsError: string | null
  behind: number
  upstream: string | null
  onAddWorkspace: (path: string) => void
}): React.JSX.Element {
  const labels = scopeLabels(defaultBase)
  return (
    <div className="flex items-center gap-[var(--space-2)] px-[var(--space-2-5)] py-[var(--space-1-5)] border-b border-b-[var(--divider)] flex-none flex-wrap">
      <Segmented
        aria-label="Diff scope"
        value={scope}
        onChange={setScope}
        options={[
          {
            value: 'working',
            label: labels.working,
            compactLabel: 'Working',
            testId: 'changes-scope-working'
          },
          {
            value: 'branch',
            label: labels.branch,
            compactLabel: defaultBase ? `vs ${defaultBase}` : 'vs base',
            testId: 'changes-scope-branch',
            disabled: !defaultBase,
            disabledReason: 'This repository has no base branch to compare against'
          }
        ]}
      />
      <Tooltip label="Review with agent" className="inline-flex">
        <button
          className={`btn ${BTN_SECONDARY}`}
          data-testid="changes-review"
          disabled={!client || reviewBusy}
          onClick={openReview}
        >
          {reviewBusy ? (
            <span className={SPIN_CLASS}>
              <Icon glyph={IconLoaderCircle} role="small" />
            </span>
          ) : (
            <Icon glyph={IconSparkles} role="small" />
          )}
          <span className="[@container_(max-width:420px)]:hidden">Review with agent</span>
        </button>
      </Tooltip>
      <PullQuickButton
        upstream={upstream}
        behind={behind}
        busy={toolsBusy}
        onPull={tools.pull}
      />
      <span className="flex-1" />
      <GitToolsBar
        clientReady={client !== null}
        dir={repoDir}
        tools={tools}
        busy={toolsBusy}
        error={toolsError}
        behind={behind}
        upstream={upstream}
        fallbackBase={defaultBase}
        onAddWorkspace={onAddWorkspace}
      />
    </div>
  )
}

function ChangesFileList({
  files,
  rows,
  branch,
  scope,
  defaultBase,
  ahead,
  offerCreatePr,
  listRef,
  onKeyDown,
  selected,
  menuFor,
  select,
  setMenuFor,
  stageToggle,
  setConfirmDiscard,
  onOpenFileInEditor,
  repoDir,
  stageAll,
  unstageAll,
  bulkForGroup,
  setStatusError
}: {
  files: GitFileStatus[] | null
  rows: ChangeRow[]
  branch: string | null
  scope: 'working' | 'branch'
  defaultBase: string | null
  ahead: number
  offerCreatePr: boolean
  listRef: React.RefObject<HTMLDivElement | null>
  onKeyDown: (event: React.KeyboardEvent) => void
  selected: string | null
  menuFor: string | null
  select: (path: string) => void
  setMenuFor: React.Dispatch<React.SetStateAction<string | null>>
  stageToggle: (row: ChangeRow) => void
  setConfirmDiscard: (row: ChangeRow | null) => void
  onOpenFileInEditor?: (absPath: string) => void
  repoDir: string
  stageAll: string[]
  unstageAll: string[]
  bulkForGroup: (group: ChangeRow['group'], paths: string[]) => void
  setStatusError: (message: string) => void
}): React.JSX.Element {
  const groups = files ? groupRows(files) : []
  if (files === null) {
    return (
      <div className={DIFF_EMPTY_CLASS} data-testid="changes-loading">
        <span className={SPIN_CLASS}>
          <Icon glyph={IconLoaderCircle} role="subhead" />
        </span>
        Loading status…
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <div className={STATE_BODY} data-testid="changes-clean">
        <div className={STATE_TITLE}>Nothing to commit</div>
        <p className={STATE_HINT}>
          {scope === 'branch'
            ? `${branch ?? 'This branch'} matches ${defaultBase ?? 'its base'}.`
            : [
                'The working tree is clean.',
                ahead > 0
                  ? `${ahead} commit${ahead === 1 ? '' : 's'} ahead of ${defaultBase ?? 'the base'}.`
                  : null,
                offerCreatePr ? 'This branch has no pull request yet.' : null
              ]
                .filter(Boolean)
                .join(' ')}
        </p>
      </div>
    )
  }
  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Changed files"
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-testid="changes-list"
      className={`${SCROLL} py-1 focus-visible:outline-none focus-visible:shadow-[${RING_ACCENT_INSET_45}]`}
    >
      {groups.map((group) => {
        const bulkPaths = groupBulkPaths(group.rows)
        return (
          <div key={group.group}>
            <div className={`${SECTION_HEAD_CLS} ${group.group === 'conflicted' ? 'text-[var(--warn)]' : ''}`}>
              {GROUP_LABEL[group.group]}
              <span className="ml-auto font-mono font-medium text-[length:var(--tr-text-xs)] text-[var(--text-faint)] tabular-nums">
                {group.rows.length}
              </span>
              <Tooltip
                label={bulkPaths.length === 0 ? groupBulkDisabledReason(group.group) : undefined}
                className="inline-flex"
              >
                <button
                  className={`btn ${BTN_GHOST} h-[var(--h-ctl-mini)] px-[var(--space-1-5)] text-[length:var(--tr-text-xs)] normal-case tracking-normal`}
                  data-testid={`changes-bulk-${group.group}`}
                  disabled={bulkPaths.length === 0}
                  onClick={(event) => {
                    event.stopPropagation()
                    bulkForGroup(group.group, bulkPaths)
                  }}
                >
                  {bulkLabelFor(group.group)}
                </button>
              </Tooltip>
              {group.group === 'unstaged' && (
                <Tooltip
                  label={stageAll.length === 0 ? (rows.length === 0 ? 'Nothing to stage' : 'Every unstaged file here is a blocked path — its contents were never shown') : undefined}
                  className="inline-flex"
                >
                  <button
                    className={`btn ${BTN_GHOST} h-[var(--h-ctl-mini)] px-[var(--space-1-5)] text-[length:var(--tr-text-xs)] normal-case tracking-normal`}
                    data-testid="changes-stage-all"
                    disabled={stageAll.length === 0}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (stageAll.length > 0) bulkForGroup('unstaged', stageAll)
                    }}
                  >
                    Stage all
                  </button>
                </Tooltip>
              )}
              {group.group === 'staged' && (
                <Tooltip label={unstageAll.length === 0 ? 'Nothing is staged' : undefined} className="inline-flex">
                  <button
                    className={`btn ${BTN_GHOST} h-[var(--h-ctl-mini)] px-[var(--space-1-5)] text-[length:var(--tr-text-xs)] normal-case tracking-normal`}
                    data-testid="changes-unstage-all"
                    disabled={unstageAll.length === 0}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (unstageAll.length > 0) bulkForGroup('staged', unstageAll)
                    }}
                  >
                    Unstage all
                  </button>
                </Tooltip>
              )}
            </div>
            {group.rows.map((row) => (
              <FileRow
                key={row.key}
                row={row}
                selected={selected === row.path}
                menuOpen={menuFor === row.key}
                onSelect={() => select(row.path)}
                onToggleMenu={() => setMenuFor((value) => (value === row.key ? null : row.key))}
                onStageToggle={() => stageToggle(row)}
                onDiscard={() => {
                  setMenuFor(null)
                  setConfirmDiscard(row)
                }}
                onOpenInEditor={
                  onOpenFileInEditor
                    ? () => {
                        setMenuFor(null)
                        onOpenFileInEditor(toEditorPath(repoDir, row.path))
                      }
                    : undefined
                }
                absPath={toEditorPath(repoDir, row.path)}
                onCloseMenu={() => setMenuFor(null)}
                onOpenInEditorError={setStatusError}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
}

function CommitBox({
  commitMsg,
  setCommitMsg,
  staged,
  client,
  pushBlocked,
  pushing,
  ahead,
  doPush,
  canCommit,
  doCommit,
  offerCreatePr,
  prBusy,
  onCreatePr,
  hasChanges
}: {
  commitMsg: string
  setCommitMsg: (message: string) => void
  staged: number
  client: HoustonClient | null
  pushBlocked: string | null
  pushing: boolean
  ahead: number
  doPush: () => void
  canCommit: boolean
  doCommit: (thenPush: boolean) => void
  offerCreatePr: boolean
  prBusy: boolean
  onCreatePr: () => void
  hasChanges: boolean
}): React.JSX.Element {
  return (
    <div className="flex-none flex flex-col gap-[var(--space-2)] p-[var(--space-2-5)] border-t border-t-[var(--border)] bg-[var(--material-shell-bg)]">
      {hasChanges && <div className="flex items-center gap-1.5">
        <textarea
          data-testid="changes-commit-message"
          aria-label="Commit message"
          value={commitMsg}
          onChange={(event) => setCommitMsg(event.target.value)}
          placeholder="Commit message"
          rows={2}
          className="flex-1 min-w-0 min-h-[var(--h-ctl)] resize-none rounded-[var(--tr-radius-input)] border border-[var(--border)] bg-[var(--content-bg)] px-[var(--space-2)] py-[var(--space-1-5)] text-[length:var(--tr-text-small-size)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus-visible:border-[var(--border-focus)] focus-visible:outline-none"
        />
      </div>}
      <div data-testid="changes-actions" className="flex items-center gap-[var(--space-2)]">
        <span data-testid="changes-staged-count" className="font-mono text-[length:var(--tr-text-small-size)] text-[var(--text-faint)] whitespace-nowrap">
          {staged} file{staged === 1 ? '' : 's'} staged
        </span>
        <div className="flex flex-wrap items-center justify-end gap-[var(--space-2)] ml-auto">
          <Tooltip label={pushBlocked ?? undefined} className="inline-flex">
            <button
              className={`btn ${BTN_SECONDARY}`}
              data-testid="changes-push"
              disabled={pushBlocked !== null}
              onClick={doPush}
            >
              {pushing && (
                <span className={SPIN_CLASS}>
                  <Icon glyph={IconLoaderCircle} role="small" />
                </span>
              )}
              {pushLabel(ahead)}
            </button>
          </Tooltip>
          {offerCreatePr && (
            <>
              <button
                className={`btn ${BTN_PRIMARY}`}
                data-testid="changes-create-pr"
                disabled={prBusy || !client}
                onClick={onCreatePr}
              >
                {prBusy ? 'Creating PR…' : 'Create PR'}
              </button>
            </>
          )}
          {!offerCreatePr && (
            <SplitButton
              label="Commit"
              testId="changes-commit"
              disabled={!canCommit}
              onClick={() => doCommit(false)}
              items={[
                { label: 'Commit & push', testId: 'changes-commit-push', disabled: !canCommit, onClick: () => doCommit(true) },
                { label: 'Amend last commit', disabled: !canCommit, onClick: () => doCommit(false) }
              ]}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function PrLine({
  pr,
  onOpenUrlInPane
}: {
  pr: PrState | null
  onOpenUrlInPane?: (url: string) => void
}): React.JSX.Element | null {
  if (!pr) return null
  if (pr.gh !== 'ready') {
    return (
      <div data-testid="changes-pr-blocked" className="flex-none px-2.5 py-1.5 border-t border-t-[var(--divider)] text-[length:var(--tr-text-xs)] text-[var(--text-muted)]">
        {pr.hint ?? 'gh is unavailable.'}
      </div>
    )
  }
  if (!pr.pr) return null
  const checks = prChecksLabel(pr.pr.checks)
  const decision = prDecisionLabel(pr.pr.review_decision)
  return (
    <div data-testid="changes-pr-line" className="flex-none flex items-center gap-2 px-2.5 py-1.5 border-t border-t-[var(--divider)] text-[length:var(--tr-text-xs)] text-[var(--text-muted)]">
      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
        PR #{pr.pr.number} · {checks}
        {decision ? ` · ${decision}` : ''}
      </span>
      <button
        className={`btn ${BTN_SECONDARY} ml-auto`}
        data-testid="changes-pr-open"
        disabled={!onOpenUrlInPane}
        onClick={() => onOpenUrlInPane?.(pr.pr!.url)}
      >
        <Icon glyph={IconExternal} role="small" />
        Open
      </button>
    </div>
  )
}

function ReviewNoticeLine({ reviewNotice }: { reviewNotice: ReviewNotice | null }): React.JSX.Element | null {
  if (!reviewNotice || (!reviewNotice.truncated && !reviewNotice.redacted && reviewNotice.blockedPaths.length === 0)) return null
  return (
    <ScmNotice tone="warn" testId="changes-review-notice">
      {[
        reviewNotice.truncated ? 'Review packet was capped — the reviewer did not see all of it.' : '',
        reviewNotice.redacted ? 'Secret-shaped values were redacted before the agent read them.' : '',
        reviewNotice.blockedPaths.length > 0 ? `Withheld entirely: ${reviewNotice.blockedPaths.join(', ')}` : ''
      ].filter(Boolean).join(' ')}
    </ScmNotice>
  )
}

function ScmErrorLine({ text, testId }: { text: string; testId: string }): React.JSX.Element {
  return <ScmNotice tone="danger" testId={testId}>{text}</ScmNotice>
}

export function ChangesPane({
  client,
  dir,
  onOpenFileInEditor,
  onOpenUrlInPane,
  onReviewPacket,
  review = null,
  onSummary,
  refreshSignal = 0
}: ChangesPaneProps): React.JSX.Element {
  const repoDir = dir

  const [files, setFiles] = useState<GitFileStatus[] | null>(null)
  const [branch, setBranch] = useState<string | null>(null)
  const [ahead, setAhead] = useState(0)
  const [behind, setBehind] = useState(0)
  const [upstream, setUpstream] = useState<string | null>(null)
  const [defaultBase, setDefaultBase] = useState<string | null>(null)
  const [scope, setScope] = useState<'working' | 'branch'>('working')
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<DiffState | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [commitMsg, setCommitMsg] = useState(() => (repoDir ? loadScmDraft(repoDir) : ''))
  const [committing, setCommitting] = useState(false)
  const [pushAfterCommit, setPushAfterCommit] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [reviewPickerOpen, setReviewPickerOpen] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [reviewNotice, setReviewNotice] = useState<ReviewNotice | null>(null)
  const [pr, setPr] = useState<PrState | null>(null)
  const [prBusy, setPrBusy] = useState(false)
  const [prMessage, setPrMessage] = useState<string | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState<ChangeRow | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [toolsBusy, setToolsBusy] = useState(false)
  const [toolsError, setToolsError] = useState<string | null>(null)
  const [toolsNotice, setToolsNotice] = useState<string | null>(null)

  const pendingStatus = useRef<string | null>(null)
  const pendingCommit = useRef<string | null>(null)
  const pendingPush = useRef<string | null>(null)
  const pendingReview = useRef<{ dir: string; agent: AgentKind } | null>(null)
  const pendingTools = useRef<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const pushAfterCommitRef = useRef(false)
  const onReviewPacketRef = useRef(onReviewPacket)
  const onSummaryRef = useRef(onSummary)
  const refreshRef = useRef<() => void>(() => {})
  useEffect(() => {
    onReviewPacketRef.current = onReviewPacket
  }, [onReviewPacket])
  useEffect(() => {
    onSummaryRef.current = onSummary
  }, [onSummary])
  useEffect(() => {
    pushAfterCommitRef.current = pushAfterCommit
  }, [pushAfterCommit])

  const rows = useMemo(() => (files ? flatRows(files) : []), [files])
  const selectedRow = useMemo(
    () => rows.find((r) => r.path === selected) ?? null,
    [rows, selected]
  )
  const staged = useMemo(() => (files ? stagedCount(files) : 0), [files])
  const stageAll = useMemo(() => (files ? stageAllPaths(files) : []), [files])
  const unstageAll = useMemo(() => (files ? unstageAllPaths(files) : []), [files])
  const base = scope === 'branch' ? defaultBase : null

  const refresh = useCallback((): void => {
    if (!client || !repoDir) return
    pendingStatus.current = repoDir
    client.gitStatus(repoDir, base)
    client.prStatus(repoDir)
  }, [client, repoDir, base])
  refreshRef.current = refresh

  useEffect(() => {
    if (repoDir) saveScmDraft(repoDir, commitMsg)
  }, [repoDir, commitMsg])

  useEffect(() => {
    if (refreshSignal <= 0) return
    refreshRef.current()
  }, [refreshSignal])

  useEffect(() => {
    onSummaryRef.current?.({
      branch,
      ahead,
      behind,
      changed: rows.length,
      hasPr: pr?.pr != null,
      prTone: prToneForSummary(pr)
    })
  }, [branch, ahead, behind, rows.length, pr])

  useGitStatusSubscription({
    client,
    repoDir,
    base,
    pendingStatus,
    pendingCommit,
    pendingPush,
    pushAfterCommitRef,
    setFiles,
    setDiff,
    setSelected,
    setBranch,
    setAhead,
    setBehind,
    setUpstream,
    setDefaultBase,
    setStatusError,
    setCommitError,
    setCommitting,
    setPushing,
    setPushAfterCommit,
    setCommitMsg
  })

  usePrSubscription({ client, repoDir, base, setPr, setPrBusy, setPrMessage })

  useReviewSubscription({
    client,
    repoDir,
    base,
    pendingReview,
    onReviewPacketRef,
    setReviewBusy,
    setReviewError,
    setReviewNotice
  })

  const tools = useGitToolsSubscription({
    client,
    repoDir,
    pendingTools,
    toolsError,
    setToolsNotice,
    setToolsBusy,
    setToolsError
  })

  useEffect(() => {
    setToolsNotice(null)
    setToolsError(null)
    setToolsBusy(false)
    pendingTools.current = null
  }, [repoDir])

  useGitErrorRouter({
    client,
    repoDir,
    base,
    pendingStatus,
    pendingCommit,
    pendingPush,
    pendingReview,
    pendingTools,
    pushAfterCommitRef,
    setReviewBusy,
    setReviewError,
    setCommitting,
    setCommitError,
    setPushAfterCommit,
    setPushing,
    setStatusError,
    setToolsBusy,
    setToolsError
  })

  useEffect(() => {
    if (!client || !repoDir || !selectedRow) return
    if (selectedRow.blocked) {
      setDiff(null)
      return
    }
    client.gitDiff(repoDir, selectedRow.path, base)
  }, [client, repoDir, selectedRow, base])

  const select = useCallback((path: string): void => {
    setSelected(path)
    setDiff(null)
    setMenuFor(null)
  }, [])

  const stageToggle = useCallback(
    (row: ChangeRow): void => {
      if (!client || !repoDir) return
      const action = stageActionFor(row)
      if (action === 'stage') client.gitStage(repoDir, [row.path])
      else if (action === 'unstage') client.gitUnstage(repoDir, [row.path])
    },
    [client, repoDir]
  )

  const runDiscard = useCallback((): void => {
    const row = confirmDiscard
    setConfirmDiscard(null)
    if (!client || !repoDir || !row) return
    const kind = discardKindFor(row)
    if (!kind) return
    client.gitDiscard(repoDir, row.path, kind)
    if (selected === row.path) {
      setSelected(null)
      setDiff(null)
    }
  }, [client, repoDir, confirmDiscard, selected])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      if (rows.length === 0) return
      const idx = rows.findIndex((r) => r.path === selected)
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const next = e.key === 'ArrowDown' ? Math.min(rows.length - 1, idx + 1) : Math.max(0, idx - 1)
        setSelected(rows[next === -1 ? 0 : next].path)
        return
      }
      if (e.key === 'Enter' && idx >= 0) {
        e.preventDefault()
        select(rows[idx].path)
        return
      }
      if ((e.key === 's' || e.key === 'S') && idx >= 0 && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        stageToggle(rows[idx])
      }
    },
    [rows, selected, select, stageToggle]
  )

  const openReviewPicker = useCallback((): void => {
    if (!client || !repoDir || reviewBusy) return
    setReviewPickerOpen(true)
  }, [client, repoDir, reviewBusy])

  const startReview = useCallback(
    (agent: AgentKind): void => {
      setReviewPickerOpen(false)
      if (!client || !repoDir || reviewBusy) return
      setReviewBusy(true)
      setReviewError(null)
      setReviewNotice(null)
      pendingReview.current = { dir: repoDir, agent }
      client.gitReviewDiffs(repoDir)
    },
    [client, repoDir, reviewBusy]
  )

  const doCommit = useCallback(
    (thenPush: boolean): void => {
      if (!client || !repoDir || committing || staged === 0) return
      const message = commitMsg.trim()
      if (message.length === 0) return
      setCommitting(true)
      setCommitError(null)
      setPushAfterCommit(thenPush)
      pushAfterCommitRef.current = thenPush
      pendingCommit.current = repoDir
      client.gitCommit(repoDir, message)
    },
    [client, repoDir, committing, staged, commitMsg]
  )

  const doPush = useCallback((): void => {
    if (!client || !repoDir || pushing) return
    if (pushDisabledReason(upstream, ahead, false) !== null) return
    setPushing(true)
    setCommitError(null)
    pendingPush.current = repoDir
    client.gitPush(repoDir)
  }, [client, repoDir, pushing, upstream, ahead])

  const addWorkspace = useCallback(
    (path: string): void => {
      setToolsNotice(`Added ${path} as a workspace.`)
      client?.addWorkspace(path)
    },
    [client]
  )

  const bulkForGroup = useCallback(
    (group: ChangeRow['group'], paths: string[]): void => {
      if (!client || !repoDir || paths.length === 0) return
      if (group === 'staged') client.gitUnstage(repoDir, paths)
      else client.gitStage(repoDir, paths)
    },
    [client, repoDir]
  )

  const notARepo = statusError !== null && statusError.includes('not a git repository')
  const paneState = paneStateFor(repoDir, statusError, rows.length, files !== null)

  const reviewing = review !== null

  const canCommit = staged > 0 && commitMsg.trim().length > 0 && !committing
  const pushBlocked = !client || !repoDir ? 'Not connected' : pushDisabledReason(upstream, ahead, pushing)
  const offerCreatePr = pr?.gh === 'ready' && pr.hasUpstream && pr.pr === null

  const shell = (body: React.ReactNode): React.JSX.Element => (
    <section
      className={`changes-pane flex-1 min-w-0 min-h-0 relative flex flex-col overflow-hidden ${MATERIAL_CLS.shell}`}
      data-testid="changes-pane"
      data-state={paneState}
      data-reviewing={reviewing ? 'true' : undefined}
      {...materialAttrs('shell')}
    >
      {body}
      {reviewPickerOpen && (
        <ReviewProviderModal
          onCancel={() => setReviewPickerOpen(false)}
          onStart={startReview}
        />
      )}
      {confirmDiscard && (
        <ConfirmModal
          title="DISCARD"
          message={discardConfirmMessage(confirmDiscard)}
          confirmLabel={discardConfirmLabel(confirmDiscard)}
          onConfirm={runDiscard}
          onCancel={() => setConfirmDiscard(null)}
        />
      )}
    </section>
  )

  if (!repoDir)
    return shell(
      <div className={STATE_BODY} data-testid="changes-idle">
        <div className={STATE_TITLE}>No workspace selected</div>
        <p className={STATE_HINT}>Select this pane&rsquo;s workspace to see its changes.</p>
      </div>
    )

  if (notARepo)
    return shell(
      <div className={STATE_BODY} data-testid="changes-not-a-repo">
        <div className={STATE_TITLE}>Not a Git repository</div>
        <p className={STATE_HINT}>
          {repoDir} has no git repository yet. Once <code className="font-mono">git init</code>{' '}
          runs there — from a Shell pane — Changes will track it.
        </p>
      </div>
    )

  if (statusError !== null)
    return shell(
      <div className={STATE_BODY} data-testid="changes-error">
        <span className="text-[var(--danger)]">
          <Icon glyph={IconAlertTriangle} role="heading" />
        </span>
        <div className={STATE_TITLE}>Git status unavailable</div>
        <p className={STATE_HINT}>{statusError}</p>
        <button className={`btn ${BTN_SECONDARY}`} onClick={refresh}>
          Retry
        </button>
      </div>
    )

  const strip = (
    <ChangesStrip
      scope={scope}
      setScope={setScope}
      defaultBase={defaultBase}
      client={client}
      repoDir={repoDir}
      reviewBusy={reviewBusy}
      openReview={openReviewPicker}
      tools={tools}
      toolsBusy={toolsBusy}
      toolsError={toolsError}
      behind={behind}
      upstream={upstream}
      onAddWorkspace={addWorkspace}
    />
  )

  const notice = <ReviewNoticeLine reviewNotice={reviewNotice} />
  const errorLine = (text: string, testid: string): React.JSX.Element => (
    <ScmErrorLine text={text} testId={testid} />
  )

  const fileList = (
    <ChangesFileList
      files={files}
      rows={rows}
      branch={branch}
      scope={scope}
      defaultBase={defaultBase}
      ahead={ahead}
      offerCreatePr={offerCreatePr}
      listRef={listRef}
      onKeyDown={onKeyDown}
      selected={selected}
      menuFor={menuFor}
      select={select}
      setMenuFor={setMenuFor}
      stageToggle={stageToggle}
      setConfirmDiscard={setConfirmDiscard}
      onOpenFileInEditor={onOpenFileInEditor}
      repoDir={repoDir}
      stageAll={stageAll}
      unstageAll={unstageAll}
      bulkForGroup={bulkForGroup}
      setStatusError={setStatusError}
    />
  )

  const diffPane = (
    <DiffArea
      row={selectedRow}
      diff={diff}
      emptySummary={{
        headline: `${rows.length} file${rows.length === 1 ? '' : 's'} changed`,
        description: `+${rows.reduce((sum, row) => sum + (row.added ?? 0), 0)} added, −${rows.reduce((sum, row) => sum + (row.deleted ?? 0), 0)} removed${ahead > 0 ? ` · ${ahead} commit${ahead === 1 ? '' : 's'} ahead of ${defaultBase ?? 'the base'}` : ''}. Pick a file to read its diff.`
      }}
      onReview={openReviewPicker}
      reviewDisabledReason={!client || reviewBusy ? 'Not connected' : null}
    />
  )

  const commitBox = (
    <CommitBox
      commitMsg={commitMsg}
      setCommitMsg={setCommitMsg}
      staged={staged}
      client={client}
      pushBlocked={pushBlocked}
      pushing={pushing}
      ahead={ahead}
      doPush={doPush}
      canCommit={canCommit}
      doCommit={doCommit}
      offerCreatePr={offerCreatePr}
      prBusy={prBusy}
      onCreatePr={() => {
        if (!client || !repoDir) return
        setPrBusy(true)
        setPrMessage(null)
        client.prCreate(repoDir)
      }}
      hasChanges={rows.length > 0}
    />
  )

  const prLine = <PrLine pr={pr} onOpenUrlInPane={onOpenUrlInPane} />

  const body =
    paneState === 'loading' || paneState === 'empty' ? (
      <>
        {strip}
        <ToolsNoticeLine notice={toolsNotice} error={toolsError} />
        {commitError ? errorLine(commitError, 'changes-commit-error') : null}
        {fileList}
        {commitBox}
        {prLine}
      </>
    ) : (
      <>
        {strip}
        {notice}
        <ToolsNoticeLine notice={toolsNotice} error={toolsError} />
        {reviewError ? errorLine(reviewError, 'changes-review-error') : null}
        {commitError ? errorLine(commitError, 'changes-commit-error') : null}
        {prMessage ? errorLine(prMessage, 'changes-pr-message') : null}
      <div
          data-testid="changes-body"
          className={`flex-1 min-h-0 flex flex-col [@container_(min-width:720px)]:flex-row [@container_(min-width:720px)]:overflow-hidden`}
        >
          <div
            data-testid="changes-left"
          className={`flex flex-col min-h-0 flex-none max-h-[45%] [@container_(min-width:720px)]:max-h-none [@container_(min-width:720px)]:h-full [@container_(min-width:720px)]:w-[300px] [@container_(min-width:720px)]:border-r [@container_(min-width:720px)]:border-r-[var(--divider)] border-b border-b-[var(--divider)] [@container_(min-width:720px)]:border-b-0`}
          >
            <div className="flex-1 min-h-0 flex flex-col">{fileList}</div>
            <div className={`hidden [@container_(min-width:720px)]:flex [@container_(min-width:720px)]:flex-col flex-none`}>
              {commitBox}
              {prLine}
            </div>
          </div>
          {diffPane}
        </div>
        <div className={`flex-none flex flex-col [@container_(min-width:720px)]:hidden`}>
          {commitBox}
          {prLine}
        </div>
      </>
    )

  return shell(body)
}

function StageToggleButton({
  stage,
  onStageToggle
}: {
  stage: 'stage' | 'unstage' | null
  onStageToggle: () => void
}): React.JSX.Element | null {
  if (stage === null) return null
  const label = stage === 'unstage' ? 'Unstage' : 'Stage'
  return (
    <Tooltip label={label} className="inline-flex">
      <button
        type="button"
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation()
          onStageToggle()
        }}
        className={`flex-none w-[var(--h-ctl-mini)] h-[var(--h-ctl-mini)] rounded-[var(--tr-radius-sm)] grid place-items-center text-[var(--text-faint)] opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:shadow-[${RING_ACCENT_ICON}] ${HIT_TARGET_28}`}
      >
        <Icon glyph={stage === 'unstage' ? IconArrowDown : IconArrowUp} role="small" />
      </button>
    </Tooltip>
  )
}

function FileRow({
  row,
  selected,
  menuOpen,
  onSelect,
  onToggleMenu,
  onStageToggle,
  onDiscard,
  onOpenInEditor,
  absPath,
  onOpenInEditorError,
  onCloseMenu
}: {
  row: ChangeRow
  selected: boolean
  menuOpen: boolean
  onSelect: () => void
  onToggleMenu: () => void
  onStageToggle: () => void
  onDiscard: () => void
  onOpenInEditor?: () => void
  absPath?: string
  onOpenInEditorError?: (message: string) => void
  onCloseMenu?: () => void
}): React.JSX.Element {
  const stage = stageActionFor(row)
  const discard = discardKindFor(row)
  const counts =
    row.added !== null || row.deleted !== null ? (
      <span className="flex-none min-w-[52px] text-right font-mono text-[length:var(--tr-text-xs)] font-medium tabular-nums">
        {row.added !== null && <span className="text-[var(--success)]">+{row.added}</span>}
        {row.added !== null && row.deleted !== null ? ' ' : ''}
        {row.deleted !== null && <span className="text-[var(--danger)]">−{row.deleted}</span>}
      </span>
    ) : (
      <span className="flex-none min-w-[52px] text-right font-mono text-[length:var(--tr-text-xs)] text-[var(--text-faint)]">
        {row.blocked ? 'blocked' : row.state === 'untracked' ? 'new' : row.state === 'conflicted' ? 'both modified' : ''}
      </span>
    )
  return (
    <div
      className={`${SCM_ROW_CLS} ${
        selected
          ? 'bg-[var(--selected-fill)] text-[var(--text-primary)]'
          : ''
      }`}
      onContextMenu={(e) => {
        e.preventDefault()
        onToggleMenu()
      }}
    >
      <button
        type="button"
        role="option"
        aria-selected={selected}
        data-testid="changes-file"
        data-path={row.path}
        data-tag={row.tag}
        aria-label={`${row.path} — ${row.tag}`}
        onClick={onSelect}
        className="flex-1 min-w-0 flex items-center gap-2 bg-transparent border-0 p-0 text-left text-inherit"
      >
        <span className={`flex-none w-[14px] text-center font-mono text-[length:var(--tr-text-xs)] [font-weight:var(--tr-text-label-weight)] ${MARK_TONE[row.state] ?? MARK_TONE[row.tag]}`} aria-hidden>
          {row.blocked ? <Icon glyph={IconShieldAlert} role="label" /> : MARK_GLYPH[row.state]}
        </span>
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[length:var(--tr-text-xs)]">
          <span className="text-[var(--text-faint)] [@container_(max-width:420px)]:hidden">{row.dir}</span>
          {row.name}
        </span>
      </button>
      <StageToggleButton stage={stage} onStageToggle={onStageToggle} />
      {counts}
      <button
        type="button"
        data-testid="changes-row-menu"
        aria-label={`Actions for ${row.path}`}
        aria-expanded={menuOpen}
        onClick={onToggleMenu}
        className={`flex-none w-[var(--h-ctl-mini)] h-[var(--h-ctl-mini)] rounded-[var(--tr-radius-sm)] grid place-items-center text-[var(--text-faint)] opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:shadow-[${RING_ACCENT_ICON}] ${HIT_TARGET_28}`}
      >
        <span aria-hidden>···</span>
      </button>
      {menuOpen && (
        <div
          role="menu"
          data-testid="changes-row-menu-items"
          className={`absolute right-1 top-[var(--h-row)] z-[var(--z-sticky)] min-w-[170px] flex flex-col rounded-[var(--tr-radius-sm)] py-[var(--space-1)] ${MATERIAL_CLS.raised}`}
          {...materialAttrs('raised')}
        >
          <MenuItem
            label={stage === 'unstage' ? 'Unstage' : 'Stage'}
            disabled={stage === null}
            disabledReason="Blocked path — its contents were never shown here"
            onClick={onStageToggle}
          />
          <MenuItem
            label={row.group === 'untracked' ? 'Delete file' : 'Discard changes'}
            danger
            disabled={discard === null}
            disabledReason="Blocked path — its contents were never shown here"
            onClick={onDiscard}
          />
          <MenuItem
            label="Open in editor"
            disabled={!onOpenInEditor || row.blocked}
            disabledReason="Blocked path"
            onClick={() => onOpenInEditor?.()}
          />
          {absPath && !row.blocked && (
            <OpenInMenu
              path={absPath}
              itemClass={MENU_ITEM_CLS}
              onDone={() => onCloseMenu?.()}
              onError={(m) => onOpenInEditorError?.(m)}
            />
          )}
        </div>
      )}
    </div>
  )
}

const MENU_ITEM_CLS =
  'text-left px-2.5 py-1 text-[length:var(--tr-text-sm)] bg-transparent border-0 flex items-center gap-1.5 disabled:opacity-45 disabled:cursor-not-allowed text-[var(--text-secondary)] enabled:hover:bg-[var(--card-hover)]'

function MenuItem({
  label,
  onClick,
  disabled = false,
  disabledReason,
  danger = false
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  disabledReason?: string
  danger?: boolean
}): React.JSX.Element {
  return (
    <Tooltip label={disabled ? disabledReason : undefined} className="inline-flex w-full">
      <button
        type="button"
        role="menuitem"
        disabled={disabled}
        onClick={onClick}
        className={`text-left px-2.5 py-1 text-[length:var(--tr-text-sm)] bg-transparent border-0 disabled:opacity-45 disabled:cursor-not-allowed ${
          danger
            ? 'text-[var(--danger)] enabled:hover:bg-[color-mix(in_srgb,var(--danger)_14%,transparent)]'
            : 'text-[var(--text-secondary)] enabled:hover:bg-[var(--card-hover)]'
        }`}
      >
        {label}
      </button>
    </Tooltip>
  )
}
