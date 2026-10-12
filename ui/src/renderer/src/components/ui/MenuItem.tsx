import { ROW_STATE } from './rowState'
import { useId, type ButtonHTMLAttributes, type ReactNode } from 'react'

export interface MenuItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children' | 'type'> {
  children: ReactNode
  disabledReason?: string
  shortcut?: ReactNode
}

const MENU_ITEM_CLS =
  'btn ctx-item group/menu-item border-none flex min-h-[var(--h-ctl-mini)] w-full items-center justify-between gap-[var(--space-3)] rounded-[var(--tr-radius-input)] px-[var(--space-2-5)] py-[var(--space-1)] text-left text-[length:var(--tr-text-small-size)] disabled:cursor-not-allowed disabled:hover:disabled:hover:text-[var(--text-secondary)]'

export function MenuItem({ children, disabledReason = '', shortcut, ...props }: MenuItemProps): React.JSX.Element {
  const descriptionId = useId()
  const describedBy = [props['aria-describedby'], descriptionId].filter(Boolean).join(' ')
  return (
    <button {...props} aria-describedby={describedBy} className={`${MENU_ITEM_CLS} ${ROW_STATE.rest}`} role="menuitem" type="button">
      <span className="min-w-0 flex-1">{children}</span>
      {shortcut && <span className="flex-none text-[length:var(--tr-text-xs)] text-[var(--text-faint)]">{shortcut}</span>}
      <span id={descriptionId} className="hidden max-w-[180px] whitespace-normal text-right text-[length:var(--tr-text-xs)] text-[var(--text-faint)] group-disabled/menu-item:inline-flex">{disabledReason}</span>
    </button>
  )
}
