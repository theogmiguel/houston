import { Icon } from './Icon'
import { Segmented } from './Segmented'
import { Tooltip } from './Tooltip'
import { Suspense, useEffect, useState } from 'react'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { isLive } from '../houston/client'
import type { DelegationResult } from '../houston/generated/DelegationResult'
import type { InboxRow } from '../houston/generated/InboxRow'
import { selectOverviewChild } from '../sidePanel'
import { ChildStatusDot, childGroup, childStateWord, DelegationAge } from './ChildrenRoster'
import { sessionIdentity } from './DelegationCard'
import { IconAgent, IconEye, IconGitBranch, IconStopCircle, IconRespawn, IconCornerDownRight } from './icons'
import { StatusDot } from './SessionPane'
import { BTN_GHOST, BTN_ICO, BTN_PRIMARY } from './buttonChrome'

export function OverviewTab({ parentId, sessions, client, onClose, onReview }: {
  parentId: number
  sessions: ReadonlyMap<number, SessionInfo>
  client: HoustonClient
  onClose: () => void
  onReview: (child: SessionInfo) => void
}): React.JSX.Element {
  const parent = sessions.get(parentId)
  const children = [...sessions.values()].filter((child) => child.spawned_by === parentId)
  const [results, setResults] = useState<DelegationResult[]>([])
  const [rows, setRows] = useState<InboxRow[]>([])
  const [counts, setCounts] = useState(new Map<string, number>())
  const [groupBy, setGroupBy] = useState<'status' | 'worktree'>('status')
  useEffect(() => {
    const workspaces = new Set([parent?.project_dir, ...children.flatMap((child) => [child.project_dir, child.worktree?.path])].filter((dir): dir is string => Boolean(dir)))
    const offRows = client.subscribe('inbox_rows', (message) => {
      if (!workspaces.has(message.workspace)) return
      setRows((current) => [...current.filter((row) => row.workspace !== message.workspace), ...message.rows])
    })
    const offChanged = client.subscribe('inbox_changed', (message) => {
      if (!workspaces.has(message.workspace)) return
      client.delegationResultsList(parentId)
      setRows((current) => [...current.filter((row) => row.id !== message.row.id), message.row])
    })
    const offGit = client.subscribe('git_status', (message) => {
      if (message.base != null || !workspaces.has(message.dir)) return
      setCounts((current) => new Map(current).set(message.dir, new Set(message.files.map((file) => file.path)).size))
    })
    for (const workspace of workspaces) { client.inboxList(workspace); client.gitStatus(workspace, null) }
    return () => { offRows(); offChanged(); offGit() }
  }, [client, parentId, parent?.project_dir, children.flatMap((child) => [child.project_dir, child.worktree?.path ?? '']).sort().join('\0')])
  useEffect(() => {
    setResults([])
    const refresh = (): void => client.delegationResultsList(parentId)
    const off = client.subscribe('delegation_results', (message) => {
      if (message.parent === parentId) setResults(message.results)
    })
    refresh()
    return () => { off() }
  }, [client, parentId, children.map((child) => `${child.id}:${child.delegation?.state}:${child.delegation?.result_staged}`).join(',')])
  const childIds = new Set(children.map((child) => child.id))
  const addressed = rows.filter((row) => row.to_session === 0 && row.resolved_at == null && (row.reason === 'parent_dead' || (row.from_session != null && sessions.get(row.from_session)?.spawned_by === null)) && (row.original_to === parentId || row.from_session === parentId || (row.from_session != null && childIds.has(row.from_session))))
  const done = children.filter((child) => !isLive(child.state) && child.delegation?.state !== 'failed').length
  const failed = children.filter((child) => !isLive(child.state) && child.delegation?.state === 'failed').length
  const ordered = [...children].sort((a, b) => groupBy === 'worktree' ? (a.worktree?.path ?? a.checkout_root ?? a.project_dir).localeCompare(b.worktree?.path ?? b.checkout_root ?? b.project_dir) : ['Needs you', 'Working', 'Settled'].indexOf(childGroup(a)) - ['Needs you', 'Working', 'Settled'].indexOf(childGroup(b)))
  const action = (label: string, onClick: () => void): React.JSX.Element => <button className={`btn ${BTN_GHOST}`} onClick={onClick}>{label}</button>
  return <div className="overview">
    <header className="overview-head"><StatusDot live={!!parent && isLive(parent.state)} status={parent?.status} />{parent && <IconAgent brand agent={parent.detected_agent ?? parent.agent} className="w-3.5 h-3.5 flex-none" />}<strong>{parent?.title ?? `Orchestrator ${parentId}`}</strong><span className="font-mono text-[var(--text-faint)]">pane {parentId}</span>{parent && <CompactionCount parent={parent} />}{action('Show terminal', () => selectOverviewChild(parentId, null))}</header>
    {(!parent || !isLive(parent.state)) && <div className="overview-summary">Orchestrator ended.{action('Close', onClose)}</div>}
    <div className="overview-summary"><strong className={children.some((child) => childGroup(child) === 'Needs you') ? 'text-[var(--warn)]' : undefined}>{children.length}</strong><span className="truncate">children · {children.filter((child) => childGroup(child) === 'Needs you').length} needs you · {children.filter((child) => childGroup(child) === 'Working').length} working · {done} done · {failed} failed</span><span className="flex-1" /><Segmented aria-label="Group children" className="overview-grouping" value={groupBy} onChange={setGroupBy} options={[{ value: 'status', label: 'Status' }, { value: 'worktree', label: 'Worktree' }]} /></div>
    <div className="overview-bar">{(['Needs you', 'Working', 'Done', 'Failed'] as const).map((group) => <i key={group} data-group={group} style={{ flex: group === 'Done' ? done : group === 'Failed' ? failed : children.filter((child) => childGroup(child) === group).length }} />)}</div>
    <div className="overview-cards">{ordered.map((child) => <OverviewChildCard key={child.id} child={child} parent={parent} parentId={parentId} children={children} result={results.find((result) => result.child === child.id)} counts={counts} client={client} onReview={onReview} />)}</div>
    {addressed.length > 0 && <section aria-label="Addressed to you"><h3 className="overview-summary">Addressed to you</h3>{addressed.map((row) => <article key={String(row.id)} className="overview-child"><div className="overview-task">{row.summary || row.body}</div><div className="overview-actions">{action('Acknowledge', () => client.inboxAck(row.id))}{action('Resolve', () => client.inboxResolve(row.id))}</div></article>)}</section>}
  </div>
}

function CompactionCount({ parent }: { parent: SessionInfo }): React.JSX.Element | null {
  const agent = parent.detected_agent ?? parent.agent
  if (parent.compactions == null) {
    return agent === 'shell' || agent === 'custom' || agent === 'ssh' ? null : <span className="text-[var(--text-faint)]">compactions not reported by {agent}</span>
  }
  return <Tooltip label="Context compactions the agent reported. Every third one, Houston offers this orchestrator a handoff to a new pane."><span className="font-mono text-[var(--text-faint)]">{parent.compactions} {parent.compactions === 1 ? 'compaction' : 'compactions'}</span></Tooltip>
}

function CheckoutChips({ child, parent, shared, count }: { child: SessionInfo; parent?: SessionInfo; shared?: SessionInfo; count?: number }): React.JSX.Element {
  const separate = child.project_dir !== parent?.project_dir
  const checkout = child.worktree?.branch
  return <div className="overview-chips">{separate && <span>{child.project_dir}</span>}{checkout && <span className="overview-branch"><Icon glyph={IconGitBranch} role="label" />{checkout}</span>}{shared && <span>shares checkout with {shared.delegation?.role ?? sessionIdentity(shared)}</span>}{child.worktree && count !== undefined && <span>{count} changed files</span>}</div>
}

function OverviewChildCard({ child, parent, parentId, children, result, counts, client, onReview }: {
  child: SessionInfo
  parent?: SessionInfo
  parentId: number
  children: SessionInfo[]
  result?: DelegationResult
  counts: ReadonlyMap<string, number>
  client: HoustonClient
  onReview: (child: SessionInfo) => void
}): React.JSX.Element {
  const cardAction = (label: string, glyph: typeof IconEye, onClick: () => void): React.JSX.Element => <Tooltip label={label}><button className={BTN_ICO} aria-label={label} onClick={onClick}><Icon glyph={glyph} role="label" /></button></Tooltip>
      const needs = childGroup(child) === 'Needs you'
      const settled = childGroup(child) === 'Settled'

      const shared = isLive(child.state) ? children.find((other) => other.id !== child.id && isLive(other.state) && child.checkout_root != null && other.checkout_root === child.checkout_root) : undefined
      return <article key={child.id} className={`overview-child ${needs ? 'needs' : ''}`}>
        <OverviewChildHead child={child} needs={needs} settled={settled} />
        <div className="overview-task">{child.title}</div>
        <CheckoutChips child={child} parent={parent} shared={shared} count={counts.get(child.worktree?.path ?? child.project_dir)} />
        <div className="overview-actions">{cardAction('Select', IconEye, () => selectOverviewChild(parentId, child.id))}{cardAction('Review changes', IconGitBranch, () => onReview(child))}{settled ? cardAction('Continue', IconRespawn, () => client.respawnSession(child.id, undefined, null, undefined, undefined, false)) : cardAction('Stop', IconStopCircle, () => client.closeSession(child.id))}</div>
        <div className="overview-result">{needs && <Icon glyph={IconCornerDownRight} role="label" />}<span>{childResultExcerpt(child, result, needs)}</span>{needs && <button className={`btn border ${BTN_PRIMARY}`} onClick={() => selectOverviewChild(parentId, child.id)}>Answer</button>}</div>
      </article>
}

function childResultExcerpt(child: SessionInfo, result: DelegationResult | undefined, needs: boolean): string {
  return (needs ? child.delegation?.hold_reason : null) || result?.excerpt || result?.summary || 'no result yet'
}


function OverviewChildHead({ child, needs, settled }: { child: SessionInfo; needs: boolean; settled: boolean }): React.JSX.Element {
  return <div className="overview-child-head"><span className="overview-dot" data-state={settled ? child.delegation?.state : undefined}><ChildStatusDot info={child} /></span><IconAgent brand agent={child.detected_agent ?? child.agent} className="w-3.5 h-3.5 flex-none" /><strong>{child.delegation?.role ?? child.title}</strong><span className="font-mono text-[var(--text-faint)]">{sessionIdentity(child)}</span><span className="overview-state" data-state={needs ? 'needs_input' : childStateWord(child)}>{needs ? 'Needs you' : childStateWord(child).replace(/^./, (letter) => letter.toUpperCase())}</span><span className="age"><Suspense fallback={null}><DelegationAge start={child.delegation?.started_at ?? Date.now()} end={child.delegation?.settled_at} ticking={!settled && child.delegation?.settled_at == null} /></Suspense></span></div>
}
