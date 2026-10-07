import type { HTMLAttributes, ReactNode } from 'react'
import './floatingSurface.css'
import { Icon } from './Icon'
import { IconChevronRight } from '../icons'

export function OpenInSubmenu({ children, className = '', ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <div {...props} className={`fixed min-w-[var(--w-open-in-submenu)] flex flex-col p-1 floating-glass floating-pop-in z-[var(--z-context)] ${className}`}>{children}</div>
}

export function OpenInChevron(): React.JSX.Element {
  return <Icon glyph={IconChevronRight} role="small" className="flex-none text-[var(--text-faint)]" />
}
