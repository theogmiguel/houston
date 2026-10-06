import type { ChangeEventHandler, ReactNode } from 'react'
import { IconCheck, IconSearch } from '../icons'
import { Icon } from './Icon'
import { Tooltip } from './Tooltip'
import { Text } from './Text'
import { FOCUS_HALO } from './shadowChrome'

export function PaletteSearch({ value, onChange }: { value: string; onChange: ChangeEventHandler<HTMLInputElement> }): React.JSX.Element {
  return <div className="relative flex-1 min-w-0">
    <span aria-hidden className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"><Icon glyph={IconSearch} role="small" /></span>
    <input type="search" data-testid="appearance-picker-search" aria-label="Search palettes" placeholder="Search palettes…" value={value} onChange={onChange} className={`w-full h-[var(--h-ctl)] bg-[var(--surface)] border border-[var(--border)] rounded-[var(--tr-radius-button)] pl-[var(--space-palette-search-inset)] pr-[var(--space-2)] text-[length:var(--tr-text-ui-size)] text-[var(--text-primary)] focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}]`} />
  </div>
}

export function PaletteOptionList({ children, maxHeight }: { children: ReactNode; maxHeight?: number }): React.JSX.Element {
  return <div data-testid="appearance-picker-list" role="listbox" aria-label="Terminal palettes" className="flex flex-col gap-[var(--space-palette-option-row)] overflow-y-auto" style={{ maxHeight: maxHeight ?? 'var(--h-palette-option-list)' }}>
    {children}
  </div>
}

export function PaletteOptionRow({
  selected,
  label,
  color,
  onHover,
  onSelect
}: {
  selected: boolean
  label: string
  color: string
  onHover: () => void
  onSelect: () => void
}): React.JSX.Element {
  return <button type="button" role="option" aria-selected={selected} data-testid="appearance-picker-row" onMouseEnter={onHover} onClick={onSelect} className={`border-0 flex items-center gap-[var(--space-2-5)] h-[var(--h-row)] px-[var(--space-2-5)] rounded-[var(--tr-radius-sm)] text-left text-[length:var(--tr-text-ui-size)] hover:bg-[var(--surface-hover)] active:scale-[0.98] focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] ${selected ? 'bg-[var(--accent-muted)] text-[var(--text-primary)]' : 'bg-transparent text-[var(--text-secondary)]'}`}>
    <span aria-hidden className="flex-none h-[var(--tr-icon-body-size)] w-[var(--tr-icon-body-size)] rounded-[var(--tr-radius-palette-swatch)] border border-[var(--border)]" style={{ background: color }} />
    <Tooltip label={label}><Text className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{label}</Text></Tooltip>
    {selected && <span aria-hidden><Icon glyph={IconCheck} role="small" /></span>}
  </button>
}

export function EmptyMessage({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="div" size="small" tone="muted" center data-testid="appearance-picker-empty-set" className="py-[var(--space-5)]">{children}</Text>
}

export function PaletteOptionsSpecimen(): React.JSX.Element {
  return <div className="flex max-w-[var(--w-palette-specimen)] flex-col gap-[var(--space-2)]"><PaletteSearch value="" onChange={() => {}} /><PaletteOptionList><PaletteOptionRow selected label="Black" color="var(--tool-code-bg)" onHover={() => {}} onSelect={() => {}} /><PaletteOptionRow selected={false} label="Solarized Dark" color="var(--card-bg)" onHover={() => {}} onSelect={() => {}} /></PaletteOptionList><EmptyMessage>No palettes match “unknown”.</EmptyMessage></div>
}
