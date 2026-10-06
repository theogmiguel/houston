export const STATUS_LABELS = [
  'Working',
  'Needs input',
  'Idle',
  'Done',
  'Ended',
  'Failed',
  'Paused',
  'Stalled',
  'Result staged',
  'Pending delivery',
  'In sync',
  'Waiting for a slot',
  'Differs',
  'Off',
  'Missing',
  'Open',
  'Fixing',
  'Not seen',
  'Ready',
  'Watching',
  'Verified'
] as const

export type StatusLabelValue = (typeof STATUS_LABELS)[number]

const STATUS_DOT: Record<StatusLabelValue, string> = {
  Working: 'var(--info)',
  'Needs input': 'var(--warn)',
  Idle: 'var(--text-faint)',
  Done: 'var(--ok)',
  Ended: 'var(--info)',
  Failed: 'var(--stop)',
  Paused: 'var(--text-muted)',
  Stalled: 'var(--warn)',
  'Result staged': 'var(--info)',
  'Pending delivery': 'var(--info)',
  'In sync': 'var(--ok)',
  'Waiting for a slot': 'var(--warn)',
  Differs: 'var(--warn)',
  Off: 'var(--text-faint)',
  Missing: 'var(--text-faint)',
  Open: 'var(--warn)',
  Fixing: 'var(--info)',
  'Not seen': 'var(--text-faint)',
  Ready: 'var(--ok)',
  Watching: 'var(--info)',
  Verified: 'var(--ok)'
}

const STATUS_TEXT: Partial<Record<StatusLabelValue, string>> = {
  Off: 'text-[var(--text-muted)]'
}

type PillTone = 'waiting' | 'failed' | 'done' | 'working' | 'unknown'

const PILL_CLASS = 'inline-flex items-center h-[17px] px-2 rounded-[var(--tr-radius-sm)] flex-none [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase'
const PILL_TONE: Record<PillTone, string> = {
  waiting: 'bg-[var(--status-todo-bg)] text-[var(--status-todo-text)]',
  failed: 'bg-[var(--status-blocked-bg)] text-[var(--status-blocked-text)]',
  done: 'bg-[var(--status-done-bg)] text-[var(--status-done-text)]',
  working: 'bg-[var(--status-doing-bg)] text-[var(--status-doing-text)]',
  unknown: 'bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] text-[var(--text-muted)]'
}

export function StatusLabel({ status, size = 'ui', variant = 'default', tone = 'unknown', children }: { status: StatusLabelValue; size?: 'ui' | 'small'; variant?: 'default' | 'pill' | 'dot'; tone?: PillTone; children?: React.ReactNode }): React.JSX.Element {
  if (variant === 'pill') return <span className={`${PILL_CLASS} ${PILL_TONE[tone]}`}>{children ?? status}</span>
  const hollow = status === 'Idle' || status === 'Paused' || status === 'Missing' || status === 'Not seen' || status === 'Off'
  return (
    <span role={variant === 'dot' ? 'img' : undefined} aria-label={status} className={`inline-flex items-center gap-[var(--space-1-5)] text-[var(--text-secondary)] ${STATUS_TEXT[status] ?? ''} ${size === 'small' ? 'text-[length:var(--tr-text-small-size)]' : ''}`}>
      <span
        aria-hidden="true"
        className="agent-dot h-[var(--space-1-5)] w-[var(--space-1-5)] flex-none rounded-full"
        style={hollow
          ? { backgroundColor: 'transparent', border: '1px solid var(--text-faint)' }
          : { backgroundColor: STATUS_DOT[status] }}
      />
      {variant === 'default' && status}
    </span>
  )
}
