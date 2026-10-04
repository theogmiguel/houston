import { Button } from './Button'
import { StatusLabel, type StatusLabelValue } from './StatusLabel'

export type ConnectionCellStatus = Extract<StatusLabelValue, 'In sync' | 'Off' | 'Differs' | 'Failed'>

export function ConnectionCell({
  status,
  reason,
  onClick,
  server,
  agent,
  'data-testid': testId
}: {
  status: ConnectionCellStatus
  reason?: string
  onClick: () => void
  server: string
  agent: string
  'data-testid'?: string
}): React.JSX.Element {
  const action = status === 'Off' ? 'turn on' : 'turn off'
  return (
    <Button
      variant="text"
      size="sm"
      aria-label={`${action} ${server} for ${agent}`}
      data-testid={testId}
      onClick={onClick}
      className="flex min-w-0 flex-col items-start gap-[var(--space-1)] whitespace-normal"
    >
      <StatusLabel status={status} />
      {status === 'Failed' && reason && <span className="block break-words text-left text-[length:var(--tr-text-small-size)] leading-[var(--tr-text-small-leading)] text-[var(--text-muted)]">{reason}</span>}
    </Button>
  )
}
