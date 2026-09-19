import type { JSX } from 'react'
import type { WindowButtonKind, WindowButtonLayout } from '../windowButtonLayout'
import { Tooltip } from './Tooltip'

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
      className={`flex items-center [-webkit-app-region:no-drag] ${className}`}
      data-testid="window-controls"
    >
      {layout.buttons.map((kind) => (
        <Tooltip key={kind} label={buttonLabel(kind, maximized)}>
          <button
            type="button"
            aria-label={buttonLabel(kind, maximized)}
            onClick={handlers[kind]}
            className="btn group/wc flex items-center justify-center w-[calc(30px/var(--shell-zoom,1))] h-[calc(var(--h-top)/var(--shell-zoom,1))] p-0 rounded-none border-none bg-transparent text-[var(--text-primary)] cursor-pointer [-webkit-app-region:no-drag]"
          >
            <span
              aria-hidden
              data-testid="window-control-disc"
              className={`flex items-center justify-center w-[calc(20px/var(--shell-zoom,1))] h-[calc(20px/var(--shell-zoom,1))] rounded-[6px] bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] group-focus-visible/wc:outline-[1.5px] group-focus-visible/wc:outline-[var(--focus-ring)] group-focus-visible/wc:outline-offset-1 motion-safe:transition-[background-color,color] motion-safe:duration-[var(--animate-t-fast)] ${
                kind === 'close'
                  ? 'group-hover/wc:bg-[color-mix(in_srgb,var(--danger)_20%,transparent)] group-hover/wc:text-[var(--danger)] group-active/wc:bg-[color-mix(in_srgb,var(--danger)_30%,transparent)]'
                  : 'group-hover/wc:bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] group-hover/wc:text-[color-mix(in_srgb,var(--accent)_75%,var(--text-primary))] group-active/wc:bg-[color-mix(in_srgb,var(--accent)_24%,transparent)]'
              }`}
            >
              <ButtonGlyph kind={kind} maximized={maximized} />
            </span>
          </button>
        </Tooltip>
      ))}
    </div>
  )
}
