import { useEffect, useRef, useState } from 'react'
import { openSideOverview } from '../sidePanel'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { isLive } from '../houston/client'
import { HeaderDelegationBadge, stateWord, type PaneRoster } from './DelegationCard'
import { StatusDot } from './SessionPane'
import { IconAgent, IconArrowUpRight, IconEye, IconSearch, IconStopCircle, IconChevronLeft, IconChevronRight, IconUndo } from './icons'
import { Icon } from './Icon'
import { Tooltip } from './Tooltip'
import { BTN_GHOST, BTN_ICO } from './buttonChrome'
import { CONTROL_SIZE_SQUARE_CLS } from './controlSize'
import { MATERIAL_CLS } from './material'

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

export function delegationAge(start: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - start) / 1000))
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`
}

export function ChildrenRoster({ parent, children, roster, client, selected, onSelect, onMove, collapsed, onCollapse }: {
  parent: SessionInfo
  children: SessionInfo[]
  roster?: PaneRoster
  client: HoustonClient
  selected: number | null
  onSelect: (id: number | null) => void
  onMove: (id: number) => void
  collapsed: boolean
  onCollapse: () => void
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
  const dot = (child: SessionInfo): React.JSX.Element => <StatusDot live status={child.children_waiting > 0 || childGroup(child) === 'Needs you' ? 'needs-input' : childGroup(child) === 'Settled' ? 'idle' : child.status ?? 'working'} />
  const glyph = (child: SessionInfo): React.JSX.Element => <IconAgent agent={child.detected_agent ?? child.agent} className="w-3.5 h-3.5 flex-none" />
  const strip = <aside aria-label="Children strip" className={`children-strip ${MATERIAL_CLS.shell}`}>
    <Tooltip label="Orchestrator"><button className={`${ROSTER_ICON} children-glyph`} aria-label="Orchestrator" aria-pressed={selected == null} onClick={() => onSelect(null)}>{glyph(parent)}{dot(parent)}</button></Tooltip>
    <span className="children-rule" />
    {ordered.map((child) => <Tooltip key={child.id} label={`${child.delegation?.role ?? child.title} · ${childGroup(child)}`}><button className={`${ROSTER_ICON} children-glyph`} aria-label={`Open ${child.delegation?.role ?? child.title}`} aria-pressed={selected === child.id} onClick={() => onSelect(child.id)}>{glyph(child)}<span className="children-status" data-state={isLive(child.state) ? undefined : child.delegation?.state}>{dot(child)}</span></button></Tooltip>)}
    {pending.length > 0 && <Tooltip label={`Undo closing ${pending.length} children`}><button className={ROSTER_ICON} aria-label="Undo closing settled children" onClick={undoClose}><Icon glyph={IconUndo} role="ui" /></button></Tooltip>}
    <Tooltip label="Show children"><button className={`${ROSTER_ICON} mt-auto`} aria-label="Show children" onClick={onCollapse}><Icon glyph={IconChevronRight} role="ui" /></button></Tooltip>
  </aside>
  return <>
    {!collapsed && <aside aria-label="Children roster" className={`children-column ${MATERIAL_CLS.shell}`}>
      <div className="children-head"><span>Children</span><span className="children-count">{children.length}</span><span className="flex-1" />
        <Tooltip label="Filter to needs you"><button className={ROSTER_ICON} aria-label="Filter children" aria-pressed={filter} onClick={() => setFilter(!filter)}><Icon glyph={IconSearch} role="ui" /></button></Tooltip>
        <Tooltip label="Collapse children"><button className={ROSTER_ICON} aria-label="Collapse children" onClick={onCollapse}><Icon glyph={IconChevronLeft} role="ui" /></button></Tooltip>
      </div>
      <div className="children-list">
        <div className={`children-row ${selected == null ? 'selected' : ''}`}>
          <HeaderDelegationBadge className="children-open" kind="orchestrator" info={parent} roster={roster} onSelect={() => onSelect(null)} onFocusPane={(id) => onSelect(id === parent.id ? null : id)}>{dot(parent)}{glyph(parent)}<strong>Orchestrator</strong></HeaderDelegationBadge><span className="children-count">pane {parent.id}</span>
        </div>
        {grouped.map((group) => {
          const items = ordered.filter((child) => childGroup(child) === group && (!filter || group === 'Needs you'))
          return items.length > 0 && <div key={group}>
            <div className="children-group"><span>{group}</span><span>{items.length}</span></div>
            {items.map((child) => <div key={child.id} className={`children-row ${group === 'Settled' ? 'settled' : ''} ${selected === child.id ? 'selected' : ''}`}>
              <HeaderDelegationBadge className="children-open" kind="origin" info={child} roster={roster} onSelect={() => onSelect(child.id)} onFocusPane={onSelect} onDeliverNow={(id) => client.inboxDeliverNow(id)}><span className="children-status" data-state={isLive(child.state) ? undefined : child.delegation?.state}>{dot(child)}</span>{glyph(child)}<strong>{child.delegation?.role ?? child.title}</strong></HeaderDelegationBadge>
              <span className="children-slot"><span className="children-state">{delegationAge(child.delegation?.started_at ?? now, child.delegation?.settled_at ?? now)}</span>
                <span className="children-actions">
                  {childGroup(child) === 'Needs you' && <Tooltip label="Answer"><button className={ROSTER_ICON} aria-label={`Answer ${child.id}`} onClick={() => onSelect(child.id)}><Icon glyph={IconEye} role="ui" /></button></Tooltip>}
                  <Tooltip label="Open"><button className={ROSTER_ICON} aria-label={`Open ${child.id}`} onClick={() => onSelect(child.id)}><Icon glyph={IconEye} role="ui" /></button></Tooltip>
                  <Tooltip label="Move to grid"><button className={ROSTER_ICON} aria-label={`Move ${child.id} to grid`} onClick={() => onMove(child.id)}><Icon glyph={IconArrowUpRight} role="ui" /></button></Tooltip>
                  <Tooltip label="Stop"><button className={ROSTER_ICON} aria-label={`Stop ${child.id}`} onClick={() => client.closeSession(child.id)}><Icon glyph={IconStopCircle} role="ui" /></button></Tooltip>
                </span>
              </span>
              <div className="children-detail"><span className="truncate">{child.title}</span></div>
            </div>)}
          </div>
        })}
      </div>
      <footer className="children-footer">
        {pending.length > 0 ? <><span className="truncate">Closing {pending.length}</span><button className={`${BTN_GHOST} btn min-h-[var(--h-ctl)]`} onClick={undoClose}>Undo</button></> : <button className={`${BTN_GHOST} btn min-h-[var(--h-ctl)]`} disabled={!settled.length} onClick={closeSettled}>Close settled ({settled.length})</button>}
        <button className={`${BTN_GHOST} btn min-h-[var(--h-ctl)]`} onClick={() => openSideOverview(parent.id)}>Overview</button>
      </footer>
    </aside>}
    {strip}
  </>
}
