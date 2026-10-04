export interface CountProps {
  value: number
  showZero?: boolean
  from?: 'primary' | 'secondary'
}

export function Count({ value, showZero = false, from = 'secondary' }: CountProps): React.JSX.Element | null {
  if (value === 0 && !showZero) return null

  return (
    <span
      className={`inline-flex items-center tabular-nums [font-size:inherit] [font-weight:inherit] ${from === 'primary' ? 'text-[var(--text-secondary)]' : 'text-[var(--text-muted)]'}`}
    >
      <span aria-hidden="true" className="w-[var(--space-1-5)]" />
      {value}
    </span>
  )
}
