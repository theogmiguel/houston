import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { BTN_ICO } from './buttonChrome'

/** Pins a find strip to the top of the nearest scrolling ancestor; it takes no layout height. */
export function FindStripDock({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="sticky top-0 z-[calc(var(--z-pane)+3)] h-0 overflow-visible">{children}</div>
}

export function FindStripToggle({ pressed, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { pressed: boolean }): React.JSX.Element {
  return <button type="button" {...props} aria-pressed={pressed} className={`btn ${BTN_ICO} text-[length:var(--tr-text-xs)] font-mono aria-pressed:bg-[var(--selected-fill)]! aria-pressed:text-[var(--text-primary)]!`} />
}

export function FindStripCount({ children, ...props }: { children: ReactNode; 'data-testid'?: string }): React.JSX.Element {
  return <span {...props} aria-live="polite" className="min-w-[var(--w-terminal-find-count)] px-[var(--space-1)] text-center whitespace-nowrap font-mono text-[length:var(--tr-text-xs)] text-[var(--text-muted)]">{children}</span>
}
