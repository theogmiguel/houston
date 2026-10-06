import { SettingsButton } from './SettingsButtonRoles'

export interface LevelThresholdControlProps {
  value: number
  level: number | null
  defaultValue: number
  maxValue: number
  maxLevel: number
  onChange: (value: number) => void
  testId: string
  meterTestId: string
}

export function LevelThresholdControl({ value, level, defaultValue, maxValue, maxLevel, onChange, testId, meterTestId }: LevelThresholdControlProps): React.JSX.Element {
  return (
    <div className="w-[var(--tr-voice-meter-width)] flex flex-col gap-1.5">
      <div className="relative h-2 rounded-full overflow-hidden bg-[color-mix(in_srgb,var(--text-muted)_22%,transparent)]" data-testid={meterTestId} aria-hidden>
        <div className="h-full w-full origin-left [transition:transform_var(--motion-meter-frame)_linear]" style={{ transform: `scaleX(${Math.min(1, (level ?? 0) / maxLevel)})`, background: (level ?? 0) >= value ? 'var(--success)' : 'var(--text-muted)' }} />
        <div className="absolute top-[calc(var(--tr-voice-meter-marker-width)*-1)] bottom-[calc(var(--tr-voice-meter-marker-width)*-1)] w-[var(--tr-voice-meter-marker-width)] bg-[var(--text-primary)]" style={{ left: `${Math.min(100, (value / maxLevel) * 100)}%` }} />
      </div>
      <input type="range" className="w-full" data-testid={testId} min={0} max={maxValue} step={0.001} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      <div className="flex items-center justify-between [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] text-[var(--text-faint)] tabular-nums">
        <span>threshold {value.toFixed(3)}{value === defaultValue ? ' (default)' : ''}</span>
        {value === defaultValue ? (
          <span>{level === null ? 'no signal' : level.toFixed(3)}</span>
        ) : (
          <SettingsButton type="button" variant="label-action" onClick={() => onChange(defaultValue)}>Reset</SettingsButton>
        )}
      </div>
    </div>
  )
}

export function LevelThresholdControlSpecimen(): React.JSX.Element {
  return <div style={{ display: 'grid', gap: 'var(--space-2)' }}><LevelThresholdControl value={0.04} level={0.07} defaultValue={0.01} maxValue={0.25} maxLevel={0.5} onChange={() => {}} testId="level-threshold-specimen" meterTestId="level-threshold-track-specimen" /><LevelThresholdControl value={0.01} level={null} defaultValue={0.01} maxValue={0.25} maxLevel={0.5} onChange={() => {}} testId="level-threshold-default-specimen" meterTestId="level-threshold-track-default-specimen" /></div>
}
