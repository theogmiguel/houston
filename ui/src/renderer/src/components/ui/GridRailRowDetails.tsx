import { lazy, Suspense } from 'react'
import type { PrInfo, SessionInfo } from '../../houston/client'
import type { TagInfo } from '../../houston/generated/TagInfo'
import { RAIL_TAG_MARK_AT } from '../../railWidth'
import { Icon } from './Icon'
import { Tooltip } from './Tooltip'
import { IconCheck, IconClose, IconGitBranch, IconGitPullRequest, IconFolder, IconLoaderCircle, IconTag } from '../icons'
import { line2DetailsForWidth, railHoverCardModel } from './railRowModel'
import type { RailLine2Details } from './railRowModel'
import type { RailDiffTotals } from '../git/useRailGitFacts'
import type { RailPrState } from '../git/railPrCache'

type OpenInspector = (paneId: number, tab: 'changes' | 'pull-request') => void
const GridRailHoverCard = lazy(() => import('./GridRailHoverCard').then((module) => ({ default: module.GridRailHoverCard })))

function prTone(state: string | undefined): string {
  if (state === 'MERGED') return 'text-[var(--merged)]'
  if (state === 'CLOSED') return 'text-[var(--stop)]'
  return 'text-[var(--ok)]'
}

function ChecksGlyph({ checks }: { checks: PrInfo['checks'] }): React.JSX.Element {
  if (checks === 'passing') return <Icon glyph={IconCheck} role="small" className="flex-none text-[var(--ok)]" />
  if (checks === 'failing') return <Icon glyph={IconClose} role="small" className="flex-none text-[var(--stop)]" />
  if (checks === 'running') return <Icon glyph={IconLoaderCircle} role="small" className="flex-none text-[var(--warn)]" />
  return <></>
}

function PullRequestBadge({ panes, prStatus, onOpenInspector, onOpenExternal }: {
  panes: SessionInfo[]
  prStatus?: RailPrState
  onOpenInspector: OpenInspector
  onOpenExternal: (url: string) => void
}): React.JSX.Element | null {
  const pr = prStatus?.pr
  if (!pr && prStatus?.gh !== 'missing' && prStatus?.gh !== 'unauthenticated') return null
  const label = pr ? `PR #${pr.number} · ${pr.state.toLowerCase()} · checks ${pr.checks.toLowerCase()}` : 'GitHub unavailable'
  return <Tooltip label={label}><button type="button" className={`rail-pr inline-flex flex-none items-center gap-[var(--space-1)] rounded-[var(--tr-radius-input)] px-[var(--space-1)] ${prTone(pr?.state)}`} aria-label={pr ? `Open pull request ${pr.number}` : 'GitHub unavailable'} onClick={(event) => {
    event.stopPropagation()
    if (event.ctrlKey || event.metaKey) { if (pr) onOpenExternal(pr.url) }
    else if (panes[0]) onOpenInspector(panes[0].id, 'pull-request')
  }}>
    {pr && <Icon glyph={IconGitPullRequest} role="small" className="flex-none" />}
    {pr ? `#${pr.number}` : 'GitHub unavailable'}
    {pr && pr.state !== 'MERGED' && <ChecksGlyph checks={pr.checks} />}
  </button></Tooltip>
}

function ChangesBadge({ panes, details, diff, onOpenInspector }: {
  panes: SessionInfo[]
  details: RailLine2Details
  diff: { added: number; deleted: number }
  onOpenInspector: OpenInspector
}): React.JSX.Element | null {
  if (!details.diff || (diff.added === 0 && diff.deleted === 0)) return null
  return <Tooltip label="Open changes"><button type="button" className="rail-diff inline-flex flex-none items-center gap-[var(--space-1)]" aria-label="Open changes" onClick={(event) => {
    event.stopPropagation()
    if (panes[0]) onOpenInspector(panes[0].id, 'changes')
  }}><span className="text-[var(--ok)]">+{diff.added}</span><span className="text-[var(--stop)]">−{diff.deleted}</span></button></Tooltip>
}

function RailTags({ tags, width }: { tags: readonly TagInfo[]; width: number }): React.JSX.Element | null {
  if (tags.length === 0 || width < RAIL_TAG_MARK_AT) return null
  const names = tags.map((tag) => tag.name)
  return <Tooltip label={names.join(' · ')}><span data-testid="rail-tags" className="rail-tags flex flex-none items-center gap-[2px]" aria-label={`Tags: ${names.join(', ')}`}>
    <span data-testid="rail-tag-glyph" className="inline-flex" style={{ color: tags[0].color }}><Icon glyph={IconTag} role="small" /></span>
    {tags.length > 1 && <span className="text-[var(--text-faint)]">+{tags.length - 1}</span>}
  </span></Tooltip>
}

export function GridRailRowDetails({
  name, sessions, paneIds, tags, branches, diffByDir, prByDir, width, card, closeTimer, scheduleClose, onOpenInspector, onOpenExternal,
}: {
  name: string
  sessions: SessionInfo[]
  paneIds: number[]
  tags: readonly TagInfo[]
  branches: ReadonlyMap<number, string>
  diffByDir: ReadonlyMap<string, RailDiffTotals>
  prByDir: ReadonlyMap<string, RailPrState>
  width: number
  card: { left: number; top: number } | null
  closeTimer: React.MutableRefObject<ReturnType<typeof setTimeout> | null>
  scheduleClose: () => void
  onOpenInspector: OpenInspector
  onOpenExternal: (url: string) => void
}): React.JSX.Element | null {
  const model = railHoverCardModel(sessions, paneIds, branches, diffByDir, prByDir)
  const panes = model.panes.map((row) => row.session)
  const details = line2DetailsForWidth(width)
  const uniqueCheckouts = model.checkouts.map((checkout) => [checkout.path, checkout.session] as const)
  const primary = uniqueCheckouts[0]?.[1]
  const branch = primary ? branches.get(primary.id) ?? primary.worktree?.branch : undefined
  const worktreePath = primary?.worktree?.path
  const primaryDir = primary ? primary.worktree?.path ?? primary.checkout_root ?? primary.cwd : ''
  const prStatus = primaryDir ? prByDir.get(primaryDir) : undefined
  const diff = uniqueCheckouts.reduce((sum, [dir]) => {
    const facts = diffByDir.get(dir)
    return { added: sum.added + (facts?.added ?? 0), deleted: sum.deleted + (facts?.deleted ?? 0) }
  }, { added: 0, deleted: 0 })
  const otherBranches = uniqueCheckouts.slice(1).map(([, pane]) => branches.get(pane.id) ?? pane.worktree?.branch ?? pane.worktree?.path ?? pane.checkout_root ?? pane.cwd)
  if (panes.length === 0) return null
  return <>
    <span className="rail-grid-line2 flex min-w-0 items-center gap-[var(--space-1-5)] pl-[var(--space-4-5)] font-mono [font-size:var(--tr-text-label-size)] text-[var(--text-muted)]">
    {branch && <Tooltip label={worktreePath ? `Worktree: ${worktreePath}` : branch}><span className="rail-branch flex min-w-0 flex-1 items-center gap-[var(--space-1)] truncate">
      {worktreePath ? <Icon glyph={IconFolder} role="small" className="flex-none text-[var(--ok)]" /> : <Icon glyph={IconGitBranch} role="small" className="flex-none" />}
      <span className="truncate">{branch}</span>
    </span></Tooltip>}
    {otherBranches.length > 0 && details.otherBranches && <Tooltip label={otherBranches.join(' · ')}><span className="rail-more flex-none">+{otherBranches.length}</span></Tooltip>}
    <PullRequestBadge panes={panes} prStatus={prStatus} onOpenInspector={onOpenInspector} onOpenExternal={onOpenExternal} />
    <ChangesBadge panes={panes} details={details} diff={diff} onOpenInspector={onOpenInspector} />
    <RailTags tags={tags} width={width} />
    </span>
    {card && <Suspense fallback={null}><GridRailHoverCard name={name} position={card} closeTimer={closeTimer} scheduleClose={scheduleClose} paneRows={model.panes} tags={tags} checkouts={model.checkouts} onOpenInspector={onOpenInspector} /></Suspense>}
  </>
}
