import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import { BTN_ICO } from './buttonChrome'
export function TerminalFindStrip({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="absolute top-[var(--space-1-5)] right-[var(--space-2-5)] z-[calc(var(--z-pane)+3)] flex items-center gap-[var(--space-terminal-find-gap)] py-[var(--space-terminal-find-block)] px-[var(--space-1)] bg-[var(--card-bg)] border border-border rounded-[var(--tr-radius-sm)] shadow-[var(--shadow-md)]">
      {children}
    </div>
  )
}

export function TerminalFindInput(props: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return (
    <input
      {...props}
      className="find-input w-[var(--w-terminal-find-input)] bg-[var(--content-bg)] border border-border rounded-[var(--tr-radius-sm)] text-text-primary [font-style:inherit] [font-variant:inherit] [font-weight:inherit] [font-stretch:inherit] [line-height:inherit] [font-family:inherit]! text-[length:var(--tr-text-sm)] py-[var(--space-terminal-find-block)] px-[var(--space-2)] focus:outline-none focus:[border-color:var(--accent)] focus-visible:[border-color:var(--accent)]"
    />
  )
}

export function TerminalFindButton(props: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button {...props} className={`btn ${BTN_ICO}`} />
}
