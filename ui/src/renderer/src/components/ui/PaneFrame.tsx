import type { HTMLAttributes, ReactNode, Ref } from 'react'
import type { PaneFocusTier } from '../../windowFocus'
import { BORDER_HAIRLINE_INSET_TRANSPARENT } from './shadowChrome'
import './paneFocus.css'

/** Ground and the marker classes that tests and descendant selectors (inspector.css, editorHost.css) key on. */
const KIND = {
  session: 'bg-[var(--terminal-frame-bg)]',
  editor: `editor-leaf bg-[var(--pane-bg)] after:content-[''] after:absolute after:inset-0 after:rounded-[inherit] after:pointer-events-none after:z-[var(--z-base)] after:shadow-[${BORDER_HAIRLINE_INSET_TRANSPARENT}]`,
  files: 'files-pane bg-[var(--pane-bg)]',
  'files-panel': 'files-pane files-panel bg-[var(--pane-bg)]',
  skills: 'skills-leaf @container/rpanel bg-[var(--pane-bg)]'
} as const

export type PaneFrameKind = keyof typeof KIND

export type PaneFrameProps = Omit<HTMLAttributes<HTMLElement>, 'className'> & {
  kind: PaneFrameKind
  focusTier: PaneFocusTier
  active: boolean
  /** An ended session steps back to 80% opacity. */
  dimmed?: boolean
  ref?: Ref<HTMLElement>
  children: ReactNode
}

/** A grid pane's outer frame: focus-tier border (paneFocus.css), ground, narrow-pane corner. */
export function PaneFrame({ kind, focusTier, active, dimmed = false, children, ...rest }: PaneFrameProps): React.JSX.Element {
  return (
    <section
      {...rest}
      data-pane-focus-border={focusTier}
      className={`pane ${KIND[kind]} flex-1 min-w-0 min-h-0 relative flex flex-col overflow-hidden [@container_(max-width:280px)]:rounded-[var(--tr-radius-sm)] ${dimmed ? 'opacity-80' : ''} ${active ? 'focus' : ''}`}
    >
      {children}
    </section>
  )
}

export function PaneFrameSpecimen(): React.JSX.Element {
  return (
    <div data-testid="pane-frame-specimen" className="grid grid-cols-3 gap-[var(--space-3)] h-[var(--h-markdown-specimen)]">
      <PaneFrame kind="session" focusTier="full" active>{null}</PaneFrame>
      <PaneFrame kind="editor" focusTier="dim" active={false}>{null}</PaneFrame>
      <PaneFrame kind="files" focusTier="none" active={false} dimmed>{null}</PaneFrame>
    </div>
  )
}
