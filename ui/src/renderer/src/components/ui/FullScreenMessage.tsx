import type { ReactNode } from 'react'
import { Text } from './Text'
/** A viewport-filling message for states where the app itself cannot render. */
export function FullScreenMessage({ tone, children }: { tone: 'muted' | 'danger'; children: ReactNode }): React.JSX.Element {
  return (
    <div className={`h-screen flex flex-col items-center justify-center gap-[var(--space-fullscreen-message)] ${tone === 'danger' ? 'px-[var(--fullscreen-copy-inset-inline)] text-center text-[var(--danger)]' : 'text-[var(--text-muted)]'}`}>
      {children}
    </div>
  )
}

export function FullScreenMessageSpecimen(): React.JSX.Element {
  return (
    <div data-testid="full-screen-message-specimen" className="relative h-[var(--h-primitives-preview)] overflow-hidden [contain:paint]">
      <FullScreenMessage tone="danger"><Text as="p" flush>Halted: the app reloaded too many times.</Text></FullScreenMessage>
    </div>
  )
}
