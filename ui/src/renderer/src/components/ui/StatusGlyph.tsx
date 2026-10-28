export type StatusGlyphState = 'working' | 'needs' | 'finished' | 'error' | 'idle'

// Every status vocabulary Houston shows: agent lifecycle, rail grid roll-up,
// child classification and the roster's ended marker.
export type StatusGlyphSource =
  | 'spawning'
  | 'starting'
  | 'working'
  | 'needs-input'
  | 'idle'
  | 'unavailable'
  | 'exited'
  | 'stopped'
  | 'done'
  | 'failed'
  | 'Needs input'
  | 'Asked orchestrator'
  | 'Working'
  | 'Idle'
  | 'Done'
  | 'Failed'
  | 'Ended'
  | 'Stalled'
  | 'Result staged'
  | null

const STATE_BY_SOURCE: Record<Exclude<StatusGlyphSource, null | 'exited'>, StatusGlyphState> = {
  spawning: 'working',
  starting: 'working',
  working: 'working',
  Working: 'working',
  'needs-input': 'needs',
  'Needs input': 'needs',
  Stalled: 'needs',
  done: 'finished',
  Done: 'finished',
  Ended: 'finished',
  'Result staged': 'finished',
  failed: 'error',
  Failed: 'error',
  idle: 'idle',
  Idle: 'idle',
  unavailable: 'idle',
  stopped: 'idle',
  'Asked orchestrator': 'idle'
}

export function statusGlyphState(status: StatusGlyphSource, exitCode?: number | null): StatusGlyphState {
  if (status === 'exited') return exitCode === 0 ? 'finished' : 'error'
  return status === null ? 'idle' : STATE_BY_SOURCE[status]
}

const SHAPE: Record<Exclude<StatusGlyphState, 'idle'>, string> = {
  working:
    'loop-anim h-[9px] w-[9px] rounded-full border-[1.5px] border-[var(--accent-ink)] border-r-transparent motion-safe:animate-[spin_0.9s_linear_infinite]',
  needs:
    'h-[8px] w-[8px] rounded-full bg-[var(--warn)] shadow-[var(--shadow-status-ring)]',
  finished: 'h-[6px] w-[6px] rounded-full bg-[var(--accent-ink)]',
  error:
    'inline-grid h-[11px] w-[11px] place-items-center rounded-full bg-[var(--stop)] [font-size:var(--tr-icon-error-mark-size)] font-extrabold leading-[11px] text-[var(--rail-bg)]'
}

const MARK: Partial<Record<Exclude<StatusGlyphState, 'idle'>, string>> = { error: '!' }

function StatusGlyphMark({ state }: { state: Exclude<StatusGlyphState, 'idle'> }): React.JSX.Element {
  return <span aria-hidden className={SHAPE[state]}>{MARK[state]}</span>
}

export function StatusGlyph({ state, label }: { state: StatusGlyphState; label?: string }): React.JSX.Element | null {
  if (state === 'idle') return null
  const name = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const }
  return (
    <span data-status-glyph={state} data-state={state} {...name} className="inline-grid h-[14px] w-[14px] flex-none place-items-center">
      <StatusGlyphMark state={state} />
    </span>
  )
}

const STATES: readonly StatusGlyphState[] = ['working', 'needs', 'finished', 'error', 'idle']

export function StatusGlyphSpecimen(): React.JSX.Element {
  return (
    <div className="grid gap-[var(--space-2)]">
      {(['graphite', 'paper'] as const).map((theme) => (
        <div
          key={theme}
          data-theme={theme}
          className="flex flex-wrap items-center gap-[var(--space-4)] border border-[var(--border)] bg-[var(--content-bg)] p-[var(--space-2)] text-[var(--text-primary)]"
        >
          <span className="w-[52px] [font-size:var(--tr-text-small-size)] text-[var(--text-muted)]">{theme}</span>
          {STATES.map((state) => (
            <span key={state} className="inline-flex items-center gap-[var(--space-1-5)] [font-size:var(--tr-text-small-size)]">
              <StatusGlyph state={state} label={state} />
              {state}
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}
