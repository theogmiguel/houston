import { useRef } from 'react'
import { useFocusRestore, useFocusTrap } from '../dialogFocus'
import { BTN_GHOST } from '../buttonChrome'
import { IconClose } from '../icons'
import { Icon } from '../Icon'

export interface GitDialogShellProps {
  heading: string
  testid: string
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
}

// One shell for every Git dialog: same scrim, focus trap, Escape and chrome, so
// the four tools cannot drift apart. Body scrolls; header and footer do not.
export function GitDialogShell({
  heading,
  testid,
  onClose,
  children,
  footer
}: GitDialogShellProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  useFocusRestore(dialogRef, closeRef)
  const trapTab = useFocusTrap(
    dialogRef,
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled])'
  )

  return (
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[color-mix(in_srgb,var(--content-bg)_80%,transparent)] backdrop-blur-[4px]" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${testid}-title`}
        data-testid={testid}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape') onClose()
          trapTab(event)
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className="w-[560px] max-w-[calc(100vw_-_2rem)] max-h-[calc(100vh_-_4rem)] rounded-[var(--tr-radius-panel)] border border-[var(--border)] bg-[var(--card-bg)] shadow-[var(--shadow-lg)] overflow-hidden flex flex-col"
      >
        <div className="flex items-center gap-2 py-3.5 px-5 border-b border-[var(--divider)] flex-none">
          <h2
            id={`${testid}-title`}
            className="m-0 flex-1 [font-size:var(--tr-text-ui-size)] font-semibold tracking-[-0.01em] text-[var(--text-primary)]"
          >
            {heading}
          </h2>
          <button
            type="button"
            ref={closeRef}
            aria-label="Close"
            data-testid={`${testid}-close`}
            className={`btn ${BTN_GHOST} p-1 rounded-[var(--tr-radius-sm)]`}
            onClick={onClose}
          >
            <Icon glyph={IconClose} role="label" />
          </button>
        </div>
        <div
          className="flex-1 min-h-0 overflow-y-auto py-4 px-5 flex flex-col gap-3 [scrollbar-width:thin]"
          data-testid={`${testid}-body`}
        >
          {children}
        </div>
        {footer && (
          <div className="flex-none flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--divider)]">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
