import { OverviewButton } from './ui/OverviewButtonRoles'
import { useSession, useSessionsSelector, shallowArrayEqual } from '../sessionsStore'
import { Icon } from './ui/Icon'
import { Tooltip } from './ui/Tooltip'
import { Suspense, useEffect, useState } from 'react'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { isLive } from '../houston/client'
import type { DelegationResult } from '../houston/generated/DelegationResult'
import type { InboxRow } from '../houston/generated/InboxRow'
import { selectOverviewChild } from '../sidePanel'
import { ChildStatusDot, childGroup, childStateWord, DelegationAge } from './ChildrenRoster'
import { pendingDeliveryStatus, sessionIdentity } from './DelegationCard'
import { IconEye, IconGitBranch, IconStopCircle, IconRespawn, IconCornerDownRight } from './icons'
import { StatusDot } from './SessionPane'
import { Button, RosterOverview } from './ui'
import { StatusLabel } from './ui/StatusLabel'
import { OrchestratorActionDock, OrchestratorActionRow, OrchestratorAgentIcon, OrchestratorAge, OrchestratorBranch, OrchestratorChildCard, OrchestratorChildHeader, OrchestratorChildList, OrchestratorChildState, OrchestratorChildTitle, OrchestratorCount, OrchestratorGroupToggle, OrchestratorHeader, OrchestratorIdentity, OrchestratorInlineAction, OrchestratorMetadata, OrchestratorProgress, OrchestratorProgressSegment, OrchestratorResult, OrchestratorSectionLabel, OrchestratorSummary, OrchestratorTask, OrchestratorStatusDot, OrchestratorTitle } from './ui/OrchestratorOverview'
import { Text } from './ui/Text'

export function OverviewTab({ parentId, sessions, client, onClose, onReview }: {
  parentId: number
  sessions: ReadonlyMap<number, SessionInfo>
  client: HoustonClient
  onClose: () => void
  onReview: (child: SessionInfo) => void
}): React.JSX.Element {
  const parent = useSession(parentId, sessions.get(parentId))
  const children = useSessionsSelector(
    (snapshot) => [...snapshot.values()].filter((child) => child.spawned_by === parentId),
    shallowArrayEqual,
    [...sessions.values()].filter((child) => child.spawned_by === parentId),
  )
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
  const action = (label: string, onClick: () => void, summary = false): React.JSX.Element => <OrchestratorInlineAction summary={summary} onClick={onClick}>{label}</OrchestratorInlineAction>
  return <RosterOverview>
    <OrchestratorHeader><StatusDot live={!!parent && isLive(parent.state)} status={parent?.status} />{parent && <OrchestratorAgentIcon agent={parent.detected_agent ?? parent.agent} />}<OrchestratorTitle>{parent?.title ?? `Orchestrator ${parentId}`}</OrchestratorTitle><OrchestratorIdentity>pane {parentId}</OrchestratorIdentity>{parent && <CompactionCount parent={parent} />}{action('Show terminal', () => selectOverviewChild(parentId, null))}</OrchestratorHeader>
    {(!parent || !isLive(parent.state)) && <OrchestratorSummary>Orchestrator ended.{action('Close', onClose, true)}</OrchestratorSummary>}
    <OrchestratorSummary><OrchestratorCount needsInput={children.some((child) => childGroup(child) === 'Needs you')}>{children.length}</OrchestratorCount><Text size="small" tone="muted" className="truncate">children · {children.filter((child) => childGroup(child) === 'Needs you').length} needs you · {children.filter((child) => childGroup(child) === 'Working').length} working · {done} done · {failed} failed</Text><span className="flex-1" /><OrchestratorGroupToggle value={groupBy} onChange={setGroupBy} /></OrchestratorSummary>
    <OrchestratorProgress>{(['Needs you', 'Working', 'Done', 'Failed'] as const).map((group) => <OrchestratorProgressSegment key={group} group={group} weight={group === 'Done' ? done : group === 'Failed' ? failed : children.filter((child) => childGroup(child) === group).length} />)}</OrchestratorProgress>
    <OrchestratorChildList>{ordered.map((child) => <OverviewChildCard key={child.id} child={child} parent={parent} parentId={parentId} children={children} result={results.find((result) => result.child === child.id)} counts={counts} client={client} onReview={onReview} />)}</OrchestratorChildList>
    {addressed.length > 0 && <section aria-label="Addressed to you"><OrchestratorSectionLabel>Addressed to you</OrchestratorSectionLabel>{addressed.map((row) => <OrchestratorChildCard key={String(row.id)}><OrchestratorTask>{row.summary || row.body}</OrchestratorTask><OrchestratorActionRow>{action('Acknowledge', () => client.inboxAck(row.id))}{action('Resolve', () => client.inboxResolve(row.id))}</OrchestratorActionRow></OrchestratorChildCard>)}</section>}
  </RosterOverview>
}

function CompactionCount({ parent }: { parent: SessionInfo }): React.JSX.Element | null {
  const agent = parent.detected_agent ?? parent.agent
  if (parent.compactions == null) {
    return agent === 'shell' || agent === 'custom' || agent === 'ssh' ? null : <Text size="small" tone="faint">compactions not reported by {agent}</Text>
  }
  return <Tooltip label="Context compactions the agent reported. Every third one, Houston offers this orchestrator a handoff to a new pane."><Text size="small" mono tone="faint">{parent.compactions} {parent.compactions === 1 ? 'compaction' : 'compactions'}</Text></Tooltip>
}

function CheckoutChips({ child, parent, shared, count }: { child: SessionInfo; parent?: SessionInfo; shared?: SessionInfo; count?: number }): React.JSX.Element {
  const separate = child.project_dir !== parent?.project_dir
  const checkout = child.worktree?.branch
  return <OrchestratorMetadata>{separate && <span>{child.project_dir}</span>}{checkout && <OrchestratorBranch><Icon glyph={IconGitBranch} role="label" />{checkout}</OrchestratorBranch>}{shared && <span>shares checkout with {shared.delegation?.role ?? sessionIdentity(shared)}</span>}{child.worktree && count !== undefined && <span>{count} changed files</span>}</OrchestratorMetadata>
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
  const cardAction = (label: string, glyph: typeof IconEye, onClick: () => void): React.JSX.Element => <Tooltip label={label}><Button variant="legacy-icon" aria-label={label} onClick={onClick}><Icon glyph={glyph} role="label" /></Button></Tooltip>
      const needs = childGroup(child) === 'Needs you'
      const settled = childGroup(child) === 'Settled'
      const deliveryStatus = pendingDeliveryStatus(child.delegation)

      const shared = isLive(child.state) ? children.find((other) => other.id !== child.id && isLive(other.state) && child.checkout_root != null && other.checkout_root === child.checkout_root) : undefined
      return <OrchestratorChildCard key={child.id} needsInput={needs}>
        <OverviewChildHead child={child} needs={needs} settled={settled} />
        <OrchestratorTask>{child.title}</OrchestratorTask>
        <CheckoutChips child={child} parent={parent} shared={shared} count={counts.get(child.worktree?.path ?? child.project_dir)} />
        <OrchestratorActionDock>{cardAction('Select', IconEye, () => selectOverviewChild(parentId, child.id))}{cardAction('Review changes', IconGitBranch, () => onReview(child))}{settled ? cardAction('Continue', IconRespawn, () => client.respawnSession(child.id, undefined, null, undefined, undefined, false)) : cardAction('Stop', IconStopCircle, () => client.closeSession(child.id))}</OrchestratorActionDock>
        {deliveryStatus != null && <StatusLabel status={deliveryStatus} />}
        <OrchestratorResult>{needs && <Icon glyph={IconCornerDownRight} role="label" />}<Text tone="muted">{childResultExcerpt(child, result, needs)}</Text>{needs && <OverviewButton onClick={() => selectOverviewChild(parentId, child.id)}>Answer</OverviewButton>}</OrchestratorResult>
      </OrchestratorChildCard>
}

function childResultExcerpt(child: SessionInfo, result: DelegationResult | undefined, needs: boolean): string {
  return (needs ? child.delegation?.hold_reason : null) || result?.excerpt || result?.summary || child.delegation?.hold_reason || 'no result yet'
}


function OverviewChildHead({ child, needs, settled }: { child: SessionInfo; needs: boolean; settled: boolean }): React.JSX.Element {
  const childState = childStateWord(child)
  const state = needs ? 'needs_input' : childState === 'working' ? 'working' : childState === 'done' ? 'done' : childState === 'failed' ? 'failed' : 'other'
  return <OrchestratorChildHeader><OrchestratorStatusDot state={settled ? child.delegation?.state === 'done' ? 'done' : child.delegation?.state === 'failed' ? 'failed' : undefined : undefined}><ChildStatusDot info={child} /></OrchestratorStatusDot><OrchestratorAgentIcon agent={child.detected_agent ?? child.agent} /><OrchestratorChildTitle>{child.delegation?.role ?? child.title}</OrchestratorChildTitle><OrchestratorIdentity size="xs">{sessionIdentity(child)}</OrchestratorIdentity><OrchestratorChildState state={state}>{needs ? 'Needs you' : childStateWord(child).replace(/^./, (letter) => letter.toUpperCase())}</OrchestratorChildState><OrchestratorAge><Suspense fallback={null}><DelegationAge start={child.delegation?.started_at ?? Date.now()} end={child.delegation?.settled_at} ticking={!settled && child.delegation?.settled_at == null} /></Suspense></OrchestratorAge></OrchestratorChildHeader>
}
