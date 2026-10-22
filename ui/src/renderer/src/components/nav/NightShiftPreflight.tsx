import { useEffect, useState } from 'react'
import type { PreflightItem } from '../../houston/generated/PreflightItem'
import { Button, Card, Segmented, Text } from '../ui'
import { DialogActions, DialogBackdrop, DialogBody, DialogPanel, DialogTitle } from '../ui/Dialog'
import { StatusLabel } from '../ui/StatusLabel'
import { durationLabel } from './nightShiftFormat'

export const DURATIONS = [20, 60, 120, 240, 480] as const
type Duration = (typeof DURATIONS)[number]

const STATUS: Record<PreflightItem['status'], 'Ready' | 'Blocked' | 'Stale'> = { ok: 'Ready', warn: 'Stale', block: 'Blocked' }
const STATUS_TEXT: Record<PreflightItem['status'], string> = { ok: 'OK', warn: 'Warning', block: 'Blocks the run' }

/** Run now: the duration, every preflight item, and Start only when nothing blocks. */
export function NightShiftPreflight({ items, onDuration, onStart, onCancel, now }: {
  /** `null` while preflight runs for the chosen duration. */
  items: PreflightItem[] | null
  onDuration: (untilMs: number) => void
  onStart: (untilMs: number) => void
  onCancel: () => void
  now: number
}): React.JSX.Element {
  const [minutes, setMinutes] = useState<Duration>(240)
  const until = now + minutes * 60_000
  useEffect(() => { onDuration(now + minutes * 60_000) }, [minutes]) // eslint-disable-line react-hooks/exhaustive-deps
  const blocking = items?.filter((i) => i.status === 'block').length ?? 0
  const startLabel = items === null ? 'Checking…' : blocking > 0 ? `Fix ${blocking} ${blocking === 1 ? 'item' : 'items'} to start` : 'Start'
  return (
    <DialogBackdrop onMouseDown={onCancel}>
      <DialogPanel size="wide" role="dialog" aria-modal="true" aria-labelledby="night-preflight-title" onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onCancel() }}>
        <DialogTitle id="night-preflight-title">Run Night shift now</DialogTitle>
        <DialogBody variant="stacked">
          <div className="grid gap-[var(--space-1)]">
            <Text size="small" tone="muted">Duration</Text>
            <Segmented aria-label="Duration" size="xs" value={String(minutes)}
              options={DURATIONS.map((d) => ({ value: String(d), label: durationLabel(d) }))}
              onChange={(v) => setMinutes(Number(v) as Duration)} />
            <Text size="small" tone="muted">Wrap-up {minutes < 60 ? `at ${Math.round(minutes * 0.75)} min` : '45 min before the end'}; every pane closes at the end.</Text>
          </div>
          <Card aria-label="Preflight">
            {items === null ? <Card.Row heading={<Text role="status" tone="muted">Running preflight…</Text>} /> : items.map((item) => (
              <Card.Row key={item.id} heading={item.label}
                meta={<span data-testid={`preflight-${item.id}`}>{item.detail}{item.limit && item.actual ? ` (limit ${item.limit}, actual ${item.actual})` : ''}</span>}
                status={<StatusLabel status={STATUS[item.status]} size="small">{STATUS_TEXT[item.status]}</StatusLabel>} />
            ))}
          </Card>
        </DialogBody>
        <DialogActions>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" data-testid="night-preflight-start" disabled={items === null || blocking > 0} onClick={() => onStart(until)}>{startLabel}</Button>
        </DialogActions>
      </DialogPanel>
    </DialogBackdrop>
  )
}
