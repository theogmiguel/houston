import type { HTMLAttributes, ReactNode } from 'react'
import { Text } from './Text'

const DIVIDER = {
  solid: 'border-b-[var(--divider)]',
  borderMuted: 'border-b-[var(--pane-head-border-muted)]',
  dividerMuted: 'border-b-[var(--pane-head-divider-muted)]'
} as const

const TRANSITION = {
  background: '[transition:background_0.2s]',
  surface: '[transition:background_0.2s,border-color_0.2s]',
  browser: '[transition:background_0.2s,border-color_0.15s_ease]'
} as const

/** A draggable header row for a pane, with its focus surface supplied by PaneFocus. */
export function PaneHeader({ divider = 'solid', transition = 'background', inset = 'default', dragCursor = false, onPointerDown, children, ...props }: HTMLAttributes<HTMLElement> & {
  divider?: keyof typeof DIVIDER
  transition?: keyof typeof TRANSITION
  inset?: 'default' | 'compact'
  dragCursor?: boolean
  children: ReactNode
}): React.JSX.Element {
  const dragging = dragCursor ? '[.pane-slot.drag-src_&]:cursor-grabbing' : ''
  const padding = inset === 'default' ? 'pl-[var(--pane-head-leading-inset)]' : 'pl-[var(--space-2-5)]'
  return (
    <header
      {...props}
      onPointerDown={onPointerDown}
      className={`group pane-head touch-none flex items-center gap-2 pr-1 ${padding} h-[var(--h-pane-head)] min-h-[var(--h-pane-head)] border-b ${DIVIDER[divider]} flex-none cursor-grab active:cursor-grabbing ${dragging} ${TRANSITION[transition]} @container`}
    >
      {children}
    </header>
  )
}

export function PaneHeaderSpecimen(): React.JSX.Element {
  return <PaneHeader data-pane-focus-head="none"><Text>Pane title</Text></PaneHeader>
}
