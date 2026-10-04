import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Button } from './Button'
import { IconChevronLeft } from '../icons'

export interface ListDetailItem {
  id: string
  title: ReactNode
  sub?: ReactNode
  right?: ReactNode
}

export interface ListDetailProps<T extends ListDetailItem> {
  items: T[]
  selectedId?: string | null
  onSelect?: (id: string | null) => void
  listHead?: ReactNode
  listEmpty?: ReactNode
  backLabel: string
  renderDetail: (item: T | null) => ReactNode
  className?: string
}

export function ListDetail<T extends ListDetailItem>({
  items,
  selectedId: controlledId,
  onSelect,
  listHead,
  listEmpty,
  backLabel,
  renderDetail,
  className = ''
}: ListDetailProps<T>): React.JSX.Element {
  const controlled = controlledId !== undefined
  const [internalId, setInternalId] = useState<string | null>(null)
  const selectedId = controlled ? controlledId : internalId
  const containerRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef(new Map<string, HTMLButtonElement>())
  const [wide, setWide] = useState(false)
  useEffect(() => {
    const element = containerRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const measure = (): void => setWide(element.clientWidth >= 720)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (controlled) return
    if (internalId !== null && !items.some((item) => item.id === internalId)) {
      setInternalId(items[0]?.id ?? null)
    } else if (internalId === null && wide && items.length > 0) {
      setInternalId(items[0].id)
    }
  }, [controlled, internalId, items, wide])

  const selected = items.find((item) => item.id === selectedId) ?? null
  const detailOpen = selected !== null
  const select = (id: string | null): void => {
    if (!controlled) setInternalId(id)
    onSelect?.(id)
  }
  const moveSelection = (currentId: string, direction: -1 | 1): void => {
    const index = items.findIndex((item) => item.id === currentId)
    if (index < 0 || items.length === 0) return
    const next = items[(index + direction + items.length) % items.length]
    select(next.id)
    itemRefs.current.get(next.id)?.focus()
  }
  const onItemKeyDown = (item: T) => (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveSelection(item.id, event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  return (
    <div ref={containerRef} data-testid="list-detail-container" className={`@container w-full ${className}`}>
      <div data-testid="list-detail" className="grid min-h-[var(--h-row)] grid-cols-1 overflow-hidden rounded-[var(--tr-radius-button)] border border-[var(--divider)] bg-[var(--card-bg)] [@container_(min-width:720px)]:grid-cols-[280px_minmax(0,1fr)]">
        <div data-testid="list-detail-list" className={`flex min-h-0 flex-col gap-[var(--space-1)] overflow-y-auto p-[var(--space-1)] [@container_(min-width:720px)]:border-r [@container_(min-width:720px)]:border-r-[var(--divider)] ${detailOpen ? 'hidden [@container_(min-width:720px)]:flex' : 'flex'}`}>
          {listHead}
          {items.length === 0 && listEmpty}
          {items.map((item) => {
            const isSelected = item.id === selectedId
            return (
              <div key={item.id} data-testid="list-detail-row" className={`flex min-w-0 items-center gap-[var(--space-2)] rounded-[var(--tr-radius-sm)] ${isSelected ? 'bg-[var(--selected-fill)]' : 'hover:bg-[var(--hover-fill)]'}`}>
                <button
                  ref={(element) => { if (element) itemRefs.current.set(item.id, element); else itemRefs.current.delete(item.id) }}
                  type="button"
                  data-testid="list-detail-item"
                  aria-current={isSelected || undefined}
                  onClick={() => select(item.id)}
                  onKeyDown={onItemKeyDown(item)}
                  className="btn min-w-0 flex-1 grid grid-cols-1 justify-items-start gap-[var(--space-1)] rounded-[var(--tr-radius-sm)] border-0 bg-transparent py-[var(--space-2)] pl-[var(--space-2-5)] pr-[var(--space-1)] text-left"
                >
                  <span className="block truncate text-[length:var(--tr-text-ui-size)] font-medium text-[var(--text-primary)]">{item.title}</span>
                  {item.sub && <span className="block truncate text-[length:var(--tr-text-small-size)] font-[var(--tr-text-small-weight)] text-[var(--text-muted)]">{item.sub}</span>}
                </button>
                {item.right && <span className="flex-none pr-[var(--space-2-5)]">{item.right}</span>}
              </div>
            )
          })}
        </div>
        <div data-testid="list-detail-detail" className={`flex min-h-0 min-w-0 flex-col ${detailOpen ? 'flex' : 'hidden [@container_(min-width:720px)]:flex'}`}>
          {detailOpen && !wide && <div className="[@container_(min-width:720px)]:hidden"><Button variant="ghost" icon={IconChevronLeft} onClick={() => select(null)}>{backLabel}</Button></div>}
          <div className="flex min-h-0 flex-1 flex-col gap-[var(--space-3)] overflow-y-auto px-[var(--space-3)] py-[var(--space-3)]">
            {renderDetail(selected)}
          </div>
        </div>
      </div>
    </div>
  )
}
