import { useEffect, useState } from 'react'
import { Tooltip } from './Tooltip'

// One minute: the coarsest step the relative words ("min ago"/"h ago") can
// show, so a faster tick would just repaint the same sentence.
const TICK_MS = 60_000

export function checkedWords(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return 'Checked just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `Checked ${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Checked ${hours} h ago`
  return `Checked ${Math.floor(hours / 24)} d ago`
}

export function CheckedStamp({ at }: { at: number | null }): React.JSX.Element | null {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (at === null) return
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [at])

  if (at === null) return null
  return (
    <Tooltip label={new Date(at).toLocaleString()}>
      <span
        data-testid="checked-stamp"
        className="flex-none [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-faint)]"
      >
        {checkedWords(at, now)}
      </span>
    </Tooltip>
  )
}
