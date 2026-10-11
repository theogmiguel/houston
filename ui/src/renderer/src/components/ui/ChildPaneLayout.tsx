import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { BTN_GHOST, BTN_ICO_STRUCTURE } from './buttonChrome'
import { Text } from './Text'
import { Notice } from './Notice'

export function PeekTerminalLayer({ sessionId, hidden, children }: { sessionId: number; hidden: boolean; children: ReactNode }): React.JSX.Element {
  return <div data-peek-session={sessionId} className="absolute inset-0 flex flex-col min-w-0 min-h-0" aria-hidden={hidden} style={hidden ? { visibility: 'hidden', pointerEvents: 'none' } : undefined}>{children}</div>
}

export function ChildPaneLayoutSpecimen(): React.JSX.Element {
  return <div className="relative h-[var(--h-roster-specimen)] overflow-hidden border border-[var(--divider)]">
    <PeekTerminalLayer sessionId={1} hidden={false}><Notice tone="warn" inset="compact-inline">Needs you · Permission escalated by the orchestrator</Notice><div className="flex-1 min-h-0 p-[var(--space-2)] bg-[var(--terminal-frame-bg)]"><Text mono size="small">Agent terminal remains available for input.</Text></div></PeekTerminalLayer>
  </div>
}

export function ChildrenColumn({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex-1 min-w-0 min-h-0 flex flex-col">{children}</div>
}

export function PeekBarButton({ shrink = false, ...rest }: { shrink?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button {...rest} className={`btn border-none bg-transparent min-h-[var(--h-ctl)] ${shrink ? 'shrink-0' : 'truncate'}`} />
}

export function PeekBarIconButton(props: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button {...props} className={`${BTN_ICO_STRUCTURE} min-w-[var(--h-ctl)] min-h-[var(--h-ctl)]`} />
}

/** The footer under a settled child's terminal. */
export function SettledChildFooter({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text
      as="footer"
      aria-label="Settled child"
      size="small" tone="muted"
      className="absolute inset-x-0 bottom-0 flex items-center flex-wrap gap-[var(--space-1)] px-[var(--space-2)] py-[var(--space-1)] border-t border-[var(--divider)] bg-[var(--card-bg)]"
    >
      {children}
    </Text>
  )
}

export function SettledChildButton(props: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button {...props} className={`${BTN_GHOST} btn min-h-[var(--h-ctl)] shrink-0`} />
}

/** The dismissible note under the header that says why a pane started fresh. */
