import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'

export function WindowControlButton({ children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button {...props} className={`btn flex items-center justify-center w-[calc(var(--w-window-control)/var(--shell-zoom,1))] h-[calc(var(--h-top)/var(--shell-zoom,1))] p-0 rounded-none border-none bg-transparent text-[var(--text-primary)] cursor-pointer [-webkit-app-region:no-drag] ${className}`}>{children}</button>
}

export function WindowControlDisc({ children, tone, className = '', ...props }: HTMLAttributes<HTMLSpanElement> & { children: ReactNode; tone: 'close' | 'regular' }): React.JSX.Element {
  return <span {...props} className={`flex items-center justify-center w-[calc(var(--sz-window-control-disc)/var(--shell-zoom,1))] h-[calc(var(--sz-window-control-disc)/var(--shell-zoom,1))] rounded-[var(--tr-radius-sm)] bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] group-focus-visible/wc:outline-[var(--bw-window-control-focus)] group-focus-visible/wc:outline-[var(--focus-ring)] group-focus-visible/wc:outline-offset-1 motion-safe:transition-[background-color,color] motion-safe:duration-[var(--animate-t-fast)] ${tone === 'close' ? 'group-hover/wc:bg-[color-mix(in_srgb,var(--danger)_20%,transparent)] group-hover/wc:text-[var(--danger)] group-active/wc:bg-[color-mix(in_srgb,var(--danger)_30%,transparent)]' : 'group-hover/wc:bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] group-hover/wc:text-[color-mix(in_srgb,var(--accent)_75%,var(--text-primary))] group-active/wc:bg-[color-mix(in_srgb,var(--accent)_24%,transparent)]'} ${className}`}>{children}</span>
}

export function WindowResizeGrip({ className = '', ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className={`fixed z-[var(--z-window)] [-webkit-app-region:no-drag] ${className}`} />
}
