import { Button } from './Button'
import { NumberField } from './NumberField'

export interface FontSizeControlProps {
  value: number
  min: number
  max: number
  defaultValue: number
  family: string
  onChange: (value: number) => void
  testId?: string
}

export function FontSizeControl({ value, min, max, defaultValue, family, onChange, testId }: FontSizeControlProps): React.JSX.Element {
  return <div className="flex items-center gap-[var(--space-2)]">
    <div className="px-[var(--space-2)] py-[var(--space-font-sample-y)] rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--content-bg)] text-[var(--text-primary)] leading-none overflow-hidden whitespace-nowrap" style={{ fontFamily: family, fontSize: `${value}px` }} data-testid="settings-font-preview">Il1O0</div>
    <NumberField width="compact" min={min} max={max} step={1} value={value} data-testid={testId} onChange={(event) => {
      const next = Math.trunc(Number(event.target.value))
      if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)))
    }} />
    <Button variant="legacy-ghost" disabled={value === defaultValue} onClick={() => onChange(defaultValue)}>Reset</Button>
  </div>
}

export function FontSizeControlSpecimen(): React.JSX.Element {
  return <FontSizeControl value={13} min={8} max={36} defaultValue={13} family="var(--font-mono)" onChange={() => {}} testId="font-size-specimen" />
}
