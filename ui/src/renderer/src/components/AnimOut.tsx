import { useEffect, useRef, useState, type RefObject } from 'react'
import { useNativeSuppression, type NativeSuppressionReason } from '../layout/nativeSuppression'

const EXIT_MS = 170

export function useExitAnimation(open: boolean): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open) {
      setMounted(true)
      return
    }
    const t = setTimeout(() => setMounted(false), EXIT_MS)
    return () => clearTimeout(t)
  }, [open])
  return { mounted, closing: !open && mounted }
}

export function AnimOut({
  open,
  suppress,
  children
}: {
  open: boolean
  suppress?: NativeSuppressionReason
  children: React.ReactNode
}): React.JSX.Element | null {
  const { mounted, closing } = useExitAnimation(open)
  useNativeSuppression(suppress ?? 'popover', suppress != null && mounted)
  const last = useRef<React.ReactNode>(null)
  if (open) last.current = children
  if (!open && !mounted) return null
  return <div className={`contents ${closing ? 'anim-out' : ''}`}>{open ? children : last.current}</div>
}

export function MenuLayer({
  open,
  onClose,
  suppress,
  menuRef,
  children
}: {
  open: boolean
  onClose: () => void
  suppress?: NativeSuppressionReason
  menuRef: RefObject<HTMLElement | null>
  children: React.ReactNode
}): React.JSX.Element {
  const armed = useRef(false)
  const returnFocus = useRef<HTMLElement | null>(null)

  // Arms on the next frame: a contextmenu can dispatch before its own mousedown,
  // closing the menu on the click that opened it. Escape is caught here, not on
  // `window`, which a focused terminal's per-key stopPropagation never reaches.
  useEffect(() => {
    if (!open) return
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    armed.current = false
    const raf = requestAnimationFrame(() => {
      armed.current = true
    })
    menuRef.current?.focus()
    return () => {
      cancelAnimationFrame(raf)
      returnFocus.current?.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- menuRef is a stable ref object
  }, [open])

  return (
    <AnimOut open={open} suppress={suppress}>
      <div
        data-testid="menu-dismiss-layer"
        className="fixed inset-0 z-[var(--z-overlay)]"
        onMouseDown={() => {
          if (armed.current) onClose()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
            return
          }
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
          const root = menuRef.current
          if (!root) return
          const items = Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled])'))
          if (items.length === 0) return
          e.preventDefault()
          const at = items.indexOf(document.activeElement as HTMLElement)
          const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length
          items[next].focus()
        }}
      >
        {children}
      </div>
    </AnimOut>
  )
}
