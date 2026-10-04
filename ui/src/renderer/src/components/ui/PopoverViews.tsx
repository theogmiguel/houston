import { useEffect, useState } from 'react'
import { largestViewBounds, type PopoverBounds } from './popoverMotion'

export interface PopoverView {
  id: string
  bounds: PopoverBounds
  content: React.ReactNode
}

const VIEW_OUT_MS = 120 // Matches the Fast token so the next view waits until the outgoing one fades.

export function PopoverViews({ views, activeId, reducedMotion }: { views: readonly PopoverView[]; activeId: string; reducedMotion?: boolean }): React.JSX.Element {
  const bounds = largestViewBounds(views.map(({ bounds: viewBounds }) => viewBounds))
  const reduceMotion = reducedMotion ?? (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [shownId, setShownId] = useState(activeId)

  useEffect(() => {
    if (activeId === shownId) return
    if (reduceMotion) {
      setShownId(activeId)
      return
    }
    const enter = window.setTimeout(() => setShownId(activeId), VIEW_OUT_MS)
    return () => window.clearTimeout(enter)
  }, [activeId, reduceMotion, shownId])

  return (
    <div className="relative" style={{ width: bounds.width, height: bounds.height }}>
      {views.filter(({ id }) => id === shownId).map(({ id, content }) => (
        <div
          key={id}
          aria-hidden={id !== activeId}
          className={reduceMotion ? undefined : shownId !== activeId ? 'popover-view-out' : 'popover-view-in'}
          style={{ position: 'absolute', inset: 0, pointerEvents: id === activeId ? 'auto' : 'none' }}
        >
          {content}
        </div>
      ))}
    </div>
  )
}
