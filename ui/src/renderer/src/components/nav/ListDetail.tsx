import { useEffect, useRef, useState } from 'react'
import { NavBack } from './navChrome'

export interface ListDetailItem {
  id: string
  title: React.ReactNode
  sub?: React.ReactNode
  right?: React.ReactNode
}

export function ListDetail<T extends ListDetailItem>({
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
    const measure = (): void => setWide(el.clientWidth >= 720)
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
        className="border border-[var(--border)] rounded-[var(--tr-radius-md)] bg-[var(--card-bg)] overflow-hidden grid grid-cols-1 [@container_(min-width:720px)]:grid-cols-[280px_minmax(0,1fr)]"
      >
        <div
          data-testid="list-detail-list"
          className={`flex flex-col p-[8px] gap-[2px] min-h-0 overflow-y-auto [@container_(min-width:720px)]:border-r [@container_(min-width:720px)]:border-r-[var(--divider)] ${
            detailOpen ? 'hidden [@container_(min-width:720px)]:flex' : 'flex'
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
                className={`flex items-center gap-[8px] rounded-[var(--tr-radius-sm)] [transition:background-color_0.1s_ease-out] ${
                  isSelected
                    ? 'bg-[var(--selected-fill)]'
                    : 'bg-transparent hover:bg-[var(--hover-fill)]'
                }`}
              >
                <button
                  type="button"
                  data-testid="list-detail-item"
                  aria-current={isSelected || undefined}
                  className="btn min-w-0 flex-1 py-[8px] pl-[10px] pr-[2px] rounded-[var(--tr-radius-sm)] border-0 bg-transparent text-left cursor-pointer"
                  onClick={() => setSelectedId(item.id)}
                >
                  <span className="block truncate [font-size:var(--tr-text-ui-size)] font-medium text-[var(--text-primary)]">
                    {item.title}
                  </span>
                  {item.sub && (
                    <span className="block truncate [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]">
                      {item.sub}
                    </span>
                  )}
                </button>
                {item.right && <span className="flex-none pr-[10px]">{item.right}</span>}
              </div>
            )
          })}
        </div>
        <div
          data-testid="list-detail-detail"
          className={`flex flex-col min-w-0 min-h-0 ${detailOpen ? 'flex' : 'hidden [@container_(min-width:720px)]:flex'}`}
        >
          {detailOpen && (
            <div className="[@container_(min-width:720px)]:hidden">
              <NavBack
                label={backLabel}
                onClick={() => (selected ? setSelectedId(null) : onCloseForced?.())}
              />
            </div>
          )}
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-[14px] py-[20px] px-[24px]">
            {renderDetail(selected)}
          </div>
        </div>
      </div>
    </div>
  )
}
