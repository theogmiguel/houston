import type { ButtonHTMLAttributes, ReactNode } from 'react'
import './floatingSurface.css'

export function GitToolMenuSurface({ children }: { children: ReactNode }): React.JSX.Element {
  return <div role="menu" data-testid="git-tools-items" className="absolute right-0 top-[calc(100%+4px)] z-[var(--z-sticky)] min-w-[190px] flex flex-col floating-glass floating-pop-in py-1 [transform-origin:right_top]">{children}</div>
}

export function GitToolMenuItem({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button {...props} type="button" role="menuitem" className="flex items-center gap-2 w-full text-left px-2.5 py-1.5 text-[length:var(--tr-text-sm)] bg-transparent border-0 text-[var(--text-secondary)] enabled:hover:bg-[var(--card-hover)] disabled:opacity-45 disabled:cursor-not-allowed whitespace-nowrap">{children}</button>
}

export function GitToolMenuSeparator(): React.JSX.Element {
  return <div className="my-1 h-px bg-[var(--divider)]" role="separator" />
}
