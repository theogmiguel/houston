import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { RailListViewport } from '../ui/rail/RailChrome'

export interface RailListItem {
  key: string
  kind: 'group' | 'card' | 'drop'
  content: ReactNode
}

/** The only scroller of the workspace and grid tree. Scrolls the selected card into view whenever it changes. */
export function RailList({
  items,
  selectedKey,
  dragging,
  refused = false,
  scrollRef,
}: {
  items: readonly RailListItem[]
  selectedKey: string | null
  dragging: boolean
  /** True while a drag is over a position it cannot drop on. */
  refused?: boolean
  scrollRef?: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const ownRef = useRef<HTMLDivElement>(null)
  const containerRef = scrollRef ?? ownRef
  useEffect(() => {
    if (selectedKey === null) return
    const node = [...(containerRef.current?.querySelectorAll<HTMLElement>('[data-rail-key]') ?? [])]
      .find((candidate) => candidate.dataset.railKey === selectedKey)
    node?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedKey, containerRef])
  return (
    <RailListViewport ref={containerRef} dragging={dragging} refused={refused}>
      {items.map((item) => (
        <div key={item.key} data-rail-key={item.key} data-rail-kind={item.kind} className="flex-none">{item.content}</div>
      ))}
    </RailListViewport>
  )
}
