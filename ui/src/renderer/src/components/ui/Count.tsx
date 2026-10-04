export interface CountProps {
  value: number
  showZero?: boolean
  from?: 'primary' | 'secondary' | 'accent'
}

export function Count({ value, showZero = false, from = 'secondary' }: CountProps): React.JSX.Element | null {
  if (value === 0 && !showZero) return null

  return (
    <span
      className={`tabular-nums [font-size:inherit] [font-weight:inherit] ${from === 'accent' ? 'text-[var(--accent)]' : from === 'primary' ? 'text-[var(--text-secondary)]' : 'text-[var(--text-muted)]'}`}
    >
      <span aria-hidden="true" className="inline-block w-[var(--space-1-5)]" />
      {value}
    </span>
  )
}
