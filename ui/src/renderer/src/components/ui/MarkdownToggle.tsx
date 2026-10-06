import type { ButtonHTMLAttributes, ReactNode } from 'react'

export function MarkdownToggle({ children, size = 'inline', className = '', ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & { children: ReactNode; size?: 'inline' | 'mini' | 'control'; className?: string }): React.JSX.Element {
  return <button {...props} className={`inline-flex items-center gap-1 px-1.5 py-0.5 flex-none rounded-[var(--tr-radius-sm)] border-none ${size === 'control' ? 'h-[var(--h-ctl)]' : size === 'mini' ? 'h-[var(--h-ctl-mini)]' : ''} bg-[color-mix(in_srgb,var(--card-bg)_60%,transparent)] text-[var(--text-secondary)] hover:bg-[var(--card-hover)] hover:text-[var(--text-primary)] ${className}`}>{children}</button>
}
