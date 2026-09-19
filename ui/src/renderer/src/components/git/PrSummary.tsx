export function PrSummary({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      className="flex flex-col gap-[var(--space-2-5)] p-[var(--space-3)]"
      data-testid="pr-summary"
    >
      {children}
    </div>
  )
}
