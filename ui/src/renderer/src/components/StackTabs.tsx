import type { SessionInfo } from '../houston/client'
import { isLive } from '../houston/client'
import type { PaneNode, PaneKey, StackNode } from '../layout/tree'
import { paneKey } from '../layout/tree'
import { useStackCapacity } from '../paneCaps'
import { StatusDot } from './SessionPane'
import { PANE_TYPES } from '../layout/paneTypes'
import { IconClose } from './icons'
import { Tooltip } from './Tooltip'
import { Icon } from './Icon'

function tabLabel(node: PaneNode, sessions: Map<number, SessionInfo>): string {
  if (node.kind === 'leaf') return sessions.get(node.session)?.title ?? 'Terminal'
  return PANE_TYPES.find((t) => t.kind === node.kind)?.label ?? node.kind
}

function tabNeedsInputInBackground(
  node: PaneNode,
  sessions: Map<number, SessionInfo>,
  isActiveTab: boolean
): boolean {
  if (isActiveTab || node.kind !== 'leaf') return false
  const info = sessions.get(node.session)
  return !!info && isLive(info.state) && info.status === 'needs-input'
}

interface Props {
  stack: StackNode
  displayedIndex: number
  sessions: Map<number, SessionInfo>
  onSelect: (key: PaneKey) => void
  onUnstack: (key: PaneKey) => void
}

export function StackTabs({
  stack,
  displayedIndex,
  sessions,
  onSelect,
  onUnstack
}: Props): React.JSX.Element {
  const cap = useStackCapacity()
  const full = stack.children.length >= cap
  return (
    <div
      data-testid="stack-tabs"
      className="stack-tabs flex items-stretch h-[var(--h-pill)] flex-none bg-[var(--card-bg)] border-b border-[var(--divider)] overflow-x-auto"
    >
      {stack.children.map((child, i) => {
        const key = paneKey(child)
        const active = i === displayedIndex
        const badge = tabNeedsInputInBackground(child, sessions, active)
        const info = child.kind === 'leaf' ? sessions.get(child.session) : undefined
        return (
          <div
            key={String(key)}
            data-testid="stack-tab"
            data-active={active}
            data-needs-input-badge={badge}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            onClick={() => onSelect(key)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onSelect(key)
            }}
            className={`group relative flex items-center gap-1 px-2 h-full [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] whitespace-nowrap cursor-pointer border-r border-[var(--divider)] [transition:background_0.12s_ease-out] ${
              active
                ? 'bg-[var(--content-bg)] text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)]'
            }`}
          >
            {info && <StatusDot status={info.status} live={isLive(info.state)} />}
            <span className="max-w-[110px] truncate">{tabLabel(child, sessions)}</span>
            {badge && (
              <Tooltip label="Needs your input — hidden behind this stack's active tab">
                <span
                  data-testid="stack-tab-badge"
                  aria-label="needs your input"
                  className="w-[6px] h-[6px] rounded-full flex-none bg-[var(--warn)]"
                />
              </Tooltip>
            )}
            <Tooltip label="Remove from stack">
              <button
                type="button"
                aria-label={`Remove ${tabLabel(child, sessions)} from stack`}
                className="border-0 bg-transparent opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-[var(--text-faint)] hover:text-[var(--text-primary)]"
                onClick={(e) => {
                  e.stopPropagation()
                  onUnstack(key)
                }}
              >
                <Icon glyph={IconClose} role="label" />
              </button>
            </Tooltip>
          </div>
        )
      })}
      {full && (
        <Tooltip label={`Stack is full (${stack.children.length}/${cap})`}>
          <span
            data-testid="stack-full-indicator"
            className="flex items-center px-2 [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] text-[var(--text-faint)] tabular-nums"
          >
            {stack.children.length}/{cap}
          </span>
        </Tooltip>
      )}
    </div>
  )
}
