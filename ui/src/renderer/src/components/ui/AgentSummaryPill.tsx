import { Icon } from './Icon'
import { IconChevronRight } from '../icons'
import type { RailAgentRow } from '../rail/railCardModel'
import { IconAgent } from '../icons'

const STATUS_ORDER = ['needs-input', 'working', 'idle', 'starting', 'unavailable', 'done'] as const

export function AgentSummaryPill({
  agents,
  expanded,
  onToggle,
}: {
  agents: readonly RailAgentRow[]
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const groups = STATUS_ORDER.flatMap((status) => {
    const rows = agents.filter(
      ({ session }) => session.status === status || (status === 'needs-input' && session.children_waiting > 0),
    )
    return rows.length ? [{ status, rows }] : []
  })
  const ungrouped = agents.filter(
    ({ session }) => !STATUS_ORDER.includes((session.status ?? 'idle') as (typeof STATUS_ORDER)[number]),
  )
  if (ungrouped.length) groups.push({ status: 'idle', rows: ungrouped })
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className="flex h-6 w-full min-w-0 items-center gap-[5px] rounded-[var(--tr-radius-xs)] border border-[var(--divider)] bg-hover-fill px-1
        text-[length:var(--tr-text-xs)] text-[var(--text-muted)] hover:bg-[var(--card-hover)]"
    >
      <span className="shrink-0">
        {expanded ? `${agents.length} agents` : `${agents.length} agents`}
      </span>
      {!expanded && (
        <span className="flex min-w-0 items-center gap-1 overflow-hidden">
          {groups.slice(0, 3).map(({ status, rows }) => (
            <span
              key={status}
              data-state={status}
              aria-label={`${rows.length} ${status} agents`}
              className="inline-flex items-center gap-[3px] rounded bg-[var(--rail-bg)] px-1 text-[var(--text-secondary)]"
            >
              <i
                className={`size-2.5 rounded-full ${status === 'working' ? 'animate-spin border border-[var(--info)] border-r-transparent bg-transparent' : ''} ${
                  status === 'working'
                    ? ''
                    : status === 'needs-input'
                      ? 'bg-[var(--warn)]'
                      : 'bg-[var(--text-faint)]'
                }`}
              />
              <span className="inline-flex items-center pl-0.5">
                {rows.slice(0, 2).map(({ session }, index) => <span key={session.id} className={`-ml-0.5 inline-flex size-3.5 items-center justify-center rounded-full border border-[var(--rail-bg)] bg-[var(--card-hover)] ${index === 0 ? 'ml-0' : ''}`}><IconAgent agent={session.agent} role="small" brand /></span>)}
              </span>
              {rows.length > 2 && <span>+{rows.length - 2}</span>}
            </span>
          ))}
        </span>
      )}
      <Icon
        glyph={IconChevronRight}
        role="small"
        className={`ml-auto flex-none transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
      />
    </button>
  )
}

export function AgentSummaryPillSpecimen(): React.JSX.Element {
  return (
    <div className="w-56">
      <button
        className="flex h-6 w-full items-center gap-1 rounded-[var(--tr-radius-xs)] bg-[var(--content-bg)] px-1.5
        text-[length:var(--tr-text-xs)] text-[var(--text-muted)]"
      >
        <span className="font-medium text-[var(--text-secondary)]">3 agents</span>
        <span className="rounded bg-[var(--rail-bg)] px-1">working 2</span>
        <span className="rounded bg-[var(--rail-bg)] px-1">needs input 1</span>
        <span className="ml-auto">›</span>
      </button>
    </div>
  )
}
