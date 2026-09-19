import { useEffect, useRef } from 'react'
import { BTN_GHOST, BTN_GHOST_DANGER_ARM, BTN_GHOST_DANGER_HOVER, BTN_PRIMARY } from './buttonChrome'
import { MODAL_SCRIM_CLS } from './overlayChrome'

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
    <div
      className={MODAL_SCRIM_CLS}
      onMouseDown={() => {
        if (!saving) onCancel()
      }}
    >
      <div
        ref={rootRef}
        className="pop w-[380px] max-w-[92vw] bg-[var(--raised)] border border-[var(--border)] rounded-[var(--tr-radius-md)] shadow-[var(--shadow-2,0_24px_64px_rgba(0,0,0,0.55),0_2px_8px_rgba(0,0,0,0.4))] motion-safe:animate-[panel-in_var(--animate-t-panel)_var(--animate-ease-panel)] [.anim-out_&]:motion-safe:animate-[panel-out_var(--animate-t-fast)_var(--animate-ease-panel)_forwards]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-discard-modal-title"
        aria-describedby="save-discard-modal-msg"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div
          id="save-discard-modal-title"
          className="px-3.5 py-[11px] border-b border-border [font-size:var(--tr-text-subhead-size)] [font-weight:var(--tr-text-subhead-weight)] [letter-spacing:var(--tr-text-subhead-tracking)] text-text-primary"
        >
          Save changes?
        </div>
        <div className="p-5 space-y-4">
          <div
            id="save-discard-modal-msg"
            className="text-text-secondary [font-size:var(--tr-text-body-size)] [font-weight:var(--tr-text-body-weight)] leading-relaxed"
          >
            This file has unsaved changes.
          </div>
        </div>
        <div className="flex flex-col gap-2 px-5 pb-5">
          <div className="flex gap-2 justify-end">
            <button ref={cancelRef} className={`btn ${BTN_GHOST}`} disabled={saving} onClick={onCancel}>
              Cancel
            </button>
            <button
              ref={discardRef}
              className={`btn ${BTN_GHOST} ${BTN_GHOST_DANGER_HOVER} ${BTN_GHOST_DANGER_ARM}`}
              disabled={saving}
              onClick={onDiscard}
            >
              Discard
            </button>
            <button ref={saveRef} className={`btn ${BTN_PRIMARY}`} disabled={saving} onClick={onSave}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
