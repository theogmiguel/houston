import { DiffLoadingMark } from './ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { OVERLAY_GLASS_OVERLAY_ATTRS, popOriginStyle } from './ui/overlayChrome'
import type { AgentKind, GitFileStatus, HoustonClient } from '../houston/client'

import { DiffArea } from './git/DiffArea'
import { DiffBody } from './git/DiffBody'
import {
  discardConfirmLabel,
  discardConfirmMessage,
  discardKindFor,
  flatRows,
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
import { ConfirmModal } from './ConfirmModal'
import { loadScmDraft, saveScmDraft } from '../scmPanel'
import {
  IconAlertTriangle,
  IconExternal,
  IconLoaderCircle,
  IconEllipsis,
  IconSparkles,
  IconChevronDown,
  IconCollapse,
  IconExpand,
  IconRefresh,
  IconSplitDown,
  IconSplitRight,
  IconFolderOpen
} from './icons'
import { Tooltip } from './ui/Tooltip'
import { Icon } from './ui/Icon'
import { Button } from './ui/Button'
import { RepositoryPanelState, GitPrNotice, GitPrSummaryLine } from './ui'
import { Text } from './ui/Text'
import { PrTab } from './ui/PrTab'
import {
  GitChangesBody,
  GitChangesFileColumn,
  GitChangesFileListFrame,
  GitChangesNarrowActions,
  GitChangesSurface,
  GitChangesToolbarSurface,
  GitChangesWideActions,
  GitCommitActionRow,
  GitCommitButtonGroup,
  GitCommitMessageField,
  GitCommitMessageRow,
  GitCommitPanel,
  GitCommitStagedCount,
  GitCompactToolsAnchor,
  GitCompactToolsSurface,
  GitPrOpenAction,
  GitPrSummaryLabel
} from './ui'
import { Segmented } from './ui/SegmentedControl'
import { SplitButton } from './ui/SplitButton'
import { ChangesFileList } from './git/ChangesFileList'
import { BranchCommits } from './git/BranchCommits'
import { changeListKeyDown } from './git/changeListKeyboard'
import { canCommit as canCommitForState, offerCreatePr as offerPrCreateForState, openSelectedFile, pushBlockedReason, reviewDisabledReason } from './git/changesPaneDerived'

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
  prNumber?: number
  prTone: 'ok' | 'warn' | 'stop'
}

export interface ChangesPaneProps {
  compact?: boolean
  checkoutLabel?: string
  client: HoustonClient | null
  dir: string | null
  onOpenFileInEditor?: (absPath: string) => void
  onOpenUrlInPane?: (url: string) => void
  onReviewPacket?: (data: ReviewDiffsData) => void
  review?: ChangesReview | null
  onSummary?: (summary: ChangesSummary) => void
  refreshSignal?: number
}

type GitTools = ReturnType<typeof useGitToolsSubscription>

function prToneForSummary(pr: PrState | null): 'ok' | 'warn' | 'stop' {
  if (pr?.pr?.checks === 'failing') return 'stop'
  if (pr?.pr?.checks === 'running') return 'warn'
  return 'ok'
}

function useInlineDiffSubscription(client: HoustonClient | null, repoDir: string | null, base: string | null, setInlineDiffs: React.Dispatch<React.SetStateAction<Map<string, DiffState>>>): void {
  useEffect(() => {
    if (!client || !repoDir) return
    const offDiff = client.subscribe('git_diff', (message) => {
      if (message.dir !== repoDir || (message.base ?? null) !== base || !message.path) return
      setInlineDiffs((current) => new Map(current).set(message.path!, {
        path: message.path!, patch: message.patch, truncated: message.truncated
      }))
    })
    return offDiff
  }, [client, repoDir, base, setInlineDiffs])
}

function useSelectedGitDiff(client: HoustonClient | null, repoDir: string | null, selectedRow: ChangeRow | null, base: string | null, setDiff: React.Dispatch<React.SetStateAction<DiffState | null>>): void {
  useEffect(() => {
    if (!client || !repoDir || !selectedRow) return
    if (selectedRow.blocked) {
      setDiff(null)
      return
    }
    client.gitDiff(repoDir, selectedRow.path, base)
  }, [client, repoDir, selectedRow, base, setDiff])
}

function visibleRowsFor(rows: ChangeRow[], stagedOnly: boolean): ChangeRow[] {
  return stagedOnly ? rows.filter((row) => row.group === 'staged') : rows
}

function visibleFilesFor(files: GitFileStatus[] | null, stagedOnly: boolean): GitFileStatus[] | null {
  return stagedOnly ? files?.filter((file) => file.staged) ?? null : files
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
    <GitChangesToolbarSurface>
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
        <Button
          variant="legacy-secondary"
          data-testid="changes-review"
          disabled={!client || reviewBusy}
          onClick={openReview}
        >
          {reviewBusy ? (
            <DiffLoadingMark>
              <Icon glyph={IconLoaderCircle} role="small" />
            </DiffLoadingMark>
          ) : (
            <Icon glyph={IconSparkles} role="small" />
          )}
          <span className="[@container_(max-width:420px)]:hidden">Review with agent</span>
        </Button>
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
    </GitChangesToolbarSurface>
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
  hasChanges,
  compact = false,
  target
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
  compact?: boolean
  target?: string
}): React.JSX.Element {
  return (
    <GitCommitPanel>
      {hasChanges && <GitCommitMessageRow>
        <GitCommitMessageField
          data-testid="changes-commit-message"
          aria-label="Commit message"
          value={commitMsg}
          onChange={(event) => setCommitMsg(event.target.value)}
          placeholder="Commit message"
          rows={compact ? 3 : 2}
        />
      </GitCommitMessageRow>}
      <GitCommitActionRow>
        <GitCommitStagedCount compact={compact}>
          {staged} file{staged === 1 ? '' : 's'} staged
        </GitCommitStagedCount>
        {compact && target && <span data-testid="changes-commit-target">to {target}</span>}
        <GitCommitButtonGroup>
          <Tooltip label={pushBlocked ?? undefined} className="inline-flex">
            <Button
              variant="legacy-secondary"
              data-testid="changes-push"
              disabled={pushBlocked !== null}
              onClick={doPush}
            >
              {pushing && (
                <DiffLoadingMark>
                  <Icon glyph={IconLoaderCircle} role="small" />
                </DiffLoadingMark>
              )}
              {pushLabel(ahead)}
            </Button>
          </Tooltip>
          {offerCreatePr && (
            <>
              <Button
                variant="legacy-primary"
                data-testid="changes-create-pr"
                disabled={prBusy || !client}
                onClick={onCreatePr}
              >
                {prBusy ? 'Creating PR…' : 'Create PR'}
              </Button>
            </>
          )}
          {!offerCreatePr && (
            <SplitButton
              label={compact ? `Commit ${staged} file${staged === 1 ? '' : 's'}` : 'Commit'}
              testId="changes-commit"
              disabled={!canCommit}
              onClick={() => doCommit(false)}
              items={[
                { label: 'Commit & push', testId: 'changes-commit-push', disabled: !canCommit, onClick: () => doCommit(true) },
                { label: 'Amend last commit', disabled: !canCommit, onClick: () => doCommit(false) }
              ]}
            />
          )}
        </GitCommitButtonGroup>
      </GitCommitActionRow>
    </GitCommitPanel>
  )
}

function PrLine({
  pr,
  onOpenUrlInPane,
  hidden = false
}: {
  pr: PrState | null
  onOpenUrlInPane?: (url: string) => void
  hidden?: boolean
}): React.JSX.Element | null {
  if (!pr) return null
  if (pr.gh !== 'ready') {
    return (
      <GitPrNotice hidden={hidden} testId="changes-pr-blocked">
        {pr.hint ?? 'gh is unavailable.'}
      </GitPrNotice>
    )
  }
  if (!pr.pr) return null
  const checks = prChecksLabel(pr.pr.checks)
  const decision = prDecisionLabel(pr.pr.review_decision)
  return (
    <GitPrSummaryLine hidden={hidden} testId="changes-pr-line">
      <GitPrSummaryLabel>
        PR #{pr.pr.number} · {checks}
        {decision ? ` · ${decision}` : ''}
      </GitPrSummaryLabel>
      <GitPrOpenAction
        variant="legacy-secondary"
        data-testid="changes-pr-open"
        disabled={!onOpenUrlInPane}
        onClick={() => onOpenUrlInPane?.(pr.pr!.url)}
      >
        <Icon glyph={IconExternal} role="small" />
        Open
      </GitPrOpenAction>
    </GitPrSummaryLine>
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

function initialChangesPaneState({ repoDir, notARepo, statusError, refresh }: {
  repoDir: string | null
  notARepo: boolean
  statusError: string | null
  refresh: () => void
}): React.JSX.Element | null {
  if (!repoDir) return <RepositoryPanelState testId="changes-idle" title="No workspace selected">Select this pane&rsquo;s workspace to see its changes.</RepositoryPanelState>
  if (notARepo) return <RepositoryPanelState testId="changes-not-a-repo" title="Not a Git repository">
    {repoDir} has no git repository yet. Once <Text as="code" mono>git init</Text>{' '}
    runs there — from a Shell pane — Changes will track it.
  </RepositoryPanelState>
  if (statusError !== null) return <RepositoryPanelState testId="changes-error" title="Git status unavailable" icon={<Icon glyph={IconAlertTriangle} role="heading" />} action={<Button variant="legacy-secondary" onClick={refresh}>Retry</Button>}>
    {statusError}
  </RepositoryPanelState>
  return null
}

function hasInitialState(repoDir: string | null, state: React.ReactNode): boolean {
  return !repoDir || state !== null
}

function ChangesErrorLines({ reviewError, commitError, prMessage }: { reviewError: string | null; commitError: string | null; prMessage: string | null }): React.JSX.Element {
  return <>
    {reviewError && <ScmErrorLine text={reviewError} testId="changes-review-error" />}
    {commitError && <ScmErrorLine text={commitError} testId="changes-commit-error" />}
    {prMessage && <ScmErrorLine text={prMessage} testId="changes-pr-message" />}
  </>
}

function CompactInlineDiffs({ visibleRows, expandedPaths, inlineDiffs, treeVisible, fileList }: {
  visibleRows: ChangeRow[]
  expandedPaths: Set<string>
  inlineDiffs: Map<string, DiffState>
  treeVisible: boolean
  fileList: React.ReactNode
}): React.JSX.Element {
  return <PrTab as="div" surface="changes-inline-list" state={treeVisible ? null : 'hidden'}>
    {treeVisible ? fileList : <CompactDetachedDiffs visibleRows={visibleRows} expandedPaths={expandedPaths} inlineDiffs={inlineDiffs} />}
  </PrTab>
}

function CompactDetachedDiffs({ visibleRows, expandedPaths, inlineDiffs }: {
  visibleRows: ChangeRow[]
  expandedPaths: Set<string>
  inlineDiffs: Map<string, DiffState>
}): React.JSX.Element {
  if (expandedPaths.size === 0) return <PrTab as="div" surface="changes-inline-empty">File tree hidden</PrTab>
  return <>{visibleRows.filter((row) => expandedPaths.has(row.path)).map((row) => {
    const inline = inlineDiffs.get(row.path)
    return <PrTab as="div" surface="changes-inline-diff" state="detached" key={row.path} data-path={row.path}>{inline ? <DiffBody patch={inline.patch} truncated={inline.truncated} /> : 'Loading diff…'}</PrTab>
  })}</>
}

function CompactChangesBody({ toolbar, notice, toolsNotice, toolsError, reviewError, commitError, prMessage, visibleRows, expandedPaths, inlineDiffs, treeVisible, fileList, commitBox }: {
  toolbar: React.ReactNode
  notice: React.ReactNode
  toolsNotice: string | null
  toolsError: string | null
  reviewError: string | null
  commitError: string | null
  prMessage: string | null
  visibleRows: ChangeRow[]
  expandedPaths: Set<string>
  inlineDiffs: Map<string, DiffState>
  treeVisible: boolean
  fileList: React.ReactNode
  commitBox: React.ReactNode
}): React.JSX.Element {
  return <>
    {toolbar}
    {notice}
    <ToolsNoticeLine notice={toolsNotice} error={toolsError} />
    <ChangesErrorLines reviewError={reviewError} commitError={commitError} prMessage={prMessage} />
    <CompactInlineDiffs visibleRows={visibleRows} expandedPaths={expandedPaths} inlineDiffs={inlineDiffs} treeVisible={treeVisible} fileList={fileList} />
    {commitBox}
  </>
}

function LoadingChangesBody({ toolbar, toolsNotice, toolsError, commitError, fileList, commitBox, prLine }: {
  toolbar: React.ReactNode
  toolsNotice: string | null
  toolsError: string | null
  commitError: string | null
  fileList: React.ReactNode
  commitBox: React.ReactNode
  prLine: React.ReactNode
}): React.JSX.Element {
  return <>
    {toolbar}
    <ToolsNoticeLine notice={toolsNotice} error={toolsError} />
    {commitError && <ScmErrorLine text={commitError} testId="changes-commit-error" />}
    {fileList}
    {commitBox}
    {prLine}
  </>
}

function ReadyChangesBody({ toolbar, notice, toolsNotice, toolsError, reviewError, commitError, prMessage, fileList, commitBox, prLine, diffPane, client, repoDir, compact }: {
  toolbar: React.ReactNode
  notice: React.ReactNode
  toolsNotice: string | null
  toolsError: string | null
  reviewError: string | null
  commitError: string | null
  prMessage: string | null
  fileList: React.ReactNode
  commitBox: React.ReactNode
  prLine: React.ReactNode
  diffPane: React.ReactNode
  client: HoustonClient | null
  repoDir: string
  compact?: boolean
}): React.JSX.Element {
  return <>
    {toolbar}
    {notice}
    <ToolsNoticeLine notice={toolsNotice} error={toolsError} />
    <ChangesErrorLines reviewError={reviewError} commitError={commitError} prMessage={prMessage} />
    <GitChangesBody>
      <GitChangesFileColumn>
        <GitChangesFileListFrame>{fileList}</GitChangesFileListFrame>
        <GitChangesWideActions>{commitBox}{prLine}</GitChangesWideActions>
      </GitChangesFileColumn>
      {diffPane}
    </GitChangesBody>
    {!compact && <BranchCommits client={client} dir={repoDir} />}
    <GitChangesNarrowActions>{commitBox}{prLine}</GitChangesNarrowActions>
  </>
}

function CompactDiffToolbar({ scope, setScope, stagedOnly, setStagedOnly, scopeMenuOpen, setScopeMenuOpen, defaultBase, branch, checkoutLabel, stageAll, unstageAll, bulkForGroup, visibleAdded, visibleDeleted, expanded, toggleAllDiffs, splitDiff, setSplitDiff, wrapDiff, setWrapDiff, treeVisible, setTreeVisible, refresh, strip }: {
  scope: 'working' | 'branch'
  setScope: (scope: 'working' | 'branch') => void
  stagedOnly: boolean
  setStagedOnly: (staged: boolean) => void
  scopeMenuOpen: boolean
  setScopeMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
  defaultBase: string | null
  branch: string | null
  checkoutLabel?: string
  stageAll: string[]
  unstageAll: string[]
  bulkForGroup: (group: ChangeRow['group'], paths: string[]) => void
  visibleAdded: number
  visibleDeleted: number
  expanded: boolean
  toggleAllDiffs: () => void
  splitDiff: boolean
  setSplitDiff: (split: boolean) => void
  wrapDiff: boolean
  setWrapDiff: React.Dispatch<React.SetStateAction<boolean>>
  treeVisible: boolean
  setTreeVisible: React.Dispatch<React.SetStateAction<boolean>>
  refresh: () => void
  strip: React.ReactNode
}): React.JSX.Element {
  const scopeMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!scopeMenuOpen) return
    const closeOutside = (event: MouseEvent): void => {
      if (!scopeMenuRef.current?.contains(event.target as Node)) setScopeMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setScopeMenuOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeOnEscape, true)
    return () => {
      document.removeEventListener('mousedown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [scopeMenuOpen, setScopeMenuOpen])
  const scopeLabel = scope === 'branch' ? 'Branch' : stagedOnly ? 'Staged' : 'Changes'
  const branchLabel = branch ?? checkoutLabel ?? 'inspector-polish'
  return <PrTab as="div" surface="changes-diff-toolbar" data-testid="changes-diff-toolbar">
    <PrTab as="div" surface="changes-diff-scope-wrap" ref={scopeMenuRef}>
      <PrTab as="button" surface="changes-diff-scope" type="button" aria-label="Choose diff scope" aria-expanded={scopeMenuOpen} onClick={() => setScopeMenuOpen((open) => !open)}>
        {scopeLabel} <Icon glyph={IconChevronDown} role="small" />
      </PrTab>
      {scopeMenuOpen && <PrTab as="div" surface="changes-diff-scope-menu" role="menu">
        <button role="menuitem" onClick={() => { setScope('working'); setStagedOnly(false); setScopeMenuOpen(false) }}>Uncommitted changes</button>
        <button role="menuitem" disabled={!defaultBase} onClick={() => { setScope('branch'); setStagedOnly(false); setScopeMenuOpen(false) }}>Branch changes</button>
        <button role="menuitem" onClick={() => { setScope('working'); setStagedOnly(true); setScopeMenuOpen(false) }}>Staged changes</button>
        <button role="menuitem" data-testid="changes-stage-all" disabled={stageAll.length === 0} onClick={() => bulkForGroup('unstaged', stageAll)}>Stage all</button>
        <button role="menuitem" data-testid="changes-unstage-all" disabled={unstageAll.length === 0} onClick={() => bulkForGroup('staged', unstageAll)}>Unstage all</button>
        <button role="menuitem" aria-label="Wrap lines" onClick={() => setWrapDiff((value) => !value)}>Toggle line wrapping</button>
        <button role="menuitem" aria-label="File tree" onClick={() => setTreeVisible((value) => !value)}>Toggle file tree</button>
      </PrTab>}
    </PrTab>
    <PrTab as="div" surface="changes-diff-refs"><span>{defaultBase ?? 'main'}</span><span aria-hidden>←</span><span>{branchLabel}</span></PrTab>
    <PrTab as="span" surface="changes-diff-stat"><span data-tone="added">+{visibleAdded}</span><span data-tone="deleted">−{visibleDeleted}</span></PrTab>
    <PrTab as="div" surface="changes-diff-actions">
      <button type="button" aria-label="Refresh diff" onClick={refresh}><Icon glyph={IconRefresh} role="small" /></button>
      <button type="button" aria-label={expanded ? 'Collapse all' : 'Expand all'} onClick={toggleAllDiffs}><Icon glyph={expanded ? IconCollapse : IconExpand} role="small" /></button>
      <PrTab as="span" surface="changes-diff-segment" role="group" aria-label="Diff layout">
        <button type="button" aria-label="Stacked diff" aria-pressed={!splitDiff} onClick={() => setSplitDiff(false)}><Icon glyph={IconSplitDown} role="small" /></button>
        <button type="button" aria-label="Split diff" aria-pressed={splitDiff} onClick={() => setSplitDiff(true)}><Icon glyph={IconSplitRight} role="small" /></button>
      </PrTab>
      <button type="button" aria-label="Wrap lines" aria-pressed={wrapDiff} onClick={() => setWrapDiff((value) => !value)}><span aria-hidden>↪</span></button>
      <button type="button" aria-label="File tree" aria-pressed={treeVisible} onClick={() => setTreeVisible((value) => !value)}><Icon glyph={IconFolderOpen} role="small" /></button>
      <ChangesToolbar compact strip={strip} />
    </PrTab>
  </PrTab>
}

export function ChangesPane({
  client,
  dir,
  checkoutLabel,
  onOpenFileInEditor,
  onOpenUrlInPane,
  onReviewPacket,
  review = null,
  onSummary,
  refreshSignal = 0,
  compact
}: ChangesPaneProps): React.JSX.Element {
  const repoDir = dir

  const [files, setFiles] = useState<GitFileStatus[] | null>(null)
  const [branch, setBranch] = useState<string | null>(null)
  const [ahead, setAhead] = useState(0)
  const [behind, setBehind] = useState(0)
  const [upstream, setUpstream] = useState<string | null>(null)
  const [defaultBase, setDefaultBase] = useState<string | null>(null)
  const [notARepo, setNotARepo] = useState(false)
  const [scope, setScope] = useState<'working' | 'branch'>('working')
  const [stagedOnly, setStagedOnly] = useState(false)
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set())
  const [inlineDiffs, setInlineDiffs] = useState<Map<string, DiffState>>(() => new Map())
  const [wrapDiff, setWrapDiff] = useState(false)
  const [splitDiff, setSplitDiff] = useState(false)
  const [treeVisible, setTreeVisible] = useState(true)
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

  useEffect(() => {
    if (selected === null && rows.length > 0) {
      const initialPath = compact && files?.[0] ? files[0].path : rows[0].path
      setSelected(initialPath)
      if (compact) setExpandedPaths(new Set([initialPath]))
    }
  }, [rows, files, selected, compact])
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
      prNumber: pr?.pr?.number,
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
    setNotARepo,
    setStatusError,
    setCommitError,
    setCommitting,
    setPushing,
    setPushAfterCommit,
    setCommitMsg
  })

  useInlineDiffSubscription(client, repoDir, base, setInlineDiffs)

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

  useSelectedGitDiff(client, repoDir, selectedRow, base, setDiff)

  const select = useCallback((path: string): void => {
    setSelected(path)
    setDiff(null)
    setMenuFor(null)
  }, [])

  const togglePath = useCallback((row: ChangeRow): void => {
    setExpandedPaths((current) => {
      const next = new Set(current)
      if (next.has(row.path)) next.delete(row.path)
      else next.add(row.path)
      return next
    })
    setSelected(row.path)
    setDiff(null)
    if (!row.blocked && client && repoDir) client.gitDiff(repoDir, row.path, base)
  }, [client, repoDir, base])

  const toggleAllDiffs = useCallback((): void => {
    if (expandedPaths.size === rows.length) {
      setExpandedPaths(new Set())
      return
    }
    setExpandedPaths(new Set(rows.map((row) => row.path)))
    if (client && repoDir) {
      rows.filter((row) => !row.blocked).forEach((row) => client.gitDiff(repoDir, row.path, base))
    }
  }, [expandedPaths.size, rows, client, repoDir, base])

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
    changeListKeyDown(rows, selected, setSelected, select, stageToggle),
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

  const paneState = paneStateFor(repoDir, notARepo, statusError, rows.length, files !== null)

  const reviewing = review !== null

  const canCommit = canCommitForState(staged, commitMsg, committing)
  const pushBlocked = pushBlockedReason(client !== null, repoDir !== null, upstream, ahead, pushing)
  const offerCreatePr = offerPrCreateForState(pr)

  const visibleRows = useMemo(() => visibleRowsFor(rows, stagedOnly), [rows, stagedOnly])
  const visibleFiles = useMemo(() => visibleFilesFor(files, stagedOnly), [files, stagedOnly])
  const visibleAdded = visibleRows.reduce((sum, row) => sum + (row.added ?? 0), 0)
  const visibleDeleted = visibleRows.reduce((sum, row) => sum + (row.deleted ?? 0), 0)

  const shell = (body: React.ReactNode): React.JSX.Element => (
    <GitChangesSurface compact={compact === true} state={paneState} reviewing={reviewing}>
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
    </GitChangesSurface>
  )

  const initialState = initialChangesPaneState({ repoDir, notARepo, statusError, refresh })
  if (hasInitialState(repoDir, initialState)) return shell(initialState)
  const activeRepoDir = repoDir!

  const strip = (
    <ChangesStrip
      scope={scope}
      setScope={setScope}
      defaultBase={defaultBase}
      client={client}
      repoDir={activeRepoDir}
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

  const stripChrome = <ChangesToolbar compact={compact === true} strip={strip} />

  const notice = <ReviewNoticeLine reviewNotice={reviewNotice} />
  const fileList = (
    <ChangesFileList
      compact={compact}
      files={compact ? visibleFiles : files}
      rows={compact ? visibleRows : rows}
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
      repoDir={activeRepoDir}
      stageAll={stageAll}
      unstageAll={unstageAll}
      bulkForGroup={bulkForGroup}
      setStatusError={setStatusError}
      inlineDiffs={compact ? inlineDiffs : undefined}
      expandedPaths={compact ? expandedPaths : undefined}
      togglePath={compact ? togglePath : undefined}
      wrapDiff={wrapDiff}
      splitDiff={splitDiff}
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
      onOpenInEditor={openSelectedFile(onOpenFileInEditor, activeRepoDir, selectedRow)}
      onReview={openReviewPicker}
      reviewDisabledReason={reviewDisabledReason(client !== null, reviewBusy)}
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
      compact={compact === true}
      target={checkoutLabel ?? (repoDir ? repoDir.split(/[\\/]/).filter(Boolean).at(-1) : undefined)}
    />
  )

  const prLine = <PrLine pr={pr} onOpenUrlInPane={onOpenUrlInPane} hidden={compact} />

  const compactToolbar = compact ? <CompactDiffToolbar
    scope={scope} setScope={setScope} stagedOnly={stagedOnly} setStagedOnly={setStagedOnly}
    scopeMenuOpen={scopeMenuOpen} setScopeMenuOpen={setScopeMenuOpen} defaultBase={defaultBase}
    branch={branch} checkoutLabel={checkoutLabel} stageAll={stageAll} unstageAll={unstageAll}
    bulkForGroup={bulkForGroup} visibleAdded={visibleAdded} visibleDeleted={visibleDeleted}
    expanded={expandedPaths.size === rows.length} toggleAllDiffs={toggleAllDiffs} splitDiff={splitDiff}
    setSplitDiff={setSplitDiff} wrapDiff={wrapDiff} setWrapDiff={setWrapDiff} treeVisible={treeVisible}
    setTreeVisible={setTreeVisible} refresh={refresh} strip={strip}
  /> : null

  const body = compact ? <CompactChangesBody toolbar={compactToolbar} notice={notice} toolsNotice={toolsNotice} toolsError={toolsError} reviewError={reviewError} commitError={commitError} prMessage={prMessage} visibleRows={visibleRows} expandedPaths={expandedPaths} inlineDiffs={inlineDiffs} treeVisible={treeVisible} fileList={fileList} commitBox={commitBox} />
    : paneState === 'loading' || paneState === 'empty'
      ? <LoadingChangesBody toolbar={stripChrome} toolsNotice={toolsNotice} toolsError={toolsError} commitError={commitError} fileList={fileList} commitBox={commitBox} prLine={prLine} />
      : <ReadyChangesBody toolbar={stripChrome} notice={notice} toolsNotice={toolsNotice} toolsError={toolsError} reviewError={reviewError} commitError={commitError} prMessage={prMessage} fileList={fileList} commitBox={commitBox} prLine={prLine} diffPane={diffPane} client={client} repoDir={activeRepoDir} compact={compact} />

  return shell(body)
}

function ChangesToolbar({ compact, strip }: { compact: boolean; strip: React.ReactNode }): React.JSX.Element {
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!anchor) return
    const close = (): void => setAnchor(null)
    const onMouseDown = (event: MouseEvent): void => {
      if (event.target instanceof Node && trigger.current?.contains(event.target)) return
      close()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [anchor])
  if (!compact) return <>{strip}</>
  return (
    <GitCompactToolsAnchor>
      <Tooltip label="Git actions and diff scope">
        <button
          ref={trigger}
          aria-label="Git actions and diff scope"
          aria-expanded={anchor !== null}
          onClick={() => {
            const rect = trigger.current!.getBoundingClientRect()
            setAnchor(anchor ? null : { top: rect.bottom, right: window.innerWidth - rect.right })
          }}
        >
          <Icon glyph={IconEllipsis} role="ui" />
        </button>
      </Tooltip>
      {anchor && createPortal(
        <GitCompactToolsSurface
          {...OVERLAY_GLASS_OVERLAY_ATTRS}
          style={{ position: 'fixed', ...anchor, ...popOriginStyle('right', 'top') }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {strip}
        </GitCompactToolsSurface>,
        document.body
      )}
    </GitCompactToolsAnchor>
  )
}
