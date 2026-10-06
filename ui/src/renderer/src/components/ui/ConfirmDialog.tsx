import type { ReactNode } from 'react'
import { BTN_DANGER_SOLID, BTN_GHOST } from './buttonChrome'
import { DialogBackdrop } from './Dialog'
import { Text } from './Text'

export interface ConfirmDialogProps {
  title: string
  children: ReactNode
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}

/** A modal that asks before a destructive action; the confirm button is the destructive solid. */
export function ConfirmDialog({ title, children, confirmLabel, onConfirm, onCancel }: ConfirmDialogProps): React.JSX.Element {
  return (
    <DialogBackdrop tone="git" onMouseDown={onCancel}>
      <div
        className="w-[var(--w-confirm-dialog)] max-w-[var(--w-confirm-dialog-max)] rounded-[calc(var(--tr-radius-card)+var(--space-1))] border border-[var(--panel-field-border)] bg-surface shadow-[var(--shadow-lg)] overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <Text as="div" size="ui" weight="semibold" tight tone="primary" className="py-[var(--space-confirm-title-y)] px-[var(--space-confirm-content-x)] border-b border-[var(--panel-surface-border)]">
          {title}
        </Text>
        <div className="py-[var(--space-confirm-title-y)] px-[var(--space-confirm-content-x)] flex flex-col gap-1">{children}</div>
        <div className="py-[var(--space-confirm-actions-y)] px-[var(--space-confirm-content-x)] border-t border-[var(--panel-surface-border)] flex items-center justify-end gap-2">
          <button type="button" className={`btn ${BTN_GHOST}`} onClick={onCancel}>
            <Text size="small" weight="small">Cancel</Text>
          </button>
          <button
            type="button"
            className={`btn ${BTN_DANGER_SOLID} py-1.5 px-[var(--space-confirm-action-x)] rounded-[var(--tr-radius-button)] cursor-pointer`}
            onClick={onConfirm}
          >
            <Text size="small" weight="small">{confirmLabel}</Text>
          </button>
        </div>
      </div>
    </DialogBackdrop>
  )
}
