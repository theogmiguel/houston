export function BarSparkline({ values, label }: { values: number[]; label: string }): React.JSX.Element {
  const max = Math.max(1, ...values)
  return (
    <span role="img" aria-label={label} className="inline-flex h-[var(--space-5)] items-end gap-[var(--space-1)]">
      {values.map((value, index) => (
        <span
          key={index}
          aria-hidden="true"
          className="w-[var(--space-1-5)] rounded-t-[var(--tr-radius-xs)] bg-[color-mix(in_srgb,var(--warn)_45%,var(--content-bg))]"
          style={{ height: `${Math.max(4, (value / max) * 24)}px` }}
        />
      ))}
    </span>
  )
}
