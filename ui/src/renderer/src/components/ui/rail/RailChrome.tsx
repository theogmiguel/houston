import { RING_CARD_HOVER_GAP } from '../shadowChrome'
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from 'react'
import { Button } from '../Button'
import { ContextMenu } from '../ContextMenu'
import { Icon } from '../Icon'
import { IconCheck, IconChevronRight, IconPin } from '../../icons'
import { Tooltip } from '../Tooltip'
import { WorkspaceTreeRow } from '../WorkspaceTreeRow'

export function RailOptionsSurface({ children, style }: { children: ReactNode; style: React.CSSProperties }): React.JSX.Element {
  return <div data-rail-options role="dialog" aria-label="Sidebar options" className="fixed z-[var(--z-popover)] w-[var(--w-rail-options)] rounded-[var(--tr-radius-md)] border border-[color-mix(in_srgb,var(--text-primary)_10%,transparent)] bg-[var(--glass)] p-1 shadow-[var(--shadow-popover)] backdrop-blur-[16px] [backdrop-filter:blur(16px)_saturate(1.08)] [font-size:var(--tr-text-base)]" style={style}>{children}</div>
}

export function RailOptionsView({ direction, children }: { direction: 'none' | 'forward' | 'back'; children: ReactNode }): React.JSX.Element {
  const motion = direction === 'forward' ? 'motion-safe:animate-[rail-options-forward_150ms_ease-out_both]' : direction === 'back' ? 'motion-safe:animate-[rail-options-back_150ms_ease-out_both]' : ''
  return <div className={motion}>{children}</div>
}

export function RailOptionsTitle({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="px-2 pt-1.5 pb-1 [font-size:var(--tr-text-xs)] font-medium text-[var(--text-muted)]">{children}</div>
}

export function RailOptionsSectionLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="px-2 pt-1.5 pb-1 [font-size:var(--tr-text-xs)] font-medium text-[var(--text-muted)]">{children}</div>
}

export function RailOptionsDivider(): React.JSX.Element {
  return <div className="mx-2 my-1 border-t border-[var(--divider)]" />
}

export function RailMenuRow({ children, selected = false, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }): React.JSX.Element {
  return <button {...props} type="button" className={`flex min-h-7 w-full items-center gap-2 rounded-[var(--tr-radius-sm)] px-2 py-1 text-left [font-size:var(--tr-text-base)] text-[var(--text-primary)] hover:bg-hover-fill ${selected ? 'bg-hover-fill' : ''}`}>{children}</button>
}

export function RailMenuValue({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="ml-auto text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">{children}</span>
}

export function RailMenuCheckSlot({ checked }: { checked: boolean }): React.JSX.Element {
  return <span className="w-3.5 text-[var(--text-muted)]">{checked && <Icon glyph={IconCheck} role="small" />}</span>
}

export function RailCardModeSegment({ value, onChange }: { value: 'detailed' | 'compact'; onChange: (value: 'detailed' | 'compact') => void }): React.JSX.Element {
  return <div className="px-2 pb-[var(--space-1-5)]"><div className="flex gap-0.5 rounded-[var(--tr-radius-button)] bg-hover-fill p-0.5">
    {(['detailed', 'compact'] as const).map((mode) => <button key={mode} type="button" aria-pressed={value === mode} onClick={() => onChange(mode)} className="h-[var(--h-rail-segment)] flex-1 rounded-[var(--tr-radius-sm)] [font-size:var(--tr-text-xs)] text-[var(--text-muted)] aria-pressed:bg-[var(--card-hover)] aria-pressed:font-semibold aria-pressed:text-[var(--text-primary)]">{mode === 'compact' ? 'Condensed' : 'Detailed'}</button>)}
  </div></div>
}

export function RailTagDisplaySegment({ value, onChange }: { value: 'icon' | 'dots' | 'chips'; onChange: (value: 'icon' | 'dots' | 'chips') => void }): React.JSX.Element {
  return <div role="group" aria-label="Tags display" className="mx-2 my-1 flex gap-0.5 rounded-[var(--tr-radius-button)] bg-hover-fill p-0.5">
    {(['icon', 'dots', 'chips'] as const).map((mode) => <button key={mode} type="button" aria-pressed={value === mode} onClick={() => onChange(mode)} className="h-[var(--h-rail-segment)] flex-1 rounded-[var(--tr-radius-sm)] [font-size:var(--tr-text-xs)] text-[var(--text-muted)] aria-pressed:bg-[var(--card-hover)] aria-pressed:font-semibold aria-pressed:text-[var(--text-primary)]">{mode === 'icon' ? 'Icon' : mode === 'dots' ? 'Dots' : 'Chips'}</button>)}
  </div>
}

export function RailTagFilterValue({ active, colors }: { active: boolean; colors: readonly string[] }): React.JSX.Element {
  return <span className="ml-auto inline-flex items-center gap-1 text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">
    {active ? <>
      {colors.length ? colors.map((color, index) => <i key={index} className="size-1.5 rounded-full" style={{ background: color }} />) : 'All'}
      <Icon glyph={IconChevronRight} role="small" />
    </> : <span className="inline-flex h-4 items-center rounded-[var(--tr-radius-xs)] border border-[var(--border)] px-1 [font-size:var(--tr-text-xs)]">Off</span>}
  </span>
}

export function RailGroupStatusDot({ label }: { label: string }): React.JSX.Element {
  const tone = label === 'Needs you' ? 'bg-[var(--warn)]' : label === 'Working' ? 'bg-[var(--info)]' : label === 'Done' ? 'bg-[var(--ok)]' : 'bg-[var(--text-faint)]'
  return <span aria-hidden className={`size-2 flex-none rounded-full ${tone}`} />
}

export function RailGroupSegment({ value, onChange }: { value: 'none' | 'status' | 'workspace' | 'pr'; onChange: (value: 'none' | 'status' | 'workspace' | 'pr') => void }): React.JSX.Element {
  const options = value === 'pr' ? ['none', 'status', 'workspace', 'pr'] as const : ['none', 'status', 'workspace'] as const
  return <div className="px-2 pb-[var(--space-1-5)]"><div role="group" aria-label="Group by" className="flex gap-0.5 rounded-[var(--tr-radius-button)] bg-hover-fill p-0.5">
    {options.map((option) => <button key={option} type="button" aria-pressed={value === option} onClick={() => onChange(option)} className="h-[var(--h-rail-segment)] min-w-0 flex-1 rounded-[var(--tr-radius-sm)] px-0.5 text-[length:var(--tr-text-xs)] text-[var(--text-muted)] aria-pressed:bg-[var(--card-hover)] aria-pressed:font-semibold aria-pressed:text-[var(--text-primary)]">{option === 'none' ? 'None' : option === 'status' ? 'Status' : option === 'pr' ? 'PR' : 'Workspace'}</button>)}
  </div></div>
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
  return <Icon glyph={IconChevronRight} role="small" opacity="subtle" className={`transition-transform duration-150 motion-reduce:transition-none ${collapsed ? '' : 'rotate-90'}`} />
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
  const { className = '', style, ...rest } = props
  return <Button {...rest} style={{ ...style, width: 'var(--sz-rail-update-button)', height: 'var(--sz-rail-update-button)', background: 'var(--card-hover)' }} className={`relative ml-auto rounded-full ${failed ? 'text-[var(--warn)]' : 'text-[var(--text-primary)]'} ${className}`} />
}

export function RailUpdateDot(): React.JSX.Element {
  return <span aria-hidden className={`absolute right-[var(--space-1-5)] top-[var(--space-1-5)] size-[var(--space-1-5)] rounded-full bg-current shadow-[${RING_CARD_HOVER_GAP}]`} />
}

export function RailSrOnlyText({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="sr-only">{children}</span>
}

export function RailContextMenu({ visible = true, children, ...props }: ComponentProps<typeof ContextMenu> & { visible?: boolean }): React.JSX.Element {
  const { className = '', ...rest } = props
  return <ContextMenu {...rest} className={`${visible ? '' : 'invisible'} ${className}`}>{children}</ContextMenu>
}

export function RailGroupHeader({ children }: { children: ReactNode }): React.JSX.Element {
  // The top padding separates groups; the hover fill covers only the label row.
  return <div className="group sticky top-0 z-[1] w-full pt-[var(--space-1)]">
    <div className="flex h-[var(--h-row)] w-full items-center rounded-[var(--tr-radius-sm)] px-2 [font-size:var(--tr-text-small-size)] font-semibold leading-4 text-[var(--text-secondary)] hover:bg-hover-fill">{children}</div>
  </div>
}

export function RailGroupToggle({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button {...props} type="button" className="flex h-full min-w-0 flex-1 items-center gap-[var(--space-1-5)] rounded-[var(--tr-radius-input)] text-left font-semibold text-[var(--text-secondary)]">{children}</button>
}

export function RailGroupCount({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="flex-none [font-size:var(--tr-text-label-size)] font-medium text-[var(--text-muted)]">{children}</span>
}

export function RailTreeGroupHeader({ children }: { children: ReactNode }): React.JSX.Element {
  return <div data-testid="tree-group-header" className="box-content flex h-[var(--h-rail-group-header)] flex-none items-center gap-1 px-[var(--space-2)] pt-[var(--space-2)]">{children}</div>
}

export function RailTreeTitle({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="min-w-0 flex-1 truncate [font-size:var(--tr-text-small-size)] leading-4 font-semibold text-[var(--text-muted)]">{children}</span>
}

export function RailFilterCountBadge({ children }: { children: ReactNode }): React.JSX.Element {
  return <span aria-hidden data-testid="tree-filter-badge" className="absolute -right-[var(--space-pixel)] -top-[var(--space-pixel)] h-[var(--h-rail-filter-badge)] min-w-[var(--h-rail-filter-badge)] rounded-full bg-[var(--accent)] px-[var(--space-0-5)] text-center [font-size:var(--tr-text-label-size)] leading-[var(--h-rail-filter-badge)] text-white">{children}</span>
}

export function RailChromeSpecimen(): React.JSX.Element {
  return <div className="grid w-[264px] gap-[var(--space-2)]"><RailOptionsView direction="none"><RailOptionsTitle>Sidebar options</RailOptionsTitle></RailOptionsView><RailOptionsSectionLabel>Group by</RailOptionsSectionLabel><RailGroupSegment value="workspace" onChange={() => {}} /><RailCardModeSegment value="detailed" onChange={() => {}} /><RailTagDisplaySegment value="dots" onChange={() => {}} /><RailMenuRow selected><RailMenuCheckSlot checked />Sort by<RailMenuValue>Manual</RailMenuValue></RailMenuRow><RailMenuRow>Tags<RailTagFilterValue active colors={['var(--ok)', 'var(--info)']} /></RailMenuRow><RailSortOption selected>Smart</RailSortOption><RailGroupHeader><RailGroupToggle aria-expanded><RailGroupStatusDot label="Working" />Workspace</RailGroupToggle></RailGroupHeader><RailTreeGroupHeader><RailTreeTitle>Grids</RailTreeTitle></RailTreeGroupHeader></div>
}
