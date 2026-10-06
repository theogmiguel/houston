import type { CSSProperties, JSX } from 'react'
import type { WindowButtonKind, WindowButtonLayout } from '../windowButtonLayout'
import { Tooltip } from './ui/Tooltip'
import { WindowControlButton, WindowControlDisc } from './ui/WindowControl'

interface WindowControlsProps {
  layout: WindowButtonLayout
  maximized?: boolean
  onClose?: () => void
  onMinimize?: () => void
  onMaximize?: () => void
  className?: string
}

const LABELS: Record<WindowButtonKind, string> = {
  close: 'Close',
  minimize: 'Minimize',
  maximize: 'Maximize',
}

function buttonLabel(kind: WindowButtonKind, maximized: boolean): string {
  if (kind === 'maximize' && maximized) return 'Restore'
  return LABELS[kind]
}

function ButtonGlyph({ kind, maximized }: { kind: WindowButtonKind; maximized: boolean }): JSX.Element {
  if (kind === 'minimize') {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M1 5h8v1H1z" fill="currentColor" />
      </svg>
    )
  }
  if (kind === 'maximize') {
    return maximized ? (
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M3 1v2H1v6h6V7h2V1H3zM6 8H2V4h4v4zM8 6H7V3H4V2h4v4z" fill="currentColor" />
      </svg>
    ) : (
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M1 1v8h8V1H1zm7 7H2V2h6v6z" fill="currentColor" />
      </svg>
    )
  }
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path
        d="M2 2l6 6M8 2l-6 6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}

export function WindowControls({
  layout,
  maximized = false,
  onClose,
  onMinimize,
  onMaximize,
  className = '',
}: WindowControlsProps): JSX.Element | null {
  if (layout.buttons.length === 0) {
    return null
  }

  const handlers: Record<WindowButtonKind, (() => void) | undefined> = {
    close: onClose,
    minimize: onMinimize,
    maximize: onMaximize,
  }

  return (
    <div
      className={`flex items-center ${className}`}
      style={{ ['-webkit-app-region' as string]: 'no-drag' } as CSSProperties}
      data-testid="window-controls"
    >
      {layout.buttons.map((kind) => (
        <Tooltip key={kind} label={buttonLabel(kind, maximized)}>
          <WindowControlButton
            type="button"
            aria-label={buttonLabel(kind, maximized)}
            onClick={handlers[kind]}
            className="group/wc"
          >
            <WindowControlDisc
              aria-hidden
              data-testid="window-control-disc"
              tone={kind === 'close' ? 'close' : 'regular'}
            >
              <ButtonGlyph kind={kind} maximized={maximized} />
            </WindowControlDisc>
          </WindowControlButton>
        </Tooltip>
      ))}
    </div>
  )
}
