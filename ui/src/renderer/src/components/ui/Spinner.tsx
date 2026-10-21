/** A 12 px indeterminate ring in the current text colour, for inline "waiting" lines. */
export function Spinner({ label = 'Loading' }: { label?: string }): React.JSX.Element {
  return (
    <span
      role="status"
      aria-label={label}
      className="inline-block h-[12px] w-[12px] flex-none animate-spin motion-reduce:animate-none rounded-full border-2 border-current border-t-transparent opacity-70"
    />
  )
}

/** A 9 px accent ring with a fading tail; it turns for the whole working state, however long the turn. */
export function WorkingSpinner({ label, testId, state }: { label?: string; testId?: string; state?: string }): React.JSX.Element {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-testid={testId}
      data-state={state}
      className="loop-anim inline-block size-[9px] flex-none rounded-full animate-[spin_0.9s_linear_infinite] motion-reduce:animate-none bg-[conic-gradient(from_0deg,transparent,color-mix(in_srgb,var(--accent)_12%,transparent)_60deg,var(--accent))] [mask:radial-gradient(farthest-side,transparent_calc(100%-1.75px),var(--accent)_calc(100%-1.5px))]"
    />
  )
}

export function SpinnerSpecimen(): React.JSX.Element {
  return <div className="flex items-center gap-[var(--space-2)]"><Spinner label="Waiting for the phone" /><span>Waiting for the phone…</span><WorkingSpinner label="Working" /><span>Working</span></div>
}
