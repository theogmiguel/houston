import { useEffect, useRef } from 'react'
import { Button, DialogActions, DialogBackdrop, DialogBody, DialogDescription, DialogPanel, DialogTitle } from './ui'

interface Props {
  onCancel: () => void
  onDiscard: () => void
  onSave: () => void
  saving: boolean
}

export function SaveDiscardModal({ onCancel, onDiscard, onSave, saving }: Props): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const discardRef = useRef<HTMLButtonElement>(null)
  const saveRef = useRef<HTMLButtonElement>(null)
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

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      if (!saving) onCancel()
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      const order = [cancelRef, discardRef, saveRef]
      const idx = order.findIndex((r) => r.current === document.activeElement)
      const step = e.shiftKey ? -1 : 1
      const next = order[(idx + step + order.length) % order.length]
      next.current?.focus()
    }
  }

  return (
    <DialogBackdrop
      onMouseDown={() => {
        if (!saving) onCancel()
      }}
    >
      <DialogPanel
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-discard-modal-title"
        aria-describedby="save-discard-modal-msg"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <DialogTitle id="save-discard-modal-title">Save changes?</DialogTitle>
        <DialogBody>
          <DialogDescription id="save-discard-modal-msg">This file has unsaved changes.</DialogDescription>
        </DialogBody>
        <DialogActions>
          <Button ref={cancelRef} variant="legacy-ghost" disabled={saving} onClick={onCancel}>Cancel</Button>
          <Button ref={discardRef} variant="legacy-danger" armed disabled={saving} onClick={onDiscard}>Discard</Button>
          <Button ref={saveRef} variant="legacy-primary" disabled={saving} onClick={onSave}>{saving ? 'Saving…' : 'Save'}</Button>
        </DialogActions>
      </DialogPanel>
    </DialogBackdrop>
  )
}
