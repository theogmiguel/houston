import { useSessionsSelector, shallowArrayEqual } from '../sessionsStore'
import type { SessionInfo } from '../houston/client'
import { isLive } from '../houston/client'
import type { PaneNode, PaneKey, StackNode } from '../layout/tree'
import { paneKey } from '../layout/tree'
import { useStackCapacity } from '../paneCaps'
import { StatusDot } from './SessionPane'
import { PANE_TYPES } from '../layout/paneTypes'
import { IconClose } from './icons'
import { Tooltip } from './ui/Tooltip'
import { Icon } from './ui/Icon'
import { StackTab, StackTabBadge, StackTabCapacity, StackTabClose, StackTabLabel, StackTabStrip } from './ui/StackTab'

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
  sessions: sessionsProp,
  onSelect,
  onUnstack
}: Props): React.JSX.Element {
  const members = useSessionsSelector(
    (sessions) => stack.children.flatMap((child) => child.kind === 'leaf' ? sessions.get(child.session) ?? [] : []),
    shallowArrayEqual,
    [...sessionsProp.values()],
  )
  const sessions = new Map(members.map((session) => [session.id, session]))
  const cap = useStackCapacity()
  const full = stack.children.length >= cap
  return (
    <StackTabStrip data-testid="stack-tabs">
      {stack.children.map((child, i) => {
        const key = paneKey(child)
        const active = i === displayedIndex
        const badge = tabNeedsInputInBackground(child, sessions, active)
        const info = child.kind === 'leaf' ? sessions.get(child.session) : undefined
        return (
          <StackTab
            key={String(key)}
            active={active}
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
          >
            {info && <StatusDot status={info.status} live={isLive(info.state)} />}
            <StackTabLabel>{tabLabel(child, sessions)}</StackTabLabel>
            {badge && (
              <Tooltip label="Needs your input — hidden behind this stack's active tab">
                <StackTabBadge data-testid="stack-tab-badge" aria-label="needs your input" />
              </Tooltip>
            )}
            <Tooltip label="Remove from stack">
              <StackTabClose
                type="button"
                aria-label={`Remove ${tabLabel(child, sessions)} from stack`}
                onClick={(e) => {
                  e.stopPropagation()
                  onUnstack(key)
                }}
              >
                <Icon glyph={IconClose} role="label" />
              </StackTabClose>
            </Tooltip>
          </StackTab>
        )
      })}
      {full && (
        <Tooltip label={`Stack is full (${stack.children.length}/${cap})`}>
          <StackTabCapacity data-testid="stack-full-indicator">
            {stack.children.length}/{cap}
          </StackTabCapacity>
        </Tooltip>
      )}
    </StackTabStrip>
  )
}
