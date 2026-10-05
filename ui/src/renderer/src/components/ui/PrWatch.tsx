import { Button } from './Button'
import { StatusLabel } from './StatusLabel'
import { Icon } from '../Icon'
import { IconEye } from '../icons'

export function PrWatchStack({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex-1 min-h-0 flex flex-col" data-testid="pr-watch-stack">{children}</div>
}

export function PrWatchChip({ number }: { number: number }): React.JSX.Element {
  return <span className="inline-flex items-center gap-[var(--space-1)] whitespace-nowrap" data-testid="pr-watch-chip"><StatusLabel status="Watching" /> <span className="text-[var(--text-secondary)]">#{number}</span></span>
}

export function PrWatchRow({ number, onStop, onOpen }: {
  number: number
  onStop: () => void
  onOpen?: () => void
}): React.JSX.Element {
  return (
    <section className="pr-watch-row" data-testid="pr-watch-row">
      <div className="pr-watch-top"><span className="pr-watch-label"><Icon glyph={IconEye} role="small" /><StatusLabel status="Watching" /></span><div className="pr-watch-actions"><Button variant="danger" size="sm" onClick={onStop}>Stop watching</Button>{onOpen && <Button variant="ghost" size="sm" onClick={onOpen}>Open on GitHub</Button>}</div></div>
      <span className="pr-watch-description">Wakes on a failed check, passing checks, review activity, or a merge conflict.</span>
      <span className="sr-only">Pull request #{number}</span>
    </section>
  )
}
