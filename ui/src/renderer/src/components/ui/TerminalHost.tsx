import type { HTMLAttributes, ReactNode, Ref } from 'react'
import './TerminalHost.css'
/** The pane's terminal column; `data-typeable` marks the moment keystrokes reach the PTY. */
export function TerminalSurface({ children, ...rest }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div {...rest} className="flex-1 min-h-0 relative flex flex-col">
      {children}
    </div>
  )
}

/** The terminal engine's mount point: it owns selection, and drags pass pointer events through. */
export function TerminalHost({ hostRef }: { hostRef: Ref<HTMLDivElement> }): React.JSX.Element {
  return (
    <div
      ref={hostRef}
      className="term-host flex-1 min-h-0 pt-[var(--space-1-5)] pr-[var(--space-1-5)] pb-[var(--space-1)] pl-[var(--space-2)] overscroll-contain [.layout.dragging_&]:pointer-events-none [.layout.resizing_&]:pointer-events-none"
    />
  )
}
