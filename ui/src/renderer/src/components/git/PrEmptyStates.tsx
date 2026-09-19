export function PrEmptyStates({
  testId,
  headline,
  description
}: {
  testId: string
  headline: string
  description: string
}): React.JSX.Element {
  return (
    <div
      className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 p-6 text-center"
      data-testid={testId}
    >
      <div className="text-[length:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-[var(--text-primary)]">
        {headline}
      </div>
      <p className="text-[length:var(--tr-text-small-size)] text-[var(--text-muted)] max-w-[46ch]">
        {description}
      </p>
    </div>
  )
}
