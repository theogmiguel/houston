import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button } from './Button'
import { IconClose } from '../icons'
import { PAGE_COLUMN_CLS } from '../settingsPrimitives'
import { variants } from './variants'

export interface DrawerProps {
  open: boolean
  heading: string
  onClose: () => void
  children: ReactNode
  labelledBy?: string
  hideHeader?: boolean
  tone?: 'raised' | 'content'
}

const DRAWER_CLS = `fixed inset-y-0 right-0 z-[var(--z-modal)] flex w-full ${PAGE_COLUMN_CLS} flex-col border-l border-[var(--border)] shadow-[var(--shadow-2)] motion-safe:animate-[panel-in_var(--animate-t-panel)_var(--animate-ease-panel)] motion-reduce:animate-none`
const DRAWER_TONE_CLS = variants('', {
  tone: { raised: 'bg-[var(--raised)]', content: 'bg-[var(--content-bg)]' }
}, { tone: 'raised' })
const BACKDROP_CLS = 'fixed inset-0 z-[var(--z-modal)] bg-overlay motion-safe:animate-[backdrop-in_var(--animate-t-scrim)_var(--animate-ease-scrim)] motion-reduce:animate-none'

export function Drawer({ open, heading, onClose, children, labelledBy, hideHeader = false, tone = 'raised' }: DrawerProps): React.JSX.Element | null {
  const drawerRef = useRef<HTMLElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const generatedId = useId()
  const titleId = labelledBy ?? generatedId

  useEffect(() => {
    if (!open) return
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const root = drawerRef.current
    const focusable = root?.querySelector<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
    focusable?.focus()
    return () => {
      const active = document.activeElement
      const stillOwned = active === null || active === document.body || (root?.contains(active) ?? false)
      if (stillOwned && returnFocusRef.current?.isConnected) returnFocusRef.current.focus()
    }
  }, [open])

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const root = drawerRef.current
    if (!root) return
    const focusable = Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
    if (focusable.length === 0) {
      event.preventDefault()
      root.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
      event.preventDefault()
      first.focus()
    }
  }

  if (!open || typeof document === 'undefined') return null
  return createPortal(
    <>
      <div data-testid="drawer-backdrop" className={BACKDROP_CLS} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }} />
      <aside ref={drawerRef} data-testid="drawer" className={`${DRAWER_CLS} ${DRAWER_TONE_CLS({ tone })}`} role="dialog" aria-modal="true" aria-label={hideHeader ? heading : undefined} aria-labelledby={hideHeader ? undefined : titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        {!hideHeader && <header className="flex h-[var(--h-top)] flex-none items-center justify-between gap-[var(--space-3)] border-b border-[var(--divider)] px-[var(--space-4-5)]">
          <h2 id={titleId} className="m-0 min-w-0 flex-1 truncate text-[length:var(--tr-text-heading-size)] font-[var(--tr-text-heading-weight)] text-[var(--text-primary)]">{heading}</h2>
          <Button variant="icon" icon={IconClose} aria-label="Close drawer" onClick={onClose} />
        </header>}
        <div className={hideHeader ? 'min-h-0 flex-1 overflow-y-auto' : 'min-h-0 flex-1 overflow-y-auto p-[var(--space-4-5)]'}>{children}</div>
      </aside>
    </>,
    document.body
  )
}
