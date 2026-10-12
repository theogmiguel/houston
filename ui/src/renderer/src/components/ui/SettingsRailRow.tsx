import { ROW_STATE } from './rowState'
import type { ButtonHTMLAttributes, ComponentType, ReactNode } from 'react'
import type { IconProps } from '../icons'
import { variants } from './variants'

const rowClasses = variants(
  'treerow relative flex w-full items-center gap-[var(--space-2)] rounded-[var(--tr-radius-sm)] border-0 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]',
  {
    kind: {
      section: 'h-[var(--h-row)] px-[var(--space-2)] [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)]',
      search: 'min-h-10 items-start px-[var(--space-2)] py-[var(--space-1-5)] [font-size:var(--tr-text-small-size)]'
    },
    selected: { true: ROW_STATE.selected, false: ROW_STATE.rest }
  },
  { kind: 'section', selected: 'false' }
)

type SettingsRailRowProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  kind: 'section' | 'search'
  icon: ComponentType<IconProps>
  label: string
  subtitle?: string
  trailing?: ReactNode
  selected?: boolean
  sectionId?: string
  rowTitle?: string
}

export function SettingsRailRow({
  kind,
  icon: Icon,
  label,
  subtitle,
  trailing,
  selected = false,
  sectionId,
  rowTitle,
  className = '',
  ...props
}: SettingsRailRowProps): React.JSX.Element {
  return (
    <button
      {...props}
      type="button"
      data-testid={kind === 'section' ? 'settings-section-row' : 'settings-search-hit'}
      data-section-id={sectionId}
      data-row-title={rowTitle}
      aria-current={kind === 'section' && selected ? 'true' : undefined}
      className={`${rowClasses({ kind, selected: String(selected) as 'true' | 'false' })} ${className}`}
    >
      <Icon className={`h-[14px] w-[14px] flex-none ${selected ? 'text-[var(--text-primary)]' : 'text-[var(--text-faint)]'}`} />
      {kind === 'search' ? (
        <span className="min-w-0 flex-1 grid gap-[var(--space-1)]">
          <span className="block truncate">{label}</span>
          <span className="block text-[length:var(--tr-text-label-size)] text-[var(--text-muted)]">{subtitle}</span>
        </span>
      ) : <span className="min-w-0 flex-1 truncate">{label}</span>}
      {trailing && <span className="ml-auto flex-none">{trailing}</span>}
    </button>
  )
}
