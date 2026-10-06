import { useRef } from 'react'
import { useFocusRestore, useFocusTrap } from '../dialogFocus'
import { Button, DialogActions, DialogBackdrop, DialogBody, DialogPanel } from '../ui'
import { IconClose } from '../icons'
import { Icon } from '../ui/Icon'

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
    <DialogBackdrop tone="git" onMouseDown={onClose}>
      <DialogPanel
        size="git"
        surface="git"
        animated={false}
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
      >
        <div className="flex items-center gap-2 py-3.5 px-5 border-b border-[var(--divider)] flex-none">
          <h2
            id={`${testid}-title`}
            className="m-0 flex-1 [font-size:var(--tr-text-ui-size)] font-semibold tracking-[-0.01em] text-[var(--text-primary)]"
          >
            {heading}
          </h2>
          <Button
            ref={closeRef}
            variant="legacy-ghost-icon"
            aria-label="Close"
            data-testid={`${testid}-close`}
            onClick={onClose}
          ><Icon glyph={IconClose} role="label" /></Button>
        </div>
        <DialogBody variant="scroll" data-testid={`${testid}-body`}>
          {children}
        </DialogBody>
        {footer && (
          <DialogActions variant="footer">
            {footer}
          </DialogActions>
        )}
      </DialogPanel>
    </DialogBackdrop>
  )
}
