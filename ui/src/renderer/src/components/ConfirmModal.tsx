import { useEffect, useRef } from 'react'
import { BTN_DANGER_SOLID, BTN_GHOST } from './buttonChrome'
import { MODAL_SCRIM_CLS } from './overlayChrome'
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
    <div
      className={MODAL_SCRIM_CLS}
      onMouseDown={onCancel}
    >
      <div
        ref={rootRef}
        className="pop w-[380px] max-w-[92vw] bg-[var(--raised)] border border-[var(--border)] rounded-[var(--tr-radius-md)] shadow-[var(--shadow-2,0_24px_64px_rgba(0,0,0,0.55),0_2px_8px_rgba(0,0,0,0.4))] motion-safe:animate-[panel-in_var(--animate-t-panel)_var(--animate-ease-panel)] [.anim-out_&]:motion-safe:animate-[panel-out_var(--animate-t-fast)_var(--animate-ease-panel)_forwards]"
        role="alertdialog"
        aria-modal="true"
        aria-describedby="confirm-modal-msg"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="px-3.5 py-[11px] border-b border-border [font-size:var(--tr-text-subhead-size)] [font-weight:var(--tr-text-subhead-weight)] [letter-spacing:var(--tr-text-subhead-tracking)] text-text-primary">
          {title}
        </div>
        <div className="p-5 space-y-4">
          <div
            id="confirm-modal-msg"
            className="text-text-secondary [font-size:var(--tr-text-body-size)] [font-weight:var(--tr-text-body-weight)] leading-relaxed"
          >
            {message}
          </div>
        </div>
        <div className="flex flex-col gap-2 px-5 pb-5">
          <div className="flex gap-2 justify-end">
            <button ref={cancelRef} className={`btn ${BTN_GHOST}`} onClick={onCancel}>
              Cancel
            </button>
            <button
              ref={confirmRef}
              className={`btn ${BTN_DANGER_SOLID} inline-flex items-center gap-[var(--space-1-5)]`}
              onClick={onConfirm}
            >
              <Icon glyph={IconAlertTriangle} role="ui" />
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
