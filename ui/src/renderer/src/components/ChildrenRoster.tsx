import { useSession, useSessionFamily, useSessionsSelector, shallowArrayEqual } from '../sessionsStore'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { openSideOverview } from '../sidePanel'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { isLive } from '../houston/client'
import { HeaderDelegationBadge, needsHumanInput, pendingDeliveryStatus, stateWord, type PaneRoster } from './DelegationCard'
import { StatusDot } from './SessionPane'
import { IconAgent, IconClose, IconArrowUpRight, IconEye, IconSearch, IconStopCircle, IconChevronLeft, IconChevronRight, IconUndo, IconGrid } from './icons'
import { Icon } from './ui/Icon'
import { Text } from './ui/Text'
import { Tooltip } from './ui/Tooltip'
import { Segmented } from './ui/SegmentedControl'
import {
  RosterActions,
  RosterColumn,
  RosterCount,
  RosterDetail,
  RosterFooter,
  RosterFooterButton,
  RosterGlyphButton,
  RosterGroupHead,
  RosterGroupToggle,
  RosterHead,
  RosterIconButton,
  RosterList,
  RosterRow,
  RosterRule,
  RosterSlot,
  RosterState,
  RosterStatus,
  RosterStrip
} from './ui'
import { StatusLabel } from './ui/StatusLabel'
import { ChildContextMenu } from './ChildContextMenu'

// The queue view and the task chip carry the backlog helpers; both load on
// demand so the Tasks modules stay off the boot path.
const RosterQueue = lazy(() => import('./tasks/RosterQueue').then((module) => ({ default: module.RosterQueue })))
const TaskChip = lazy(() => import('./tasks/TaskChip').then((module) => ({ default: module.TaskChip })))
export const DelegationAge = lazy(() => import('./ageTicker').then((module) => ({ default: module.AgeLabel })))

/// The Queue segment's ready count: a snapshot subscription light enough for
/// boot, so the segment is honest before the view (and its full hook) loads.
function useTaskReadyCount(client: HoustonClient, workspace: string, enabled: boolean): number {
  const [ready, setReady] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const off = client.subscribe('task_snapshot', (msg) => {
      if (msg.scope === workspace) setReady(msg.counts.ready)
    })
    client.taskSnapshot(workspace)
    return off
  }, [client, workspace, enabled])
  return ready
}

// Three warm children bound terminal memory while keeping recent switches instant.
export const PEEK_KEEP_MOUNTED = 3
// Delay destruction so Undo can preserve the original PTYs.
export const CLOSE_SETTLED_UNDO_MS = 5000

export function childGroup(info: SessionInfo): 'Needs you' | 'Working' | 'Settled' {
  if (!isLive(info.state)) return 'Settled'
  if (needsHumanInput(info)) return 'Needs you'
  return 'Working'
}

export function childStateWord(info: SessionInfo): string {
  if (childGroup(info) === 'Needs you') return 'needs input'
  if (isLive(info.state) && info.delegation?.state === 'unknown') return info.status ?? 'working'
  return info.delegation ? stateWord(info.delegation) : childGroup(info) === 'Settled' ? 'done' : info.status ?? 'working'
}

const ageTicks = (info: SessionInfo): boolean => isLive(info.state) && info.delegation?.settled_at == null

// A missing provider signal is named, so an absent badge is not read as proof of work.
export const glyphLabel = (info: SessionInfo) => [info.delegation?.role ?? info.title, childGroup(info), info.delegation?.capability_note].filter(Boolean).join(' · ')

export function delegationAge(start: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - start) / 1000))
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`
}

export function ChildStatusDot({ info }: { info: SessionInfo }): React.JSX.Element {
  if (!isLive(info.state)) {
    const status = info.delegation?.state === 'done' ? 'Done' : info.delegation?.state === 'failed' ? 'Failed' : 'Ended'
    return <Tooltip label="Ended"><StatusLabel status={status} variant="dot" /></Tooltip>
  }
  const state = childStateWord(info)
  if (state === 'done' || state === 'failed' || state === 'stalled') {
    const status = state === 'done' ? 'Done' : state === 'failed' ? 'Failed' : 'Stalled'
    return <Tooltip label={status}><StatusLabel status={status} variant="dot" /></Tooltip>
  }
  return <StatusDot live status={childGroup(info) === 'Needs you' ? 'needs-input' : info.status ?? 'working'} />
}

function ChildDeliveryStatus({ info }: { info: SessionInfo }): React.JSX.Element | null {
  const status = pendingDeliveryStatus(info.delegation)
  return status == null ? null : <RosterDetail><StatusLabel status={status} /></RosterDetail>
}

export function ChildrenRoster({ parent: parentProp, children: childrenProp, roster: rosterProp, client, selected, onSelect, onMove, collapsed, onCollapse, defaultView = 'children' }: {
  parent: SessionInfo
  children: SessionInfo[]
  roster?: PaneRoster
  client: HoustonClient
  selected: number | null
  onSelect: (id: number | null) => void
  onMove: (id: number) => void
  collapsed: boolean
  onCollapse: () => void
  /// Which segment starts selected; the harness stories open the queue with it.
  defaultView?: 'children' | 'queue'
}): React.JSX.Element {
  const parent = useSession(parentProp.id, parentProp) ?? parentProp
  const children = useSessionsSelector(
    (sessions) => [...sessions.values()].filter((child) => child.spawned_by === parent.id).sort((a, b) => a.id - b.id),
    shallowArrayEqual,
    childrenProp,
  )
  const fallbackRoster = useMemo(() => rosterProp?.sessions ?? new Map([parentProp, ...childrenProp].map((session) => [session.id, session])), [rosterProp?.sessions, parentProp, childrenProp])
  const family = useSessionFamily(parent.id, fallbackRoster)
  const roster = rosterProp ? { ...rosterProp, sessions: family } : undefined
  const [filter, setFilter] = useState(false)
  const [pending, setPending] = useState<number[]>([])
  const [contextMenu, setContextMenu] = useState<{ child: SessionInfo; x: number; y: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const latest = useRef(children)
  latest.current = children
  useEffect(() => () => clearTimeout(timer.current), [])
  const settled = children.filter((child) => childGroup(child) === 'Settled')
  const closeSettled = (): void => {
    const ids = latest.current.filter((child) => childGroup(child) === 'Settled').map((child) => child.id)
    if (!ids.length) return
    setPending(ids)
    timer.current = setTimeout(() => {
      for (const id of ids) {
        const child = latest.current.find((item) => item.id === id)
        if (child && childGroup(child) === 'Settled') client.closeSession(id)
      }
      setPending([])
      timer.current = undefined
    }, CLOSE_SETTLED_UNDO_MS)
  }
  const undoClose = (): void => {
    clearTimeout(timer.current)
    timer.current = undefined
    setPending([])
  }
  // The toggle lives on the Needs you heading, so it must not outlast that group.
  if (filter && !children.some((child) => childGroup(child) === 'Needs you')) setFilter(false)
  const grouped = ['Needs you', 'Working', 'Settled'] as const
  const ordered = grouped.flatMap((group) => children.filter((child) => childGroup(child) === group).sort((a, b) => group === 'Settled' ? Number(a.delegation?.state === 'failed') - Number(b.delegation?.state === 'failed') : 0))
  const [view, setView] = useState<'children' | 'queue'>(defaultView)
  const ready = useTaskReadyCount(client, parent.project_dir, !collapsed)
  const liveCount = children.length - settled.length
  const cap = roster?.maxLiveChildren ?? null
  const dot = (child: SessionInfo): React.JSX.Element => <ChildStatusDot info={child} />
  const glyph = (child: SessionInfo): React.JSX.Element => <IconAgent brand agent={child.detected_agent ?? child.agent} className="w-3.5 h-3.5 flex-none" />
  const openChildMenu = (child: SessionInfo, event: React.MouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({ child, x: event.clientX, y: event.clientY })
  }
  const dismissChildMenu = (): void => setContextMenu(null)
  const strip = <RosterStrip aria-label="Children strip">
    <Tooltip label="Orchestrator"><RosterGlyphButton aria-label="Orchestrator" aria-pressed={selected == null} onClick={() => onSelect(null)}>{glyph(parent)}{dot(parent)}</RosterGlyphButton></Tooltip>
    <RosterRule />
    {ordered.map((child) => <Tooltip key={child.id} label={glyphLabel(child)}><RosterGlyphButton aria-label={`Open ${child.delegation?.role ?? child.title}`} aria-pressed={selected === child.id} onClick={() => onSelect(child.id)} onContextMenu={(event) => openChildMenu(child, event)}>{glyph(child)}<RosterStatus state={isLive(child.state) ? undefined : child.delegation?.state}>{dot(child)}</RosterStatus></RosterGlyphButton></Tooltip>)}
    {pending.length > 0 && <Tooltip label={`Undo closing ${pending.length} children`}><RosterIconButton aria-label="Undo closing settled children" onClick={undoClose}><Icon glyph={IconUndo} role="ui" /></RosterIconButton></Tooltip>}
    <Tooltip label="Show children"><RosterIconButton pushEnd aria-label="Show children" onClick={onCollapse}><Icon glyph={IconChevronRight} role="ui" /></RosterIconButton></Tooltip>
  </RosterStrip>
  return <>
    {!collapsed && <RosterColumn aria-label="Children roster">
      <RosterHead>
        <Segmented<'children' | 'queue'>
          aria-label="Roster view"
          value={view}
          options={[
            { value: 'children', label: `Children ${children.length}`, testId: 'roster-view-children' },
            { value: 'queue', label: `Queue ${ready}`, testId: 'roster-view-queue' }
          ]}
          onChange={setView}
        />
        <span className="flex-1" />
        <Tooltip label="Collapse children"><RosterIconButton aria-label="Collapse children" onClick={onCollapse}><Icon glyph={IconChevronLeft} role="ui" /></RosterIconButton></Tooltip>
      </RosterHead>
      {view === 'queue' ? (
        <Suspense fallback={null}>
          <RosterQueue
            client={client}
            workspace={parent.project_dir}
            parentId={parent.id}
            live={liveCount}
            settled={settled.length}
            cap={cap}
          />
        </Suspense>
      ) : (
      <RosterList>
        <RosterRow selected={selected == null} settled={false}>
          <HeaderDelegationBadge rosterRow kind="orchestrator" info={parent} roster={roster} onSelect={() => onSelect(null)} onFocusPane={(id) => onSelect(id === parent.id ? null : id)}>{dot(parent)}{glyph(parent)}<Text as="strong" size="rosterName" weight="semibold">Orchestrator</Text></HeaderDelegationBadge><RosterCount>pane {parent.id}</RosterCount>
        </RosterRow>
        {grouped.map((group) => {
          const items = ordered.filter((child) => childGroup(child) === group && (!filter || group === 'Needs you'))
          return items.length > 0 && <div key={group}>
            <RosterGroupHead><span>{group}</span>{group === 'Needs you' && <RosterGroupToggle aria-pressed={filter} onClick={() => setFilter(!filter)}><Icon glyph={IconSearch} role="small" />Show only</RosterGroupToggle>}<span>{items.length}</span></RosterGroupHead>
            {items.map((child) => <RosterRow key={child.id} settled={group === 'Settled'} selected={selected === child.id} onContextMenu={(event) => openChildMenu(child, event)}>
              <HeaderDelegationBadge rosterRow kind="origin" info={child} roster={roster} onSelect={() => onSelect(child.id)} onFocusPane={onSelect} onDeliverNow={(id) => client.inboxDeliverNow(id)}><RosterStatus state={isLive(child.state) ? undefined : child.delegation?.state}>{dot(child)}</RosterStatus>{glyph(child)}<Text as="strong" size="rosterName" weight="semibold">{child.delegation?.role ?? child.title}</Text>{child.task != null && <Suspense fallback={null}><TaskChip task={child.task} compact /></Suspense>}</HeaderDelegationBadge>
              <RosterSlot><RosterState><Suspense fallback={delegationAge(child.delegation?.started_at ?? Date.now(), child.delegation?.settled_at ?? Date.now())}><DelegationAge start={child.delegation?.started_at ?? Date.now()} end={child.delegation?.settled_at} ticking={ageTicks(child)} /></Suspense></RosterState>
                <RosterActions>
                  {childGroup(child) === 'Needs you' && <Tooltip label="Answer"><RosterIconButton aria-label={`Answer ${child.id}`} onClick={() => onSelect(child.id)}><Icon glyph={IconEye} role="ui" /></RosterIconButton></Tooltip>}
                  <Tooltip label="Open"><RosterIconButton aria-label={`Open ${child.id}`} onClick={() => onSelect(child.id)}><Icon glyph={IconEye} role="ui" /></RosterIconButton></Tooltip>
                  <Tooltip label="Move to grid"><RosterIconButton aria-label={`Move ${child.id} to grid`} onClick={() => onMove(child.id)}><Icon glyph={IconArrowUpRight} role="ui" /></RosterIconButton></Tooltip>
                  <Tooltip label={isLive(child.state) ? "Stop" : "Close"}><RosterIconButton aria-label={`${isLive(child.state) ? "Stop" : "Close"} ${child.id}`} onClick={() => client.closeSession(child.id)}><Icon glyph={isLive(child.state) ? IconStopCircle : IconClose} role="ui" /></RosterIconButton></Tooltip>
                </RosterActions>
              </RosterSlot>
              <RosterDetail><span className="truncate">{child.title}</span></RosterDetail>
              <ChildDeliveryStatus info={child} />
            </RosterRow>)}
          </div>
        })}
      </RosterList>
      )}
      <RosterFooter>
        {pending.length > 0 ? <><span className="truncate">Closing {pending.length}</span><RosterFooterButton onClick={undoClose}>Undo</RosterFooterButton></> : <RosterFooterButton disabled={!settled.length} onClick={closeSettled}>Close settled ({settled.length})</RosterFooterButton>}
        <RosterFooterButton onClick={() => openSideOverview(parent.id)}><Icon glyph={IconGrid} role="label" />Overview</RosterFooterButton>
      </RosterFooter>
    </RosterColumn>}
    {strip}
    {contextMenu && <ChildContextMenu child={contextMenu.child} needsInput={childGroup(contextMenu.child) === 'Needs you'} parentId={parent.id} client={client} x={contextMenu.x} y={contextMenu.y} onClose={dismissChildMenu} onOpen={() => onSelect(contextMenu.child.id)} onMove={() => onMove(contextMenu.child.id)} />}
  </>
}
