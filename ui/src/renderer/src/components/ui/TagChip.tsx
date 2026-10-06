import type { ReactNode } from 'react'
import type { TagInfo } from '../../houston/generated/TagInfo'
import { Text } from './Text'
import { Tooltip } from './Tooltip'

function TagChipDot({ compact = false }: { compact?: boolean }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={`${compact ? 'w-[var(--sz-tag-dot-compact)] h-[var(--sz-tag-dot-compact)]' : 'w-[var(--sz-tag-dot-named)] h-[var(--sz-tag-dot-named)]'} rounded-full flex-none`}
      style={{ background: 'var(--tag)' }}
    />
  )
}

export function TagChip({
  tag,
  onToggle,
  tooltip,
  compact = false
}: {
  tag: TagInfo
  onToggle?: () => void
  tooltip?: string
  compact?: boolean
}): React.JSX.Element {
  const style = compact
    ? { ['--tag' as string]: tag.color }
    : {
        ['--tag' as string]: tag.color,
        background: 'color-mix(in srgb, var(--tag) 13%, transparent)',
        color: 'color-mix(in srgb, var(--tag) 72%, var(--tag-chip-text-base))',
        border: '1px solid color-mix(in srgb, var(--tag) 26%, transparent)'
      }
  const children: ReactNode = compact ? (
    <TagChipDot compact />
  ) : (
    <>
      <TagChipDot />
      <Text size="caption" weight="label" className="truncate">{tag.name}</Text>
    </>
  )
  const classes = compact
    ? 'inline-flex items-center justify-center flex-none w-[var(--h-tag-chip)] h-[var(--h-tag-chip)] rounded-[var(--tr-radius-sm)]'
    : 'inline-flex items-center gap-[var(--space-tag-chip-gap)] flex-none max-w-[var(--tag-chip-max,var(--w-tag-chip-max))] h-[var(--h-tag-chip)] px-[var(--space-tag-chip-padding)] rounded-[var(--tr-radius-sm)] leading-none whitespace-nowrap'
  if (!onToggle) {
    const chip = <span className={classes} style={style} data-testid="tag-chip">{children}</span>
    return tooltip ? <Tooltip label={tooltip}>{chip}</Tooltip> : chip
  }
  return (
    <Tooltip label={tooltip ?? tag.name}>
      <button
        type="button"
        aria-label={`Filter by ${tag.name}`}
        data-testid="tag-chip"
        className={`${classes} cursor-default hover:brightness-110`}
        style={style}
        onClick={(event) => {
          event.stopPropagation()
          onToggle()
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {children}
      </button>
    </Tooltip>
  )
}

function TagMore({ children, ...rest }: { children: ReactNode } & React.HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return (
    <Text
      {...rest}
      size="caption"
      weight="label"
      tone="muted"
      tabular
      className="inline-flex items-center justify-center flex-none h-[var(--h-tag-chip)] min-w-[var(--h-tag-chip)] px-[var(--space-tag-chip-padding)] rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--card-hover)] leading-none"
    >
      {children}
    </Text>
  )
}

export function TagChipRow({
  tags,
  onToggle,
  compact = false
}: {
  tags: TagInfo[]
  onToggle?: (tag: TagInfo) => void
  compact?: boolean
}): React.JSX.Element | null {
  if (tags.length === 0) return null
  const [first, ...rest] = tags
  return (
    <span data-testid="tag-chips" className="inline-flex items-center gap-[var(--space-1)] flex-none">
      <TagChip
        tag={first}
        onToggle={onToggle && (() => onToggle(first))}
        tooltip={onToggle ? undefined : first.name}
        compact={compact}
      />
      {rest.length > 0 && (
        <Tooltip label={`Also ${rest.map((tag) => tag.name).join(', ')}`}>
          <TagMore data-testid="tag-chips-more">+{rest.length}</TagMore>
        </Tooltip>
      )}
    </span>
  )
}
