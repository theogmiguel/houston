import { FOCUS_HALO } from './shadowChrome'

export type IconTileSize = 'sm' | 'md' | 'lg' | 'xl'
export type IconTileTone = 'default' | 'accent' | 'success' | 'warning' | 'danger' | 'danger-outline' | 'muted' | 'surface-muted'

const SIZE_PX: Record<IconTileSize, number | string> = { sm: 24, md: 32, lg: 40, xl: 'var(--sz-workspace-empty-icon)' }

const TONE_CLASS: Record<IconTileTone, string> = {
  default: 'bg-[var(--surface)] text-[var(--text-secondary)] border-[var(--border)]',
  accent: 'bg-[var(--accent-muted)] text-[var(--accent)] border-transparent',
  success: 'bg-[var(--status-done-bg)] text-[var(--status-done-text)] border-transparent',
  warning: 'bg-[var(--status-todo-bg)] text-[var(--status-todo-text)] border-transparent',
  danger: 'bg-[var(--status-blocked-bg)] text-[var(--status-blocked-text)] border-transparent',
  'danger-outline': 'bg-[var(--status-blocked-bg)] text-[var(--status-blocked-text)] border-[color-mix(in_srgb,var(--status-blocked-text)_35%,transparent)]',
  muted: 'bg-transparent text-[var(--text-muted)] border-[var(--border)]',
  'surface-muted': 'bg-[var(--card-bg)] text-[var(--text-secondary)] border-[var(--border)]'
}

export interface IconTileProps {
  icon?: React.ReactNode
  size?: IconTileSize
  radius?: 'button' | 'medium'
  tone?: IconTileTone
  selected?: boolean
  disabled?: boolean
  disabledReason?: string
  loading?: boolean
  interactive?: boolean
  onClick?: () => void
  label?: string
  className?: string
}

function Spinner({ size = 12 }: { size?: number | string }): React.JSX.Element {
  return (
    <span
      role="status"
      aria-label="Loading"
      className="inline-block animate-spin rounded-full border-2 border-current border-t-transparent opacity-70"
      style={{ width: size, height: size }}
    />
  )
}

function tileClass({ radius, tone, interactive, selected, disabled, empty }: Required<Pick<IconTileProps, 'radius' | 'tone' | 'interactive' | 'selected' | 'disabled'>> & { empty: boolean }): string {
  const shape = radius === 'medium' ? 'rounded-[var(--tr-radius-md)]' : 'rounded-[var(--tr-radius-button)]'
  const hover = interactive ? `cursor-pointer hover:bg-[var(--surface-hover)] active:scale-[0.96] focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}]` : ''
  const pressed = selected ? 'border-[var(--accent)] bg-[var(--accent-muted)] text-[var(--accent)]' : ''
  return `inline-flex flex-none items-center justify-center border ${shape} ${TONE_CLASS[tone]} ${hover} ${pressed} ${disabled ? 'opacity-50 cursor-not-allowed' : ''} ${empty ? 'border-dashed' : ''}`
}

function IconTileContent({ icon, loading, spinnerSize }: { icon?: React.ReactNode; loading: boolean; spinnerSize: number | string }): React.JSX.Element {
  if (loading) return <Spinner size={spinnerSize} />
  if (!icon) {
    return (
      <span aria-hidden data-testid="icon-tile-placeholder" className="opacity-40 [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)]">
        –
      </span>
    )
  }
  return (
    <span aria-hidden data-testid="icon-tile-icon" className="flex-none">
      {icon}
    </span>
  )
}

export function IconTile({
  icon,
  size = 'md',
  radius = 'button',
  tone = 'default',
  selected = false,
  disabled = false,
  disabledReason,
  loading = false,
  interactive = false,
  onClick,
  label,
  className = ''
}: IconTileProps): React.JSX.Element {
  const px = SIZE_PX[size]
  const spinnerSize = size === 'xl' ? 'var(--sz-workspace-empty-spinner)' : Math.round((px as number) * 0.4)
  const Tag = interactive ? 'button' : 'div'
  const title = disabled ? disabledReason : undefined

  return (
    <Tag
      type={interactive ? 'button' : undefined}
      data-testid="icon-tile"
      aria-label={label}
      aria-disabled={disabled || undefined}
      aria-pressed={interactive ? selected : undefined}
      disabled={interactive ? disabled : undefined}
      title={title}
      onClick={interactive && !disabled ? onClick : undefined}
      style={{ width: px, height: px }}
      className={`${tileClass({ radius, tone, interactive, selected, disabled, empty: !icon && !loading })} ${className}`}
    >
      <IconTileContent icon={icon} loading={loading} spinnerSize={spinnerSize} />
    </Tag>
  )
}
