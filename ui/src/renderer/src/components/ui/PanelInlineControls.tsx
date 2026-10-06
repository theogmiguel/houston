import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { CONTROL_SIZE_SQUARE_CLS } from '../controlSize'
import { Text } from './Text'
import { HIT_TARGET_28 } from '../hitTarget'

const ICON_BUTTON = `btn inline-flex items-center justify-center flex-none ${CONTROL_SIZE_SQUARE_CLS.mini} ${HIT_TARGET_28} rounded-[var(--tr-radius-sm)] border-0 bg-transparent text-[var(--text-secondary)] cursor-pointer [transition:color_var(--transition-panel-icon)_ease-out,background-color_var(--transition-panel-icon)_ease-out] hover:not-disabled:bg-[var(--hover-fill)] hover:not-disabled:text-[var(--text-primary)] disabled:text-[var(--text-faint)] disabled:opacity-55 disabled:cursor-default`

export interface PanelIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  danger?: boolean
}

/** A 22px quiet icon button (28px hit target) for rows and panel headers. */
export function PanelIconButton({ danger = false, type = 'button', className = '', ...props }: PanelIconButtonProps): React.JSX.Element {
  return <button {...props} type={type} className={`${ICON_BUTTON} ${danger ? 'hover:not-disabled:text-[var(--danger)]!' : ''} ${className}`} />
}


/** A one-line footnote under a panel, in the faintest ink. */
export function PanelFootnote({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text as="p" data-testid="nav-footnote" size="small" weight="small" leading="normal" tone="faint" className="pt-[var(--space-3)]">
      {children}
    </Text>
  )
}
