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

export function SpinnerSpecimen(): React.JSX.Element {
  return <div className="flex items-center gap-[var(--space-2)]"><Spinner label="Waiting for the phone" /><span>Waiting for the phone…</span></div>
}
