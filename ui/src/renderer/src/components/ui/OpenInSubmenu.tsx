import type { HTMLAttributes, ReactNode } from 'react'
import { Icon } from './Icon'
import { IconChevronRight } from '../icons'

export function OpenInSubmenu({ children, className = '', ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <div {...props} className={`fixed min-w-[var(--w-open-in-submenu)] flex flex-col p-1 rounded-[var(--tr-radius-md)] border border-[var(--border)] bg-[var(--raised)] shadow-[var(--shadow-1)] z-[var(--z-context)] motion-safe:animate-[menu-in_var(--animate-t-panel)_var(--animate-ease-menu)] ${className}`}>{children}</div>
}

export function OpenInChevron(): React.JSX.Element {
  return <Icon glyph={IconChevronRight} role="small" className="flex-none text-[var(--text-faint)]" />
}
