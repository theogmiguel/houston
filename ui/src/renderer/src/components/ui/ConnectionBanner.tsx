import type { ReactNode } from 'react'
import { BTN_GHOST_BG } from './buttonChrome'
import { Text } from './Text'

/** Floating banner for a lost connection: a pulsing status dot, a message and one retry action. */
export function ConnectionBanner({ message, actionLabel, onAction }: {
  message: ReactNode
  actionLabel: string
  onAction: () => void
}): React.JSX.Element {
  return (
    <div className="fixed top-[calc(var(--h-top)+var(--space-4))] left-1/2 -translate-x-1/2 z-[var(--z-toast)] flex items-start gap-[var(--space-2)] py-[var(--space-2)] px-[var(--space-2-5)] border border-[var(--warn-line)] rounded-[var(--tr-radius-button)] bg-[var(--warn-wash)] max-w-[var(--w-connection-banner-viewport-max)]" role="status">
      <span className="loop-anim flex-none w-[var(--space-2)] h-[var(--space-2)] rounded-[var(--tr-radius-pill)] bg-[var(--warn)] [--dot-pulse-opacity:var(--opacity-connection-dot-pulse)] motion-safe:[animation:var(--motion-connection-pulse)]" />
      <Text as="span" size="small" weight="medium" tone="primary" className="flex-1 min-w-0 whitespace-normal">{message}</Text>
      <button type="button" className={`btn ${BTN_GHOST_BG} flex-none border-0 p-0 text-[var(--accent-ink)] [font-size:var(--tr-text-small-size)] font-medium hover:bg-transparent hover:underline`} onClick={onAction}>{actionLabel}</button>
    </div>
  )
}
