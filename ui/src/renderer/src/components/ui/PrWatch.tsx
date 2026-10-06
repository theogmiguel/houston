import { Button } from './Button'
import { StatusLabel } from './StatusLabel'
import { Icon } from '../Icon'
import { IconEye } from '../icons'
import { relativeAge, useAgeNow } from '../ageTicker'

export function PrWatchStack({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex-1 min-h-0 flex flex-col" data-testid="pr-watch-stack">{children}</div>
}

export function PrWatchChip({ number }: { number: number }): React.JSX.Element {
  return <span className="inline-flex items-center gap-[var(--space-1)] whitespace-nowrap" data-testid="pr-watch-chip"><StatusLabel status="Watching" /> <span className="text-[var(--text-secondary)]">#{number}</span></span>
}

export function PrWatchRow({ number, lastCheckedAtMs, onStop, onOpen, compact = false }: {
  number: number
  lastCheckedAtMs?: number | null
  onStop: () => void
  onOpen?: () => void
  compact?: boolean
}): React.JSX.Element {
  const now = useAgeNow(lastCheckedAtMs != null)
  if (compact) return (
    <section className="pr-watch-row pr-watch-row-compact" data-testid="pr-watch-row">
      <div className="pr-watch-top">
        <span className="pr-watch-label"><Icon glyph={IconEye} role="small" /><StatusLabel status="Watching" /></span>
        {lastCheckedAtMs != null && <span className="pr-watch-checked">checked {relativeAge(lastCheckedAtMs, now)}</span>}
      </div>
      <span className="pr-watch-description">Wakes orchestrator on a failed check, all reported checks passing, a new review or comment, or a new conflict.</span>
      <div className="pr-watch-actions">
        <Button variant="secondary" size="sm" onClick={onStop}>Stop watching</Button>
      </div>
      <span className="sr-only">Pull request #{number}</span>
    </section>
  )
  return (
    <section className="pr-watch-row" data-testid="pr-watch-row">
      <div className="pr-watch-top"><span className="pr-watch-label"><Icon glyph={IconEye} role="small" /><StatusLabel status="Watching" /></span>{lastCheckedAtMs != null && <span className="text-[length:var(--tr-text-xs)] text-[var(--text-muted)]">checked {relativeAge(lastCheckedAtMs, now)}</span>}<div className="pr-watch-actions"><Button variant="danger" size="sm" onClick={onStop}>Stop watching</Button>{onOpen && <Button variant="ghost" size="sm" onClick={onOpen}>Open on GitHub</Button>}</div></div>
      <span className="pr-watch-description">Wakes orchestrator on a failed check, all reported checks passing, a new review or comment, or a new conflict.</span>
      <span className="sr-only">Pull request #{number}</span>
    </section>
  )
}
