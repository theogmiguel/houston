import type { ButtonHTMLAttributes, ComponentType, ReactNode } from 'react'
import { AGENT_DOT_COLOR, IconAgent, IconChevronDown, IconChevronRight } from '../icons'
import type { AgentKind } from '../../houston/client'
import { Icon, ICON_ROLE_CLS } from './Icon'
import { OVERLAY_GLASS_OVERLAY_ATTRS, OVERLAY_GLASS_OVERLAY_CLS, popOriginStyle } from './overlayChrome'
import { Tooltip } from './Tooltip'
import { Text, type TextProps } from './Text'

const TextButton = Text as ComponentType<TextProps & ButtonHTMLAttributes<HTMLButtonElement>>

const SECTION_LABEL_CLS = 'px-[var(--space-3)] pt-[var(--space-1)] pb-[var(--space-0-5)]'

const AGENT_ROW_CLS = 'flex items-center gap-[var(--space-2-5)] px-[var(--space-3)] min-h-[var(--h-ctl)] w-full text-left bg-transparent border-none hover:bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent'

const PROFILE_ROW_CLS = 'flex items-center gap-[var(--space-2-5)] pl-[var(--space-profile-row-indent)] pr-[var(--space-3)] min-h-[var(--h-pill)] text-left bg-transparent border-none hover:bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] hover:text-[var(--text-primary)]'

/** Glass popover that holds the New pane menu, anchored by its right edge so it opens leftward. */
export function PaneMenuSurface({ right, y, children, ...rest }: {
  right: number
  y: number
  children: ReactNode
  'data-testid'?: string
  onMouseDown?: (event: React.MouseEvent<HTMLDivElement>) => void
}): React.JSX.Element {
  return (
    <div
      {...rest}
      {...OVERLAY_GLASS_OVERLAY_ATTRS}
      className={`add-pane-popover fixed z-[var(--z-popover)] flex flex-col gap-[var(--space-0-5)] py-[var(--space-1-5)] min-w-[var(--w-pane-menu)] overflow-hidden ${OVERLAY_GLASS_OVERLAY_CLS}`}
      style={{ top: y, right, ...popOriginStyle('right', 'top') }}
    >
      {children}
    </div>
  )
}

export function PaneMenuLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="div" size="label" weight="label" tone="faint" className={SECTION_LABEL_CLS}>{children}</Text>
}

export function PaneMenuDivider(): React.JSX.Element {
  return <div className="h-[var(--space-pixel)] my-[var(--space-1)] mx-0 bg-[var(--glass-brd)]" />
}

/** Agent row: brand-coloured glyph and name; `expanded` adds a chevron, `disabledReason` disables the row. */
export function PaneMenuAgentRow({ agent, expanded, disabledReason, onClick }: {
  agent: AgentKind
  expanded?: boolean
  disabledReason?: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <Tooltip label={disabledReason} className="inline-flex w-full">
      <button type="button" disabled={disabledReason !== undefined} className={AGENT_ROW_CLS} onClick={onClick}>
        <span style={{ color: AGENT_DOT_COLOR[agent] ?? 'var(--text-muted)' }} className="flex-none inline-flex">
          <IconAgent agent={agent} className={ICON_ROLE_CLS.ui} />
        </span>
        <Text size="ui" weight="ui" tone="secondary" className="flex-1 capitalize">{agent}</Text>
        {expanded !== undefined && (
          <Icon
            glyph={expanded ? IconChevronDown : IconChevronRight}
            role="ui"
            className="text-[var(--text-faint)] flex-none"
          />
        )}
      </button>
    </Tooltip>
  )
}

/** Indented list of account choices under an expanded agent row. */
export function PaneMenuProfileGroup({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex flex-col gap-[var(--space-0-5)] py-[var(--space-0-5)]">{children}</div>
}

export function PaneMenuProfileRow({ children, onClick }: { children: ReactNode; onClick: () => void }): React.JSX.Element {
  return <TextButton as="button" type="button" size="small" weight="small" tone="secondary" className={PROFILE_ROW_CLS} onClick={onClick}>{children}</TextButton>
}
