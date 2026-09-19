import { FOCUS_HALO } from './shadowChrome'

export type IconTileSize = 'sm' | 'md' | 'lg'
export type IconTileTone = 'default' | 'accent' | 'success' | 'warning' | 'danger' | 'muted'

const SIZE_PX: Record<IconTileSize, number> = { sm: 24, md: 32, lg: 40 }

const TONE_CLASS: Record<IconTileTone, string> = {
  default: 'bg-[var(--surface)] text-[var(--text-secondary)] border-[var(--border)]',
  accent: 'bg-[var(--accent-muted)] text-[var(--accent)] border-transparent',
  success: 'bg-[var(--status-done-bg)] text-[var(--status-done-text)] border-transparent',
  warning: 'bg-[var(--status-todo-bg)] text-[var(--status-todo-text)] border-transparent',
  danger: 'bg-[var(--status-blocked-bg)] text-[var(--status-blocked-text)] border-transparent',
  muted: 'bg-transparent text-[var(--text-muted)] border-[var(--border)]'
}

export interface IconTileProps {
  icon?: React.ReactNode
  size?: IconTileSize
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

function Spinner({ size = 12 }: { size?: number }): React.JSX.Element {
  return (
    <span
      role="status"
      aria-label="Loading"
      className="inline-block animate-spin rounded-full border-2 border-current border-t-transparent opacity-70"
      style={{ width: size, height: size }}
    />
  )
}

export function IconTile({
  icon,
  size = 'md',
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
      className={`inline-flex flex-none items-center justify-center border rounded-[var(--tr-radius-button)] ${TONE_CLASS[tone]} ${
        interactive
          ? `cursor-pointer hover:bg-[var(--surface-hover)] active:scale-[0.96] focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}]`
          : ''
      } ${selected ? 'border-[var(--accent)] bg-[var(--accent-muted)] text-[var(--accent)]' : ''} ${
        disabled ? 'opacity-50 cursor-not-allowed' : ''
      } ${!icon && !loading ? 'border-dashed' : ''} ${className}`}
    >
      {loading ? <Spinner size={Math.round(px * 0.4)} /> : icon ? (
        <span aria-hidden data-testid="icon-tile-icon" className="flex-none">
          {icon}
        </span>
      ) : (
        <span aria-hidden data-testid="icon-tile-placeholder" className="opacity-40 [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)]">
          –
        </span>
      )}
    </Tag>
  )
}
