import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// Hover is delayed, keyboard focus is not: a tabbed-to control already committed
// intent, a hovered one has not.
export const HOVER_DELAY_MS = 300

const OFFSET_PX = 6

const VIEWPORT_MARGIN_PX = 8

interface Props {
  label?: string | null
  side?: 'top' | 'bottom'
  className?: string
  openOnClick?: boolean
  children: React.ReactNode
}

interface Placement {
  top: number
  left: number
}

export function Tooltip({ label, side = 'bottom', className, openOnClick = false, children }: Props): React.JSX.Element {
  const id = useId()
  const wrapRef = useRef<HTMLSpanElement | null>(null)
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState<Placement | null>(null)

  const cancel = useCallback(() => {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current)
      timerRef.current = undefined
    }
  }, [])

  const hide = useCallback(() => {
    cancel()
    setOpen(false)
    setPlace(null)
  }, [cancel])

  const show = useCallback(() => {
    cancel()
    setOpen(true)
  }, [cancel])

  // Clicking focuses a control too, and a bubble on every click is noise — but
  // jsdom's `:focus-visible` is permanently false, so the click is tracked here
  // rather than tested for. Only a genuine keyboard focus opens immediately.
  const pointerFocusRef = useRef(false)

  const onPointerDown = useCallback(() => {
    hide()
    pointerFocusRef.current = true
    setTimeout(() => {
      pointerFocusRef.current = false
    }, 0)
  }, [hide])

  const onFocus = useCallback(() => {
    if (pointerFocusRef.current) return
    show()
  }, [show])

  const showAfterDelay = useCallback(() => {
    cancel()
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined
      setOpen(true)
    }, HOVER_DELAY_MS)
  }, [cancel])

  useEffect(() => cancel, [cancel])

  useEffect(() => {
    if (!open) return
    const anchor = wrapRef.current?.firstElementChild ?? wrapRef.current
    const bubble = bubbleRef.current
    if (!anchor || !bubble) return
    const a = anchor.getBoundingClientRect()
    const b = bubble.getBoundingClientRect()
    const below = a.bottom + OFFSET_PX
    const above = a.top - b.height - OFFSET_PX
    const fitsBelow = below + b.height <= window.innerHeight - VIEWPORT_MARGIN_PX
    const fitsAbove = above >= VIEWPORT_MARGIN_PX
    const top = side === 'top' ? (fitsAbove ? above : below) : fitsBelow ? below : above
    const wanted = a.left + a.width / 2 - b.width / 2
    const maxLeft = window.innerWidth - b.width - VIEWPORT_MARGIN_PX
    const left = Math.max(VIEWPORT_MARGIN_PX, Math.min(wanted, Math.max(VIEWPORT_MARGIN_PX, maxLeft)))
    setPlace({ top, left })
  }, [open, side, label])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') hide()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    window.addEventListener('blur', hide)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
      window.removeEventListener('blur', hide)
    }
  }, [open, hide])

  return (
    <span
      ref={wrapRef}
      className={className ?? 'contents'}
      onPointerEnter={showAfterDelay}
      onPointerLeave={hide}
      onPointerDown={onPointerDown}
      onClick={openOnClick ? show : undefined}
      onFocusCapture={onFocus}
      onBlurCapture={hide}
      onKeyDownCapture={hide}
      aria-describedby={open && label ? id : undefined}
      data-tooltip={label}
    >
      {children}
      {open &&
        label &&
        createPortal(
          <div
            ref={bubbleRef}
            id={id}
            role="tooltip"
            style={{
              top: place?.top ?? 0,
              left: place?.left ?? 0,
              visibility: place ? 'visible' : 'hidden'
            }}
            className="fixed z-[var(--z-tooltip)] pointer-events-none max-w-[280px] rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--card-bg)] text-[var(--text-primary)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.35] py-[4px] px-[7px] shadow-[var(--shadow-md)] whitespace-pre-line motion-safe:animate-[menu-in_120ms_ease-out]"
          >
            {label}
          </div>,
          document.body
        )}
    </span>
  )
}
