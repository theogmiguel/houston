import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { CONTROL_SIZE_SQUARE_CLS } from '../controlSize'
import { HIT_TARGET_28 } from '../hitTarget'
import { Text } from './Text'

const ICON_BUTTON = `btn inline-flex items-center justify-center flex-none ${CONTROL_SIZE_SQUARE_CLS.mini} ${HIT_TARGET_28} rounded-[var(--tr-radius-sm)] border-0 bg-transparent text-[var(--text-secondary)] cursor-pointer [transition:color_var(--transition-panel-icon)_ease-out,background-color_var(--transition-panel-icon)_ease-out] hover:not-disabled:bg-[var(--hover-fill)] hover:not-disabled:text-[var(--text-primary)] disabled:text-[var(--text-faint)] disabled:opacity-55 disabled:cursor-default`

export interface PanelIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  danger?: boolean
}

/** A 22px quiet icon button (28px hit target) for rows and panel headers. */
export function PanelIconButton({ danger = false, type = 'button', className = '', ...props }: PanelIconButtonProps): React.JSX.Element {
  return <button {...props} type={type} className={`${ICON_BUTTON} ${danger ? 'hover:not-disabled:text-[var(--danger)]!' : ''} ${className}`} />
}

export interface PanelSwitchProps {
  on: boolean
  disabled?: boolean
  label: string
  onChange: (next: boolean) => void
  testId?: string
}

/** A 30x17 on/off switch for panel rows. */
export function PanelSwitch({ on, disabled, label, onChange, testId }: PanelSwitchProps): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-testid={testId ?? 'nav-switch'}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`btn relative flex-none w-[var(--w-panel-switch)] h-[var(--h-switch-track)] p-0 rounded-full border cursor-pointer [transition:border-color_var(--transition-panel-switch)_ease-out,background-color_var(--transition-panel-switch)_ease-out] disabled:cursor-default disabled:opacity-55 ${HIT_TARGET_28} ${
        on
          ? 'border-[var(--panel-switch-border-on)] bg-[var(--accent)]'
          : 'border-[var(--border)] bg-[var(--hover-fill)]'
      }`}
    >
      <span
        className={`absolute top-[var(--space-panel-switch-inset)] left-[var(--space-panel-switch-inset)] w-[var(--h-panel-switch-thumb)] h-[var(--h-panel-switch-thumb)] rounded-full [transition:background-color_var(--transition-panel-switch)_ease-out,transform_var(--transition-panel-switch)_var(--ease-panel-switch)] ${
          on ? 'bg-[var(--accent-ink)] translate-x-[var(--space-panel-switch-travel)]' : 'bg-[var(--text-secondary)]'
        }`}
      />
    </button>
  )
}

/** A one-line footnote under a panel, in the faintest ink. */
export function PanelFootnote({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text as="p" data-testid="nav-footnote" size="small" weight="small" leading="normal" tone="faint" className="pt-[var(--space-3)]">
      {children}
    </Text>
  )
}

