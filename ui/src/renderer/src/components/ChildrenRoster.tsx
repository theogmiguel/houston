import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { openSideOverview } from '../sidePanel'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { isLive } from '../houston/client'
import { HeaderDelegationBadge, stateWord, type PaneRoster } from './DelegationCard'
import { StatusDot } from './SessionPane'
import { IconAgent, IconClose, IconArrowUpRight, IconEye, IconSearch, IconStopCircle, IconChevronLeft, IconChevronRight, IconUndo, IconGrid } from './icons'
import { Icon } from './Icon'
import { Tooltip } from './Tooltip'
import { BTN_GHOST, BTN_ICO } from './buttonChrome'
import { CONTROL_SIZE_SQUARE_CLS } from './controlSize'
import { MATERIAL_CLS } from './material'
import { Segmented } from './Segmented'

// The queue view and the task chip carry the backlog helpers; both load on
// demand so the Tasks modules stay off the boot path.
const RosterQueue = lazy(() => import('./tasks/RosterQueue').then((module) => ({ default: module.RosterQueue })))
const TaskChip = lazy(() => import('./tasks/TaskChip').then((module) => ({ default: module.TaskChip })))

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

const ROSTER_ICON = `${BTN_ICO} ${CONTROL_SIZE_SQUARE_CLS.regular}`

export function childGroup(info: SessionInfo): 'Needs you' | 'Working' | 'Settled' {
  if (!isLive(info.state)) return 'Settled'
  if (info.status === 'needs-input' || info.delegation?.stalled || info.delegation?.state === 'needs_input') return 'Needs you'
  return 'Working'
}

export function childStateWord(info: SessionInfo): string {
  if (isLive(info.state) && ['done', 'failed', 'unknown'].includes(info.delegation?.state ?? '')) return info.status ?? 'working'
  return info.delegation ? stateWord(info.delegation) : childGroup(info) === 'Settled' ? 'done' : info.status ?? 'working'
}

// A missing provider signal is named, so an absent badge is not read as proof of work.
export const glyphLabel = (info: SessionInfo) => [info.delegation?.role ?? info.title, childGroup(info), info.delegation?.capability_note].filter(Boolean).join(' · ')

export function delegationAge(start: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - start) / 1000))
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`
}

export function ChildStatusDot({ info }: { info: SessionInfo }): React.JSX.Element {
  if (!isLive(info.state)) return <Tooltip label="Ended"><span className="w-[7px] h-[7px] rounded-full flex-none bg-[var(--info)]" role="img" aria-label="Ended" /></Tooltip>
  return <StatusDot live status={info.children_waiting > 0 || childGroup(info) === 'Needs you' ? 'needs-input' : info.status ?? 'working'} />
}

export function ChildrenRoster({ parent, children, roster, client, selected, onSelect, onMove, collapsed, onCollapse, defaultView = 'children' }: {
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
  const [filter, setFilter] = useState(false)
  const [pending, setPending] = useState<number[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const latest = useRef(children)
  latest.current = children
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    // Ages only need second resolution, independent of terminal rendering.
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [])
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
  const grouped = ['Needs you', 'Working', 'Settled'] as const
  const ordered = grouped.flatMap((group) => children.filter((child) => childGroup(child) === group).sort((a, b) => group === 'Settled' ? Number(a.delegation?.state === 'failed') - Number(b.delegation?.state === 'failed') : 0))
  const [view, setView] = useState<'children' | 'queue'>(defaultView)
  const ready = useTaskReadyCount(client, parent.project_dir, !collapsed)
  const liveCount = children.length - settled.length
  const cap = roster?.maxLiveChildren ?? null
  const dot = (child: SessionInfo): React.JSX.Element => <ChildStatusDot info={child} />
  const glyph = (child: SessionInfo): React.JSX.Element => <IconAgent brand agent={child.detected_agent ?? child.agent} className="w-3.5 h-3.5 flex-none" />
  const strip = <aside aria-label="Children strip" className={`children-strip ${MATERIAL_CLS.shell}`}>
    <Tooltip label="Orchestrator"><button className={`${ROSTER_ICON} children-glyph`} aria-label="Orchestrator" aria-pressed={selected == null} onClick={() => onSelect(null)}>{glyph(parent)}{dot(parent)}</button></Tooltip>
    <span className="children-rule" />
    {ordered.map((child) => <Tooltip key={child.id} label={glyphLabel(child)}><button className={`${ROSTER_ICON} children-glyph`} aria-label={`Open ${child.delegation?.role ?? child.title}`} aria-pressed={selected === child.id} onClick={() => onSelect(child.id)}>{glyph(child)}<span className="children-status" data-state={isLive(child.state) ? undefined : child.delegation?.state}>{dot(child)}</span></button></Tooltip>)}
    {pending.length > 0 && <Tooltip label={`Undo closing ${pending.length} children`}><button className={ROSTER_ICON} aria-label="Undo closing settled children" onClick={undoClose}><Icon glyph={IconUndo} role="ui" /></button></Tooltip>}
    <Tooltip label="Show children"><button className={`${ROSTER_ICON} mt-auto`} aria-label="Show children" onClick={onCollapse}><Icon glyph={IconChevronRight} role="ui" /></button></Tooltip>
  </aside>
  return <>
    {!collapsed && <aside aria-label="Children roster" className={`children-column ${MATERIAL_CLS.shell}`}>
      <div className="children-head">
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
        {view === 'children' && <Tooltip label="Filter to needs you"><button className={ROSTER_ICON} aria-label="Filter children" aria-pressed={filter} onClick={() => setFilter(!filter)}><Icon glyph={IconSearch} role="ui" /></button></Tooltip>}
        <Tooltip label="Collapse children"><button className={ROSTER_ICON} aria-label="Collapse children" onClick={onCollapse}><Icon glyph={IconChevronLeft} role="ui" /></button></Tooltip>
      </div>
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
      <div className="children-list">
        <div className={`children-row ${selected == null ? 'selected' : ''}`}>
          <HeaderDelegationBadge className="children-open" kind="orchestrator" info={parent} roster={roster} onSelect={() => onSelect(null)} onFocusPane={(id) => onSelect(id === parent.id ? null : id)}>{dot(parent)}{glyph(parent)}<strong>Orchestrator</strong></HeaderDelegationBadge><span className="children-count">pane {parent.id}</span>
        </div>
        {grouped.map((group) => {
          const items = ordered.filter((child) => childGroup(child) === group && (!filter || group === 'Needs you'))
          return items.length > 0 && <div key={group}>
            <div className="children-group"><span>{group}</span><span>{items.length}</span></div>
            {items.map((child) => <div key={child.id} className={`children-row ${group === 'Settled' ? 'settled' : ''} ${selected === child.id ? 'selected' : ''}`}>
              <HeaderDelegationBadge className="children-open" kind="origin" info={child} roster={roster} onSelect={() => onSelect(child.id)} onFocusPane={onSelect} onDeliverNow={(id) => client.inboxDeliverNow(id)}><span className="children-status" data-state={isLive(child.state) ? undefined : child.delegation?.state}>{dot(child)}</span>{glyph(child)}<strong>{child.delegation?.role ?? child.title}</strong>{child.task != null && <Suspense fallback={null}><TaskChip task={child.task} compact /></Suspense>}</HeaderDelegationBadge>
              <span className="children-slot"><span className="children-state">{delegationAge(child.delegation?.started_at ?? now, child.delegation?.settled_at ?? now)}</span>
                <span className="children-actions">
                  {childGroup(child) === 'Needs you' && <Tooltip label="Answer"><button className={ROSTER_ICON} aria-label={`Answer ${child.id}`} onClick={() => onSelect(child.id)}><Icon glyph={IconEye} role="ui" /></button></Tooltip>}
                  <Tooltip label="Open"><button className={ROSTER_ICON} aria-label={`Open ${child.id}`} onClick={() => onSelect(child.id)}><Icon glyph={IconEye} role="ui" /></button></Tooltip>
                  <Tooltip label="Move to grid"><button className={ROSTER_ICON} aria-label={`Move ${child.id} to grid`} onClick={() => onMove(child.id)}><Icon glyph={IconArrowUpRight} role="ui" /></button></Tooltip>
                  <Tooltip label={isLive(child.state) ? "Stop" : "Close"}><button className={ROSTER_ICON} aria-label={`${isLive(child.state) ? "Stop" : "Close"} ${child.id}`} onClick={() => client.closeSession(child.id)}><Icon glyph={isLive(child.state) ? IconStopCircle : IconClose} role="ui" /></button></Tooltip>
                </span>
              </span>
              <div className="children-detail"><span className="truncate">{child.title}</span></div>
            </div>)}
          </div>
        })}
      </div>
      )}
      <footer className="children-footer">
        {pending.length > 0 ? <><span className="truncate">Closing {pending.length}</span><button className={`${BTN_GHOST} btn min-h-[var(--h-ctl)]`} onClick={undoClose}>Undo</button></> : <button className={`${BTN_GHOST} btn min-h-[var(--h-ctl)]`} disabled={!settled.length} onClick={closeSettled}>Close settled ({settled.length})</button>}
        <button className={`${BTN_GHOST} btn min-h-[var(--h-ctl)]`} onClick={() => openSideOverview(parent.id)}><Icon glyph={IconGrid} role="label" />Overview</button>
      </footer>
    </aside>}
    {strip}
  </>
}
