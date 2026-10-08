import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Button } from './Button'
import { SectionHead } from './SectionHead'
import { IconChevronLeft } from '../icons'

export interface ListDetailItem {
  id: string
  title: ReactNode
  sub?: ReactNode
  right?: ReactNode
  /** Consecutive items sharing a section render under one counted heading. */
  section?: string
}

export interface ListDetailProps<T extends ListDetailItem> {
  items: T[]
  selectedId?: string | null
  onSelect?: (id: string | null) => void
  listHead?: ReactNode
  listEmpty?: ReactNode
  listFoot?: ReactNode
  /** Items in this section render after `listFoot`, which then heads them in place of a section heading. */
  footSection?: string
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
  listFoot,
  footSection,
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
  const sectionCounts = new Map<string, number>()
  for (const item of items) if (item.section !== undefined) sectionCounts.set(item.section, (sectionCounts.get(item.section) ?? 0) + 1)
  const detailOpen = selected !== null
  const select = (id: string | null): void => {
    if (!controlled) setInternalId(id)
    onSelect?.(id)
  }
  const leading = footSection === undefined ? items : items.filter((item) => item.section !== footSection)
  const trailing = footSection === undefined ? [] : items.filter((item) => item.section === footSection)
  const ordered = [...leading, ...trailing]
  const moveSelection = (currentId: string, direction: -1 | 1): void => {
    const index = ordered.findIndex((item) => item.id === currentId)
    if (index < 0) return
    const next = ordered[(index + direction + ordered.length) % ordered.length]
    select(next.id)
    itemRefs.current.get(next.id)?.focus()
  }
  const onItemKeyDown = (item: T) => (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveSelection(item.id, event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const row = (item: T): React.JSX.Element => (
    <ListDetailRow
      item={item}
      selected={item.id === selectedId}
      itemRef={(element) => { if (element) itemRefs.current.set(item.id, element); else itemRefs.current.delete(item.id) }}
      onSelect={() => select(item.id)}
      onKeyDown={onItemKeyDown(item)}
    />
  )

  if (items.length === 0 && listEmpty && !listHead) {
    return (
      <div ref={containerRef} data-testid="list-detail-container" className={`@container w-full ${className}`}>
        <div data-testid="list-detail-empty" className="rounded-[var(--tr-radius-button)] border border-[var(--divider)] bg-[var(--card-bg)] px-[var(--space-3)] py-[var(--space-5)]">
          {listEmpty}
        </div>
      </div>
    )
  }

  return (
    <div ref={containerRef} data-testid="list-detail-container" className={`@container w-full ${className}`}>
      <div data-testid="list-detail" className="grid min-h-[var(--h-row)] grid-cols-1 overflow-hidden rounded-[var(--tr-radius-button)] border border-[var(--divider)] bg-[var(--card-bg)] [@container_(min-width:720px)]:grid-cols-[280px_minmax(0,1fr)]">
        <div data-testid="list-detail-list" className={`flex min-h-0 flex-col gap-[var(--space-1)] overflow-y-auto p-[var(--space-1)] [@container_(min-width:720px)]:border-r [@container_(min-width:720px)]:border-r-[var(--divider)] ${detailOpen ? 'hidden [@container_(min-width:720px)]:flex' : 'flex'}`}>
          {listHead}
          {items.length === 0 && listEmpty}
          {leading.map((item, index) => {
            const section = item.section !== leading[index - 1]?.section ? item.section : undefined
            return (
              <Fragment key={item.id}>
                {section !== undefined && <div data-testid="list-detail-section" className={`px-[var(--space-2-5)] pb-[var(--space-0-5)] ${index === 0 ? 'pt-[var(--space-1)]' : 'pt-[var(--space-3)]'}`}><SectionHead title={section} count={sectionCounts.get(section)} /></div>}
                {row(item)}
              </Fragment>
            )
          })}
          {listFoot && <div className="pt-[var(--space-1)]">{listFoot}</div>}
          {trailing.map((item) => <Fragment key={item.id}>{row(item)}</Fragment>)}
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

function ListDetailRow({ item, selected, itemRef, onSelect, onKeyDown }: {
  item: ListDetailItem
  selected: boolean
  itemRef: (element: HTMLButtonElement | null) => void
  onSelect: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
}): React.JSX.Element {
  return (
    <div data-testid="list-detail-row" className={`flex min-w-0 items-center gap-[var(--space-2)] rounded-[var(--tr-radius-sm)] ${selected ? 'bg-[var(--selected-fill)]' : 'hover:bg-[var(--hover-fill)]'}`}>
      <button
        ref={itemRef}
        type="button"
        data-testid="list-detail-item"
        aria-current={selected || undefined}
        onClick={onSelect}
        onKeyDown={onKeyDown}
        className={`btn min-w-0 flex-1 grid grid-cols-1 justify-items-start gap-[var(--space-1)] rounded-[var(--tr-radius-sm)] border-0 bg-transparent py-[var(--space-2)] pl-[var(--space-2-5)] text-left ${item.right ? 'pr-[var(--space-1)]' : 'pr-[var(--space-2-5)]'}`}
      >
        <span className="block max-w-full truncate text-[length:var(--tr-text-ui-size)] font-medium text-[var(--text-primary)]">{item.title}</span>
        {item.sub && <span className="block max-w-full truncate text-[length:var(--tr-text-small-size)] font-[var(--tr-text-small-weight)] text-[var(--text-muted)]">{item.sub}</span>}
      </button>
      {item.right && <span className="flex-none pr-[var(--space-2-5)]">{item.right}</span>}
    </div>
  )
}
