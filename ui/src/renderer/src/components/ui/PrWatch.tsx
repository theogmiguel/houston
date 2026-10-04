import { Button } from './Button'
import { StatusLabel } from './StatusLabel'

export function PrWatchStack({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex-1 min-h-0 flex flex-col" data-testid="pr-watch-stack">{children}</div>
}

export function PrWatchChip({ number }: { number: number }): React.JSX.Element {
  return <span className="inline-flex items-center gap-[var(--space-1)] whitespace-nowrap" data-testid="pr-watch-chip"><StatusLabel status="Watching" /> <span className="text-[var(--text-secondary)]">#{number}</span></span>
}

export function PrWatchRow({ number, onStop, onOpen }: {
  number: number
  onStop: () => void
  onOpen: () => void
}): React.JSX.Element {
  return (
    <section className="flex flex-wrap items-center gap-[var(--space-2)] border-b border-b-[var(--divider)] px-[var(--space-3)] py-[var(--space-2)]" data-testid="pr-watch-row">
      <StatusLabel status="Watching" />
      <span className="min-w-0 flex-1 text-[var(--text-muted)]">Wakes on a failed check, passing checks, review activity, or a merge conflict.</span>
      <Button variant="danger" size="sm" onClick={onStop}>Stop watching</Button>
      <Button variant="ghost" size="sm" onClick={onOpen}>Open on GitHub</Button>
      <span className="sr-only">Pull request #{number}</span>
    </section>
  )
}
