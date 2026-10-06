import { useEffect, useRef } from 'react'
import { Button, DialogActions, DialogBackdrop, DialogBody, DialogDescription, DialogPanel, DialogTitle } from './ui'
import { IconAlertTriangle } from './icons'
import { Icon } from './Icon'

interface Props {
  message: string
  confirmLabel?: string
  title?: string
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmModal({
  message,
  confirmLabel = 'Confirm',
  title = 'CONFIRM',
  onConfirm,
  onCancel
}: Props): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const trigger = document.activeElement
    cancelRef.current?.focus()
    return () => {
      const active = document.activeElement
      const stillOwned =
        active === null || active === document.body || (rootRef.current?.contains(active) ?? false)
      if (stillOwned && trigger instanceof HTMLElement && trigger.isConnected) trigger.focus()
    }
  }, [])

  // Escape is stopped here so it never reaches App's global shortcut handler. Focus
  // starts on Cancel and returns to the trigger only if the dialog still owns it.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onCancel()
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      if (document.activeElement === cancelRef.current) confirmRef.current?.focus()
      else cancelRef.current?.focus()
    }
  }

  return (
    <DialogBackdrop onMouseDown={onCancel}>
      <DialogPanel
        ref={rootRef}
        role="alertdialog"
        aria-modal="true"
        aria-describedby="confirm-modal-msg"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <DialogTitle>{title}</DialogTitle>
        <DialogBody>
          <DialogDescription id="confirm-modal-msg">{message}</DialogDescription>
        </DialogBody>
        <DialogActions>
          <Button ref={cancelRef} variant="legacy-ghost" onClick={onCancel}>Cancel</Button>
          <Button ref={confirmRef} variant="legacy-danger-solid" onClick={onConfirm}><Icon glyph={IconAlertTriangle} role="ui" />{confirmLabel}</Button>
        </DialogActions>
      </DialogPanel>
    </DialogBackdrop>
  )
}
