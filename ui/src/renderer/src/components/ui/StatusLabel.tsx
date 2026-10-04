export const STATUS_LABELS = [
  'Working',
  'Needs input',
  'Idle',
  'Done',
  'Failed',
  'Paused',
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
  Failed: 'var(--stop)',
  Paused: 'var(--text-muted)',
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

export function StatusLabel({ status, size = 'ui' }: { status: StatusLabelValue; size?: 'ui' | 'small' }): React.JSX.Element {
  const hollow = status === 'Idle' || status === 'Paused' || status === 'Missing' || status === 'Not seen' || status === 'Off'
  return (
    <span aria-label={status} className={`inline-flex items-center gap-[var(--space-1-5)] text-[var(--text-secondary)] ${STATUS_TEXT[status] ?? ''} ${size === 'small' ? 'text-[length:var(--tr-text-small-size)]' : ''}`}>
      <span
        aria-hidden="true"
        className="h-[var(--space-1-5)] w-[var(--space-1-5)] flex-none rounded-full"
        style={hollow
          ? { backgroundColor: 'transparent', border: '1px solid var(--text-faint)' }
          : { backgroundColor: STATUS_DOT[status] }}
      />
      {status}
    </span>
  )
}
