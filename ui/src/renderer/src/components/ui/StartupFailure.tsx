import type { MouseEventHandler, ReactNode } from 'react'
import { Text } from './Text'

/** A recovery page under a draggable strip. */
export function StartupFailure({ eyebrow, title, message, onDragMouseDown, children }: { eyebrow: string; title: string; message: string; onDragMouseDown: MouseEventHandler<HTMLElement>; children: ReactNode }): React.JSX.Element {
  return (
    <div className="h-screen w-screen flex flex-col">
      <div className="h-[var(--h-titlebar)] w-full flex-none [-webkit-app-region:drag]" onMouseDown={onDragMouseDown} />
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="flex flex-col items-center gap-3 max-w-[var(--w-startup-message)] text-center">
          <Text size="label" weight="label" tone="muted">{eyebrow}</Text>
          <Text as="h1" size="heading" weight="label" tone="primary" flush className="tracking-[var(--tr-text-heading-tracking)]">{title}</Text>
          <Text as="p" size="body" tone="muted" flush className="font-[var(--tr-text-body-weight)]">{message}</Text>
          <div className="flex gap-2 pt-2 [&_button]:capitalize">{children}</div>
        </div>
      </div>
    </div>
  )
}

export function StartupFailureSpecimen(): React.JSX.Element {
  return <div data-testid="startup-failure-specimen" className="relative h-[var(--h-primitives-preview-tall)] overflow-hidden [contain:paint]"><StartupFailure eyebrow="Bridge not ready" title="Houston failed to start" message="The desktop bridge is taking longer than 15s to load." onDragMouseDown={() => {}}><Text>Retry</Text></StartupFailure></div>
}
