import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from 'react'
import { Button } from '../Button'
import { ContextMenu } from '../ContextMenu'
import { Icon } from '../Icon'
import { IconCheck, IconChevronRight, IconPin } from '../../icons'
import { Tooltip } from '../Tooltip'
import { WorkspaceTreeRow } from '../WorkspaceTreeRow'

export function RailOptionsSurface({ children, style }: { children: ReactNode; style: React.CSSProperties }): React.JSX.Element {
  return <div data-rail-options role="dialog" aria-label="Sidebar options" className="fixed z-[var(--z-popover)] w-[var(--w-rail-options)] rounded-[var(--tr-radius-md)] border border-[var(--border)] bg-[var(--glass)] p-[var(--space-2)] shadow-[var(--shadow-popover)] backdrop-blur-xl" style={style}>{children}</div>
}

export function RailOptionsTitle({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="px-[var(--space-2)] pb-[var(--space-2)] [font-size:var(--tr-text-small-size)] leading-4 font-semibold text-[var(--text-primary)]">{children}</div>
}

export function RailOptionsSectionLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="px-[var(--space-2)] pb-[var(--space-1)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] text-[var(--text-muted)]">{children}</div>
}

export function RailOptionsDivider(): React.JSX.Element {
  return <div className="my-[var(--space-2)] border-t border-[var(--border)]" />
}

export function RailSortOption({ selected, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { selected: boolean; children: ReactNode }): React.JSX.Element {
  return <button {...props} type="button" role="radio" aria-checked={selected} className={`flex h-[var(--h-ctl)] items-center gap-[var(--space-2)] rounded-[var(--tr-radius-input)] px-[var(--space-2)] text-left [font-size:var(--tr-text-label-size)] ${selected ? 'bg-selected-fill text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-hover-fill'}`}>{children}</button>
}

export function RailSortList({ children }: { children: ReactNode }): React.JSX.Element {
  return <div role="radiogroup" aria-label="Sort" className="grid gap-[var(--space-0-5)]">{children}</div>
}

export function RailSortCheck(): React.JSX.Element {
  return <Icon glyph={IconCheck} role="small" className="text-[var(--accent)]" />
}

export function RailChevron({ collapsed }: { collapsed: boolean }): React.JSX.Element {
  return <Icon glyph={IconChevronRight} role="small" opacity="subtle" className={collapsed ? '' : 'rotate-90'} />
}

export function RailOptionsGrid({ children, variant = 'properties' }: { children: ReactNode; variant?: 'properties' | 'always-shown' | 'filters' }): React.JSX.Element {
  const classes = variant === 'filters' ? 'grid gap-[var(--space-1)] px-[var(--space-2)]' : 'grid grid-cols-2 gap-x-[var(--space-2)] gap-y-[var(--space-1)] px-[var(--space-2)]'
  return <div style={variant === 'always-shown' ? { paddingBottom: 'var(--space-1)' } : undefined} className={classes}>{children}</div>
}

export function RailResetButton({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button {...props} type="button" style={{ marginTop: 'var(--space-1)' }} className="px-[var(--space-2)] [font-size:var(--tr-text-label-size)] text-[var(--accent)] hover:underline">{children}</button>
}

export function RailOptionsStackGap({ children }: { children: ReactNode }): React.JSX.Element {
  return <div style={{ marginTop: 'var(--space-2)' }}>{children}</div>
}

export function RailFilterValue({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="ml-auto">{children}</span>
}

export function RailFilterButton({ children, active = true, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }): React.JSX.Element {
  return <button {...props} type="button" className={`flex h-[var(--h-rail-filter-button)] items-center gap-[var(--space-2)] text-left [font-size:var(--tr-text-label-size)] ${active ? 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]' : 'text-[var(--text-faint)]'}`}>{children}</button>
}

export function RailVirtualViewport({ children, dragging, ...props }: ComponentProps<'div'> & { dragging: boolean; children: ReactNode }): React.JSX.Element {
  return <div {...props} className={`wlist flex min-h-0 flex-1 flex-col gap-[var(--space-1)] overflow-y-auto px-[var(--space-1-5)] pt-[var(--space-0-5)] pb-[var(--space-2)] ${dragging ? 'cursor-grabbing' : 'cursor-pointer'}`}>{children}</div>
}

export function RailWorkspaceGroupRow(props: ComponentProps<typeof WorkspaceTreeRow>): React.JSX.Element {
  const { className = '', selected = false, ...rest } = props
  return <WorkspaceTreeRow {...rest} selected={selected} className={`font-semibold ${selected ? 'bg-selected-fill' : ''} ${className}`} />
}

export function RailRowCount({ count }: { count: number }): React.JSX.Element {
  return <span aria-hidden="true" data-count={count} className="flex-none [font-size:var(--tr-text-label-size)] font-medium text-[var(--text-muted)] after:content-[attr(data-count)]" />
}

export function RailPinnedIndicator(): React.JSX.Element {
  return <Tooltip label="Pinned"><span aria-label="Pinned" data-testid="ws-pinned-indicator" className="flex-none flex items-center"><Icon glyph={IconPin} role="small" tone="muted" /></span></Tooltip>
}

export function RailUpdateIconButton({ failed = false, ...props }: ComponentProps<typeof Button> & { failed?: boolean }): React.JSX.Element {
  const { className = '', ...rest } = props
  return <Button {...rest} className={`relative ml-auto size-[var(--sz-rail-update-button)] rounded-full bg-[var(--card-bg)] hover:bg-[var(--card-bg)] ${failed ? 'text-[var(--warn)]' : 'text-[var(--text-primary)]'} ${className}`} />
}

export function RailUpdateDot(): React.JSX.Element {
  return <span aria-hidden className="absolute right-[var(--space-1-5)] top-[var(--space-1-5)] size-[var(--space-1-5)] rounded-full bg-current" />
}

export function RailSrOnlyText({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="sr-only">{children}</span>
}

export function RailContextMenu({ visible = true, children, ...props }: ComponentProps<typeof ContextMenu> & { visible?: boolean }): React.JSX.Element {
  const { className = '', ...rest } = props
  return <ContextMenu {...rest} className={`${visible ? '' : 'invisible'} ${className}`}>{children}</ContextMenu>
}

export function RailGroupHeader({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="sticky top-0 z-[1] flex h-[var(--h-ctl)] w-full items-center rounded-[var(--tr-radius-sm)] px-[var(--space-1)] [font-size:var(--tr-text-small-size)] leading-4 text-[var(--text-secondary)] hover:bg-hover-fill">{children}</div>
}

export function RailGroupToggle({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button {...props} type="button" className="flex h-full min-w-0 flex-1 items-center gap-[var(--space-1-5)] rounded-[var(--tr-radius-input)] text-left">{children}</button>
}

export function RailGroupCount({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="flex-none [font-size:var(--tr-text-label-size)] font-medium text-[var(--text-muted)]">{children}</span>
}

export function RailTreeGroupHeader({ children }: { children: ReactNode }): React.JSX.Element {
  return <div data-testid="tree-group-header" className="flex h-[var(--h-rail-group-header)] flex-none items-center gap-[var(--space-1)] px-[var(--space-2)] pt-[var(--space-1)]">{children}</div>
}

export function RailTreeTitle({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="min-w-0 flex-1 truncate [font-size:var(--tr-text-small-size)] leading-4 font-semibold text-[var(--text-muted)]">{children}</span>
}

export function RailFilterCountBadge({ children }: { children: ReactNode }): React.JSX.Element {
  return <span aria-hidden data-testid="tree-filter-badge" className="absolute -right-[var(--space-pixel)] -top-[var(--space-pixel)] h-[var(--h-rail-filter-badge)] min-w-[var(--h-rail-filter-badge)] rounded-full bg-[var(--accent)] px-[var(--space-0-5)] text-center [font-size:var(--tr-text-label-size)] leading-[var(--h-rail-filter-badge)] text-white">{children}</span>
}

export function RailChromeSpecimen(): React.JSX.Element {
  return <div className="grid w-[264px] gap-[var(--space-2)]"><RailOptionsTitle>Sidebar options</RailOptionsTitle><RailOptionsSectionLabel>Group by</RailOptionsSectionLabel><RailSortOption selected>Smart</RailSortOption><RailGroupHeader><RailGroupToggle aria-expanded>Workspace</RailGroupToggle></RailGroupHeader><RailTreeGroupHeader><RailTreeTitle>Grids</RailTreeTitle></RailTreeGroupHeader></div>
}
