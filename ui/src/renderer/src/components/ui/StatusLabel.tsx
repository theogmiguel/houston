export const STATUS_LABELS = [
  'Working',
  'Needs input',
  'Idle',
  'Done',
  'Failed',
  'Paused',
  'In sync',
  'Missing'
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
  Missing: 'var(--text-faint)'
}

export function StatusLabel({ status }: { status: StatusLabelValue }): React.JSX.Element {
  const hollow = status === 'Idle' || status === 'Paused' || status === 'Missing'
  return (
    <span aria-label={status} className="inline-flex items-center gap-[var(--space-1-5)] text-[var(--text-secondary)]">
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
