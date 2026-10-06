export type ActivityDotState = 'starting' | 'working' | 'needs-input' | 'idle' | 'unavailable' | 'stopped'

const COLOR: Record<ActivityDotState, string> = {
  working: 'var(--info)',
  starting: 'var(--accent)',
  'needs-input': 'var(--warning)',
  idle: 'var(--text-muted)',
  unavailable: 'transparent',
  stopped: 'var(--text-faint)'
}

export function ActivityDot({ state, label, active = false }: { state: ActivityDotState; label: string; active?: boolean }): React.JSX.Element {
  return <span role="img" aria-label={label} data-testid="grid-state-dot" data-state={state} className={`w-[var(--sz-grid-state-dot)] h-[var(--sz-grid-state-dot)] rounded-full flex-none ${active ? 'loop-anim [--dot-pulse-opacity:var(--opacity-grid-state-pulse)] motion-safe:animate-[dot-pulse_var(--t-grid-state-pulse)_steps(4,end)_infinite]' : ''}`} style={{ background: COLOR[state], boxShadow: state === 'unavailable' ? 'inset 0 0 0 1px var(--text-faint)' : undefined, opacity: state === 'stopped' ? 'var(--opacity-grid-state-stopped)' : undefined }} />
}

export function ActivityDotSpecimen(): React.JSX.Element {
  return <div className="flex items-center gap-[var(--space-2)]"><ActivityDot state="working" label="Working" active /><ActivityDot state="needs-input" label="Needs input" /><ActivityDot state="unavailable" label="Status unavailable" /></div>
}
