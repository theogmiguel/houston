export type StatusIconState = 'ok' | 'differs' | 'off' | 'absent'

export const STATUS_ICON_WORD: Record<StatusIconState, string> = {
  ok: 'In sync',
  differs: 'Differs',
  off: 'Off',
  absent: 'Not there'
}

const COLOR: Record<StatusIconState, string> = {
  ok: 'var(--ok)',
  differs: 'var(--warn)',
  off: 'var(--text-muted)',
  absent: 'var(--text-faint)'
}

function Glyph({ state }: { state: StatusIconState }): React.JSX.Element {
  switch (state) {
    case 'ok':
      return (
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.75" />
          <path
            d="m8.5 12 2.5 2.5 4.5-5"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )
    case 'differs':
      return (
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 3 2.5 20h19z"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M12 9v5M12 17h.01" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        </svg>
      )
    case 'off':
      return (
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle
            cx="12"
            cy="12"
            r="9"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeDasharray="3 3"
          />
        </svg>
      )
    case 'absent':
      return (
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="4" fill="currentColor" />
        </svg>
      )
  }
}

export function StatusIcon({
  state,
  label
}: {
  state: StatusIconState
  label?: string
}): React.JSX.Element {
  return (
    <span
      data-testid="status-icon"
      data-state={state}
      className="inline-flex items-center gap-[4px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)]"
      style={{ color: COLOR[state] }}
    >
      <Glyph state={state} />
      {label && <span>{label}</span>}
    </span>
  )
}
