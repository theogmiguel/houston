import { HIT_TARGET_28 } from '../hitTarget'

const TRACK = {
  field: 'w-[var(--w-switch-track)] h-[var(--h-switch-track)]',
  status: 'w-[var(--tr-switch-compact-width)] h-[var(--tr-switch-compact-height)]',
  configuration: 'w-[var(--w-switch-track)] h-[var(--h-switch-track)]',
  panel: 'w-[var(--w-panel-switch)] h-[var(--h-switch-track)]'
} as const

const THUMB = {
  field: 'top-[var(--space-switch-thumb-inset)] left-[var(--space-switch-thumb-inset)] w-[var(--sz-switch-thumb)] h-[var(--sz-switch-thumb)] [transition:background-color_0.14s_ease-out,transform_0.14s_cubic-bezier(0.22,1,0.36,1)]',
  status: 'top-[var(--space-switch-thumb-inset)] left-[var(--space-switch-thumb-inset)] w-[var(--tr-switch-compact-thumb)] h-[var(--tr-switch-compact-thumb)] [transition:background-color_var(--tr-motion-compact-switch)_ease-out,transform_var(--tr-motion-compact-switch)_cubic-bezier(0.22,1,0.36,1)]',
  configuration: 'top-[var(--space-switch-inset)] left-[var(--space-switch-inset)] w-[var(--w-switch-knob)] h-[var(--w-switch-knob)] [transition:background-color_0.14s_ease-out,transform_0.14s_cubic-bezier(0.22,1,0.36,1)]',
  panel: 'top-[var(--space-panel-switch-inset)] left-[var(--space-panel-switch-inset)] w-[var(--h-panel-switch-thumb)] h-[var(--h-panel-switch-thumb)] [transition:background-color_var(--transition-panel-switch)_ease-out,transform_var(--transition-panel-switch)_var(--ease-panel-switch)]'
} as const

const TRANSITION = {
  field: '[transition:border-color_0.14s_ease-out,background-color_0.14s_ease-out]',
  status: '[transition:border-color_var(--tr-motion-compact-switch)_ease-out,background-color_var(--tr-motion-compact-switch)_ease-out]',
  configuration: '[transition:border-color_0.14s_ease-out,background-color_0.14s_ease-out]',
  panel: '[transition:border-color_var(--transition-panel-switch)_ease-out,background-color_var(--transition-panel-switch)_ease-out]'
} as const

type SwitchSize = keyof typeof TRACK

export interface SwitchProps {
  on: boolean
  disabled?: boolean
  label: string
  onChange: (next: boolean) => void
  testId?: string
  size?: SwitchSize
}

export function Switch({ on, disabled, label, onChange, testId, size = 'field' }: SwitchProps): React.JSX.Element {
  const trackTone = size === 'panel'
    ? on ? 'border-[var(--panel-switch-border-on)] bg-[var(--accent)]' : 'border-[var(--border)] bg-[var(--hover-fill)]'
    : on ? 'border-[color-mix(in_srgb,var(--accent)_70%,transparent)] bg-[var(--accent)]' : 'border-[var(--border)] bg-[var(--hover-fill)]'
  const thumbPosition = size === 'status'
    ? on ? 'translate-x-[var(--tr-switch-compact-travel)]' : ''
    : size === 'configuration'
      ? on ? 'translate-x-[var(--space-switch-travel)]' : ''
      : size === 'panel'
        ? on ? 'translate-x-[var(--space-panel-switch-travel)]' : ''
        : on ? 'translate-x-[var(--space-switch-thumb-shift)]' : ''
  return <button type="button" role="switch" aria-checked={on} aria-label={label} data-testid={testId ?? (size === 'status' || size === 'configuration' ? undefined : 'nav-switch')} disabled={disabled} onClick={() => onChange(!on)} className={`btn relative flex-none ${TRACK[size]} p-0 rounded-full border cursor-pointer ${TRANSITION[size]} disabled:cursor-default disabled:opacity-55 ${HIT_TARGET_28} ${trackTone}`}><span aria-hidden={size === 'status' || undefined} className={`absolute ${THUMB[size]} rounded-full ${on ? `bg-[var(--accent-ink)] ${thumbPosition}` : 'bg-[var(--text-secondary)]'}`} /></button>
}
