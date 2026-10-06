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
    <Text as="div" size="small" weight="small" tone="blocked" className="fixed top-[calc(var(--h-top)+var(--space-4))] left-1/2 -translate-x-1/2 z-[var(--z-toast)] flex items-center gap-[var(--space-2)] py-[var(--space-1-5)] px-[var(--space-connection-banner-inline)] border border-[var(--status-blocked-text)] rounded-[var(--tr-radius-pill)] bg-[var(--card-bg)] shadow-[var(--shadow-md)] max-w-[var(--w-connection-banner-viewport-max)]" role="status">
      <span className="loop-anim flex-none w-[var(--space-2)] h-[var(--space-2)] rounded-[var(--tr-radius-pill)] bg-[var(--danger)] [--dot-pulse-opacity:var(--opacity-connection-dot-pulse)] motion-safe:[animation:var(--motion-connection-pulse)]" />
      <span>{message}</span>
      <button type="button" className={`btn ${BTN_GHOST_BG} text-inherit border border-current py-[var(--space-pixel)] px-[var(--space-2)]`} onClick={onAction}><Text size="small" weight="small" className="contents">{actionLabel}</Text></button>
    </Text>
  )
}
