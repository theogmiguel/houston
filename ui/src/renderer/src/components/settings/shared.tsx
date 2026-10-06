import { useEffect, useState } from 'react'
import { NumberField, NumberFieldMessage, NumberFieldUnit } from '../ui/NumberField'

export { SectionHead, SubHead, Group, SettingsRow as Row } from '../ui/settingsPrimitives'

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
    <div className="flex items-center gap-[var(--space-2)]">
      <NumberField
        width="compact"
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
      <NumberFieldUnit>{unit}</NumberFieldUnit>
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
      <div className="grid justify-items-end gap-[var(--space-1)]">
      <div className="flex items-center gap-[var(--space-2)]">
        <NumberField
          width="medium"
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
        {unit && <NumberFieldUnit>{unit}</NumberFieldUnit>}
      </div>
      {rejected && (
        <NumberFieldMessage testId={`${testId}-rejected`}>{rejected}</NumberFieldMessage>
      )}
    </div>
  )
}
