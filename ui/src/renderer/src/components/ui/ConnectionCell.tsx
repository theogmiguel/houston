import { Button } from './Button'
import { StatusLabel, type StatusLabelValue } from './StatusLabel'

export type ConnectionCellStatus = Extract<StatusLabelValue, 'In sync' | 'Off' | 'Differs' | 'Failed'>

export function ConnectionCell({
  status,
  reason,
  showStatus = true,
  onClick,
  server,
  agent,
  'data-testid': testId
}: {
  status: ConnectionCellStatus
  reason?: string
  showStatus?: boolean
  onClick: () => void
  server: string
  agent: string
  'data-testid'?: string
}): React.JSX.Element {
  const action = status === 'Off' ? 'turn on' : 'turn off'
  const [command, ...details] = reason?.split(' ') ?? []
  return (
    <Button
      variant="text"
      size="sm"
      aria-label={`${action} ${server} for ${agent}`}
      data-testid={testId}
      onClick={onClick}
      className="flex min-w-0 flex-row items-center gap-[var(--space-1-5)] whitespace-normal"
    >
      {showStatus && <StatusLabel status={status} />}
      {status === 'Failed' && reason && <span className="min-w-0 break-words text-left text-[length:var(--tr-text-small-size)] leading-[var(--tr-text-small-leading)] text-[var(--text-muted)]"><code className="font-mono">{command}</code>{details.length > 0 && ` ${details.join(' ')}`}</span>}
    </Button>
  )
}
