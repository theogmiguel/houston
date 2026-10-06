import { useEffect, useRef, useState } from 'react'
import { BackBar } from './navPrimitives'
import { Text } from './Text'

export interface ResponsiveListDetailItem {
  id: string
  title: React.ReactNode
  sub?: React.ReactNode
  right?: React.ReactNode
}

/** A list beside its detail pane; below 720px the detail replaces the list and a back bar returns to it. */
export function ResponsiveListDetail<T extends ResponsiveListDetailItem>({
  items,
  listHead,
  listEmpty,
  backLabel,
  renderDetail,
  forceDetailOpen = false,
  onCloseForced
}: {
  items: T[]
  listHead?: React.ReactNode
  listEmpty?: React.ReactNode
  backLabel: string
  renderDetail: (item: T | null) => React.ReactNode
  forceDetailOpen?: boolean
  onCloseForced?: () => void
}): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [wide, setWide] = useState(false)
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = (): void => {
      const breakpoint = Number.parseFloat(getComputedStyle(el).getPropertyValue('--w-list-detail-breakpoint'))
      setWide(el.clientWidth >= breakpoint)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (selectedId !== null && !items.some((i) => i.id === selectedId)) {
      setSelectedId(items[0]?.id ?? null)
    } else if (selectedId === null && wide && items.length > 0) {
      setSelectedId(items[0].id)
    }
  }, [items, selectedId, wide])

  const selected = items.find((i) => i.id === selectedId) ?? null
  const detailOpen = selected !== null || forceDetailOpen

  return (
    <div ref={containerRef} data-testid="list-detail-container" className="@container">
      <div
        data-testid="list-detail"
        className={`border border-[var(--border)] rounded-[var(--tr-radius-md)] bg-[var(--card-bg)] overflow-hidden grid ${wide ? 'grid-cols-[var(--w-list-detail-column)_minmax(0,1fr)]' : 'grid-cols-1'}`}
      >
        <div
          data-testid="list-detail-list"
          className={`flex flex-col p-[var(--space-list-detail-inset)] gap-[var(--space-list-detail-gap)] min-h-0 overflow-y-auto ${wide ? 'border-r border-r-[var(--divider)]' : ''} ${
            detailOpen && !wide ? 'hidden' : 'flex'
          }`}
        >
          {listHead}
          {items.length === 0 && listEmpty}
          {items.map((item) => {
            const isSelected = item.id === selectedId
            return (
              <div
                key={item.id}
                data-testid="list-detail-row"
                className={`flex items-center gap-[var(--space-list-detail-inset)] rounded-[var(--tr-radius-sm)] [transition:background-color_0.1s_ease-out] ${
                  isSelected
                    ? 'bg-[var(--selected-fill)]'
                    : 'bg-transparent hover:bg-[var(--hover-fill)]'
                }`}
              >
                <button
                  type="button"
                  data-testid="list-detail-item"
                  aria-current={isSelected || undefined}
                  className="btn min-w-0 flex-1 py-[var(--space-list-detail-item-block)] pl-[var(--space-list-detail-item-leading)] pr-[var(--space-list-detail-item-trailing)] rounded-[var(--tr-radius-sm)] border-0 bg-transparent text-left cursor-pointer"
                  onClick={() => setSelectedId(item.id)}
                >
                  <Text size="ui" weight="medium" tone="primary" className="block truncate">
                    {item.title}
                  </Text>
                  {item.sub && (
                    <Text size="small" weight="small" tone="muted" className="block truncate">
                      {item.sub}
                    </Text>
                  )}
                </button>
                {item.right && <span className="flex-none pr-[var(--space-list-detail-end)]">{item.right}</span>}
              </div>
            )
          })}
        </div>
        <div
          data-testid="list-detail-detail"
          className={`flex flex-col min-w-0 min-h-0 ${detailOpen || wide ? 'flex' : 'hidden'}`}
        >
          {detailOpen && (
            <div className={wide ? 'hidden' : ''}>
              <BackBar
                label={backLabel}
                onClick={() => (selected ? setSelectedId(null) : onCloseForced?.())}
              />
            </div>
          )}
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-[var(--space-list-detail-content-gap)] py-[var(--space-list-detail-content-block)] px-[var(--space-list-detail-content-inline)]">
            {renderDetail(selected)}
          </div>
        </div>
      </div>
    </div>
  )
}
