import { useEffect, useState } from 'react'

export { SectionHead, SubHead, Group, SettingsRow as Row } from '../settingsPrimitives'

// Deliberately does not clamp the typed value before sending — the daemon is
// the authority on this limit and its refusal already names it; clamping
// here would silently swallow that refusal.
export function NumberSetting({
  value,
  max,
  min = 0,
  unit,
  testId,
  onCommit
}: {
  value: number
  max: number
  min?: number
  unit: string
  testId?: string
  onCommit: (n: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (): void => {
    const n = Math.trunc(Number(draft))
    if (!Number.isFinite(n)) {
      setDraft(String(value))
      return
    }
    if (n !== value) onCommit(n)
  }
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        className="w-[64px] bg-[var(--content-bg)] border border-[var(--border)] rounded-md text-[var(--text-primary)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] py-[5px] px-2 text-right"
        min={min}
        max={max}
        step={1}
        value={draft}
        data-testid={testId}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
      <span className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)] whitespace-nowrap">{unit}</span>
    </div>
  )
}

export function ClampedNumberSetting({
  value,
  min,
  max,
  step,
  unit,
  integer,
  testId,
  onCommit
}: {
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  integer?: boolean
  testId: string
  onCommit: (n: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(value))
  const [rejected, setRejected] = useState<string | null>(null)
  useEffect(() => setDraft(String(value)), [value])
  const unitSuffix = unit ? ` ${unit}` : ''
  const commit = (): void => {
    const raw = Number(draft)
    const n = integer ? Math.trunc(raw) : raw
    if (!Number.isFinite(n)) {
      setDraft(String(value))
      return
    }
    if (n < min || n > max) {
      setRejected(`${n}${unitSuffix} is outside ${min}–${max}${unitSuffix} — kept at ${value}${unitSuffix}`)
      setDraft(String(value))
      return
    }
    setRejected(null)
    if (n !== value) onCommit(n)
  }
  return (
    <div className="flex flex-col items-end gap-[var(--space-1)]">
      <div className="flex items-center gap-2">
        <input
          type="number"
          className="w-[72px] bg-[var(--content-bg)] border border-[var(--border)] rounded-md text-[var(--text-primary)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] py-[5px] px-2 text-right"
          min={min}
          max={max}
          step={step ?? 1}
          value={draft}
          data-testid={testId}
          onChange={(e) => {
            setDraft(e.target.value)
            setRejected(null)
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        {unit && <span className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)] whitespace-nowrap">{unit}</span>}
      </div>
      {rejected && (
        <div
          className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--danger)] max-w-[220px] text-right"
          data-testid={`${testId}-rejected`}
        >
          {rejected}
        </div>
      )}
    </div>
  )
}
