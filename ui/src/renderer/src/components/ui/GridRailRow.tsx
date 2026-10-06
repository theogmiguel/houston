import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { SessionInfo } from '../../houston/client'
import type { TagInfo } from '../../houston/generated/TagInfo'
import { Icon } from '../Icon'
import { IconClose, IconGrid } from '../icons'
import { formatRailDuration, gridStatus } from './railRows'
import type { GridStatusModel } from './railRows'

const GridRailRowDetails = lazy(() => import('./GridRailRowDetails').then((module) => ({ default: module.GridRailRowDetails })))

import { shallowArrayEqual, useSessionsSelector } from '../../sessionsStore'
import type { RailDiffTotals } from '../git/useRailGitFacts'
import type { RailPrState } from '../git/railPrCache'

export interface GridRailRowProps {
  name: string
  selected: boolean
  paneIds: number[]
  tags?: readonly TagInfo[]
  fallbackSessions: readonly SessionInfo[]
  branches: ReadonlyMap<number, string>
  diffByDir: ReadonlyMap<string, RailDiffTotals>
  prByDir: ReadonlyMap<string, RailPrState>
  width: number
  jumpNumber?: number
  onRemove?: () => void
  onSelect: () => void
  onContextMenu?: (event: React.MouseEvent) => void
  onOpenInspector: (paneId: number, tab: 'changes' | 'pull-request') => void
  onOpenExternal: (url: string) => void
}

function statusTone(kind: ReturnType<typeof gridStatus>['kind']): string {
  switch (kind) {
    case 'needs-input': return 'text-[var(--warn)]'
    case 'working': return 'text-[var(--info)]'
    case 'starting': return 'text-[var(--accent)]'
    case 'exited': return 'text-[var(--stop)]'
    case 'done': return 'text-[var(--ok)]'
    default: return 'text-[var(--text-faint)]'
  }
}

function duration(since: number | null): string | null {
  return formatRailDuration(since)
}

function statusLabelFor(model: GridStatusModel, age: string | null): string {
  if (model.kind === 'idle') return age ?? model.label
  const timed = ['working', 'needs-input', 'starting'].includes(model.kind)
  return `${model.label}${age && timed ? ` ${age}` : ''}`
}

export function GridRailRow({
  name, selected, paneIds, tags = [], fallbackSessions, branches, diffByDir, prByDir, width, jumpNumber,
  onSelect, onContextMenu, onOpenInspector, onOpenExternal, onRemove,
}: GridRailRowProps): React.JSX.Element {
  const [card, setCard] = useState<{ left: number; top: number } | null>(null)
  const [altHeld, setAltHeld] = useState(false)
  const [, tick] = useState(0)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const sessions = useSessionsSelector(
    (store) => paneIds.flatMap((id) => store.get(id) ?? []),
    shallowArrayEqual,
    fallbackSessions.filter((session) => paneIds.includes(session.id)),
  )
  const panes = sessions
  const aggregate = gridStatus(panes)
  const age = duration(aggregate.since)
  const statusLabel = statusLabelFor(aggregate, age)

  const openCard = (): void => {
    if (openTimer.current) clearTimeout(openTimer.current)
    if (closeTimer.current) clearTimeout(closeTimer.current)
    const rect = rowRef.current?.getBoundingClientRect()
    if (!rect) return
    openTimer.current = setTimeout(() => {
      const left = Math.min(rect.right + 12, window.innerWidth - 372)
      const top = Math.max(8, Math.min(rect.top, window.innerHeight - 260))
      setCard({ left, top })
    }, 260)
  }
  const scheduleClose = (): void => {
    if (openTimer.current) clearTimeout(openTimer.current)
    closeTimer.current = setTimeout(() => setCard(null), 90)
  }
  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    if (openTimer.current) clearTimeout(openTimer.current)
  }, [])
  useEffect(() => {
    const down = (event: KeyboardEvent): void => { if (event.key === 'Alt') setAltHeld(true) }
    const up = (event: KeyboardEvent): void => { if (event.key === 'Alt') setAltHeld(false) }
    const blur = (): void => setAltHeld(false)
    const timer = window.setInterval(() => tick((value) => value + 1), 60_000)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  return <>
    <div
      ref={rowRef}
      role="button"
      tabIndex={0}
      data-testid="grid-row"
      data-selected={selected ? 'true' : undefined}
      aria-current={selected ? 'true' : undefined}
      aria-label={`${name}, ${statusLabel}`}
      className={`rail-grid-row group relative flex min-h-[var(--h-row)] min-w-0 flex-col gap-[1px] rounded-[var(--tr-radius-sm)] px-[var(--space-2)] py-[var(--space-1)] pl-[var(--space-6)] [font-weight:var(--tr-text-ui-weight)] hover:bg-hover-fill hover:text-[var(--text-primary)] ${selected ? 'bg-selected-fill text-[var(--text-primary)]' : 'bg-transparent text-[var(--text-secondary)]'}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onSelect()
      }}
      onContextMenu={onContextMenu}
      onMouseEnter={openCard}
      onMouseLeave={scheduleClose}
    >
      <span className="flex h-[var(--h-ctl-mini)] min-w-0 items-center gap-[var(--space-2)]">
        <Icon glyph={IconGrid} role="small" className="flex-none text-[var(--text-faint)]" />
        <span data-testid="grid-name" className="min-w-0 flex-1 truncate">{name}</span>
        <span role="img" data-testid="grid-state-dot" data-state={aggregate.kind === 'exited' ? 'stopped' : aggregate.kind === 'starting' ? 'starting' : aggregate.kind} className={`inline-flex flex-none items-center gap-[var(--space-1)] whitespace-nowrap [font-size:var(--tr-text-label-size)] [font-variant-numeric:tabular-nums] ${onRemove ? 'group-hover:invisible' : ''} ${statusTone(aggregate.kind)}`} aria-label={aggregate.kind === 'unavailable' ? 'status unavailable' : statusLabel}>
          {aggregate.kind !== 'idle' && <span aria-hidden className="inline-block h-[6px] w-[6px] rounded-full bg-current" />}
          {statusLabel}
        </span>
        {jumpNumber != null && <span aria-hidden data-testid="rail-jump-number" className={`rail-jump absolute left-[var(--space-1)] top-1/2 -translate-y-1/2 font-mono text-[var(--accent)] ${altHeld ? '' : 'hidden'}`}>{jumpNumber}</span>}
        {onRemove && <button type="button" data-testid="grid-close" aria-label={`Remove ${name}`} className="absolute right-[var(--space-1)] top-1/2 hidden h-[var(--h-ctl-mini)] w-[var(--h-ctl-mini)] -translate-y-1/2 items-center justify-center rounded-[var(--tr-radius-sm)] bg-transparent text-[var(--text-muted)] hover:bg-[var(--card-hover)] hover:text-[var(--text-primary)] group-hover:flex" onClick={(event) => { event.stopPropagation(); onRemove() }}><Icon glyph={IconClose} role="small" /></button>}
      </span>
      <Suspense fallback={null}><GridRailRowDetails name={name} sessions={panes} paneIds={paneIds} tags={tags} branches={branches} diffByDir={diffByDir} prByDir={prByDir} width={width} card={card} closeTimer={closeTimer} scheduleClose={scheduleClose} onOpenInspector={onOpenInspector} onOpenExternal={onOpenExternal} /></Suspense>
    </div>
  </>
}
