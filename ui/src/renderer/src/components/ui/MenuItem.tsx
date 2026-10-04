import { useId, type ButtonHTMLAttributes, type ReactNode } from 'react'

export interface MenuItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children' | 'type'> {
  children: ReactNode
  disabledReason?: string
}

const MENU_ITEM_CLS =
  'btn ctx-item group/menu-item border-none flex min-h-[var(--h-ctl-mini)] w-full items-center justify-between gap-[var(--space-3)] rounded-[var(--tr-radius-input)] bg-transparent px-[var(--space-2-5)] py-[var(--space-1)] text-left text-[length:var(--tr-text-small-size)] text-[var(--text-secondary)] hover:enabled:bg-[var(--card-hover)] hover:enabled:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-[var(--text-secondary)]'

export function MenuItem({ children, disabledReason = '', ...props }: MenuItemProps): React.JSX.Element {
  const descriptionId = useId()
  const describedBy = [props['aria-describedby'], descriptionId].filter(Boolean).join(' ')
  return (
    <button {...props} aria-describedby={describedBy} className={MENU_ITEM_CLS} role="menuitem" type="button">
      <span className="min-w-0 flex-1">{children}</span>
      <span id={descriptionId} className="hidden max-w-[180px] whitespace-normal text-right text-[length:var(--tr-text-xs)] text-[var(--text-faint)] group-disabled/menu-item:inline-flex">{disabledReason}</span>
    </button>
  )
}
