import { Icon } from './Icon'
import { Tooltip } from './Tooltip'
import { useEffect, useState } from 'react'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { isLive } from '../houston/client'
import type { InboxRow } from '../houston/generated/InboxRow'
import { selectOverviewChild } from '../sidePanel'
import { childGroup, childStateWord, delegationAge } from './ChildrenRoster'
import { sessionIdentity } from './DelegationCard'
import { IconAgent, IconEye, IconGitBranch, IconStopCircle, IconRespawn } from './icons'
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
  const [rows, setRows] = useState<InboxRow[]>([])
  const [now, setNow] = useState(Date.now)
  const [counts, setCounts] = useState(new Map<string, number>())
  const [groupBy, setGroupBy] = useState<'status' | 'worktree'>('status')
  useEffect(() => {
    // Human-readable ages change once a second, outside terminal rendering.
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [])
  useEffect(() => {
    const workspaces = new Set([parent?.project_dir, ...children.map((child) => child.project_dir)].filter((dir): dir is string => Boolean(dir)))
    const offRows = client.subscribe('inbox_rows', (message) => {
      if (!workspaces.has(message.workspace)) return
      setRows((current) => [...current.filter((row) => row.workspace !== message.workspace), ...message.rows])
    })
    const offChanged = client.subscribe('inbox_changed', (message) => {
      if (!workspaces.has(message.workspace)) return
      setRows((current) => [...current.filter((row) => row.id !== message.row.id), message.row])
    })
    const offGit = client.subscribe('git_status', (message) => {
      if (message.base != null || !workspaces.has(message.dir)) return
      setCounts((current) => new Map(current).set(message.dir, new Set(message.files.map((file) => file.path)).size))
    })
    for (const workspace of workspaces) { client.inboxList(workspace); client.gitStatus(workspace, null) }
    return () => { offRows(); offChanged(); offGit() }
  }, [client, parent?.project_dir, children.map((child) => child.project_dir).sort().join('\0')])
  const childIds = new Set(children.map((child) => child.id))
  const addressed = rows.filter((row) => row.to_session === 0 && row.resolved_at == null && (row.original_to === parentId || (row.from_session != null && childIds.has(row.from_session))))
  const ordered = [...children].sort((a, b) => groupBy === 'worktree' ? a.project_dir.localeCompare(b.project_dir) : ['Needs you', 'Working', 'Settled'].indexOf(childGroup(a)) - ['Needs you', 'Working', 'Settled'].indexOf(childGroup(b)))
  const action = (label: string, onClick: () => void): React.JSX.Element => <button className={`btn ${BTN_GHOST}`} onClick={onClick}>{label}</button>
  return <div className="overview">
    <header className="overview-head"><StatusDot live={!!parent && isLive(parent.state)} status={parent?.status} />{parent && <IconAgent agent={parent.detected_agent ?? parent.agent} className="w-3.5 h-3.5 flex-none" />}<strong>{parent?.title ?? `Orchestrator ${parentId}`}</strong><span className="font-mono text-[var(--text-faint)]">pane {parentId}</span>{action('Show terminal', () => selectOverviewChild(parentId, null))}</header>
    {(!parent || !isLive(parent.state)) && <div className="overview-summary">Orchestrator ended.{action('Close', onClose)}</div>}
    <div className="overview-summary"><strong>{children.length}</strong><span className="truncate">children · {children.filter((child) => childGroup(child) === 'Needs you').length} needs you · {children.filter((child) => childGroup(child) === 'Working').length} working · {children.filter((child) => childGroup(child) === 'Settled').length} settled</span><span className="flex-1" /><button aria-pressed={groupBy === 'status'} onClick={() => setGroupBy('status')}>Status</button><button aria-pressed={groupBy === 'worktree'} onClick={() => setGroupBy('worktree')}>Worktree</button></div>
    <div className="overview-bar">{(['Needs you', 'Working', 'Settled'] as const).map((group) => <i key={group} data-group={group} style={{ flex: children.filter((child) => childGroup(child) === group).length }} />)}</div>
    <div className="overview-cards">{ordered.map((child) => <OverviewChildCard key={child.id} child={child} parent={parent} parentId={parentId} children={children} result={rows.filter((row) => row.from_session === child.id && row.kind === 'result').sort((a, b) => Number(b.created_at - a.created_at))[0]} now={now} counts={counts} client={client} onReview={onReview} />)}</div>
    {addressed.length > 0 && <section aria-label="Addressed to you"><h3 className="overview-summary">Addressed to you</h3>{addressed.map((row) => <article key={String(row.id)} className="overview-child"><div className="overview-task">{row.summary || row.body}</div><div className="overview-actions">{action('Acknowledge', () => client.inboxAck(row.id))}{action('Resolve', () => client.inboxResolve(row.id))}</div></article>)}</section>}
  </div>
}

function CheckoutChips({ child, parent, shared, count }: { child: SessionInfo; parent?: SessionInfo; shared?: SessionInfo; count?: number }): React.JSX.Element {
  const separate = child.project_dir !== parent?.project_dir
  const checkout = shared ? `shares checkout with ${shared.delegation?.role ?? sessionIdentity(shared)}` : separate ? 'Separate checkout' : 'shares checkout with orchestrator'
  return <div className="overview-chips">{separate && <span>{child.project_dir}</span>}<span>{checkout}</span>{separate && count !== undefined && <span>{count} changed files</span>}</div>
}

function OverviewChildCard({ child, parent, parentId, children, result, now, counts, client, onReview }: {
  child: SessionInfo
  parent?: SessionInfo
  parentId: number
  children: SessionInfo[]
  result?: InboxRow
  now: number
  counts: ReadonlyMap<string, number>
  client: HoustonClient
  onReview: (child: SessionInfo) => void
}): React.JSX.Element {
  const cardAction = (label: string, glyph: typeof IconEye, onClick: () => void): React.JSX.Element => <Tooltip label={label}><button className={BTN_ICO} aria-label={label} onClick={onClick}><Icon glyph={glyph} role="label" /></button></Tooltip>
      const needs = childGroup(child) === 'Needs you'
      const settled = childGroup(child) === 'Settled'

      const shared = children.find((other) => other.id !== child.id && other.project_dir === child.project_dir)
      return <article key={child.id} className={`overview-child ${needs ? 'needs' : ''}`}>
        <div className="overview-child-head"><StatusDot live status={needs ? 'needs-input' : settled ? 'idle' : child.status} /><IconAgent agent={child.detected_agent ?? child.agent} className="w-3.5 h-3.5 flex-none" /><strong>{child.delegation?.role ?? child.title}</strong><span className="font-mono text-[var(--text-faint)]">{sessionIdentity(child)}</span><span className="overview-state">{childStateWord(child)}</span><span className="age">{delegationAge(child.delegation?.started_at ?? now, child.delegation?.settled_at ?? now)}</span></div>
        <div className="overview-task">{child.title}</div>
        <CheckoutChips child={child} parent={parent} shared={shared} count={counts.get(child.project_dir)} />
        <div className="overview-actions">{cardAction('Select', IconEye, () => selectOverviewChild(parentId, child.id))}{cardAction('Review changes', IconGitBranch, () => onReview(child))}{settled ? cardAction('Continue', IconRespawn, () => client.respawnSession(child.id, undefined, null, undefined, undefined, false)) : cardAction('Stop', IconStopCircle, () => client.closeSession(child.id))}</div>
        <div className="overview-result"><span>{childResultExcerpt(child, result, needs)}</span>{needs && <button className={`btn border ${BTN_PRIMARY}`} onClick={() => selectOverviewChild(parentId, child.id)}>Answer</button>}</div>
      </article>
}

function childResultExcerpt(child: SessionInfo, result: InboxRow | undefined, needs: boolean): string {
  return result?.summary || result?.body || (needs ? child.delegation?.hold_reason : null) || 'No result excerpt available'
}
