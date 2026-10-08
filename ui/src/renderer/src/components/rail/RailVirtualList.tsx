import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { RailVirtualViewport } from '../ui/rail/RailChrome'

const ITEM_GAP = 4

export interface RailVirtualItem {
  key: string
  kind: 'group' | 'card'
  content: ReactNode
}

export function RailVirtualList({
  items,
  compact,
  dragging,
}: {
  items: readonly RailVirtualItem[]
  compact: boolean
  dragging: boolean
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(480)
  const [measuredHeights, setMeasuredHeights] = useState<ReadonlyMap<string, number>>(() => new Map())
  useEffect(() => {
    const measure = (): void => setViewportHeight(containerRef.current?.clientHeight ?? 480)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
  const heights = useMemo(
    () => items.map((item) => measuredHeights.get(item.key) ?? (item.kind === 'group' ? 32 : compact ? 36 : 76)),
    [items, compact, measuredHeights],
  )
  let offset = 0
  let first = 0
  while (first < items.length && offset + heights[first] + ITEM_GAP < scrollTop) {
    offset += heights[first] + ITEM_GAP
    first += 1
  }
  const start = Math.max(0, first - 10)
  let top = 0
  for (let index = 0; index < start; index += 1) top += heights[index]
  top += Math.max(0, start - 1) * ITEM_GAP
  let end = first
  let visibleHeight = 0
  while (end < items.length && visibleHeight < viewportHeight) {
    visibleHeight += heights[end] + ITEM_GAP
    end += 1
  }
  end = Math.min(items.length, end + 10)
  let renderedHeight = 0
  for (let index = start; index < end; index += 1) renderedHeight += heights[index]
  const trailingCount = items.length - end
  let bottom = 0
  for (let index = end; index < items.length; index += 1) bottom += heights[index]
  bottom += Math.max(0, trailingCount - 1) * ITEM_GAP
  return (
    <RailVirtualViewport
      ref={containerRef}
      dragging={dragging}
      onScroll={(event) => {
        setScrollTop(event.currentTarget.scrollTop)
        setViewportHeight(event.currentTarget.clientHeight)
      }}
    >
      <div aria-hidden style={{ height: top, flex: 'none' }} />
      {items.slice(start, end).map((item) => (
        <div key={item.key} data-virtual-kind={item.kind} className="flex-none" ref={(node) => {
          if (!node || typeof ResizeObserver === 'undefined') return
          const observer = new ResizeObserver(([entry]) => {
            const height = Math.ceil(entry.contentRect.height)
            setMeasuredHeights((current) => {
              if (current.get(item.key) === height) return current
              const next = new Map(current)
              next.set(item.key, height)
              return next
            })
          })
          observer.observe(node)
          return () => observer.disconnect()
        }}>
          {item.content}
        </div>
      ))}
      {bottom > 0 && <div aria-hidden style={{ height: bottom, flex: 'none' }} />}
    </RailVirtualViewport>
  )
}
