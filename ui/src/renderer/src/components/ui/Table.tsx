import type { KeyboardEvent, ReactNode } from 'react'
import { IconDatabase, type IconComponent } from '../icons'
import { Notice } from './Notice'
import { EmptyState } from './EmptyState'

export interface TableColumn<T, K extends keyof T = keyof T> {
  key: K
  header: string
  numeric?: boolean
  weight?: 'default' | 'regular'
  tone?: TableCellTone
  width?: string
  render?: (value: T[K], row: T) => ReactNode
}

export type TableCellTone = 'primary' | 'muted' | 'faint'

export interface TableError {
  message: string
  onRetry?: () => void
}

export interface TableProps<T, K extends keyof T = keyof T> {
  columns: Array<TableColumn<T, K>>
  rows: T[]
  getRowId: (row: T) => string
  'aria-label': string
  rowAction?: (row: T) => ReactNode
  onRowClick?: (row: T) => void
  empty?: { heading: string; description: string; icon?: IconComponent }
  error?: TableError
  variant?: 'plain' | 'framed'
  className?: string
  density?: 'default' | 'compact'
  layout?: 'auto' | 'fixed'
}

const TABLE_CLS = 'w-full border-collapse text-[length:var(--tr-text-ui-size)]'
const CELL_CLS = 'border-t border-[var(--divider)] px-[var(--space-1-5)] py-[var(--space-2-5)]'
const HEADER_CLS = 'px-[var(--space-1-5)] pb-[var(--space-2-5)] text-left align-bottom text-[length:var(--tr-text-small-size)] font-normal text-[var(--text-muted)] whitespace-nowrap'
const VARIANT_CLS = {
  plain: { frame: '', edge: 'first:pl-0 last:pr-0', header: '' },
  framed: {
    frame: 'rounded-[var(--tr-radius-button)] border border-[var(--divider)]',
    edge: 'first:pl-[var(--space-2-5)] last:pr-[var(--space-2-5)]',
    header: 'pt-[var(--space-2)] pb-[var(--space-2)]'
  }
} as const
const TONE_CLS: Record<TableCellTone, string> = {
  primary: 'text-[var(--text-primary)]',
  muted: 'text-[var(--text-muted)]',
  faint: 'text-[var(--text-faint)]'
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('a, button, input, select, textarea, [role="button"]')
}

export function Table<T, K extends keyof T = keyof T>({
  columns,
  rows,
  getRowId,
  rowAction,
  onRowClick,
  empty = { heading: 'No rows', description: 'There is nothing to show yet.' },
  error,
  variant = 'plain',
  className = '',
  density = 'default',
  layout = 'auto',
  ...rest
}: TableProps<T, K>): React.JSX.Element {
  const ariaLabel = rest['aria-label']
  const look = VARIANT_CLS[variant]
  const cellClass = density === 'compact' ? 'px-[var(--space-1-5)] py-[var(--space-1)]' : CELL_CLS
  const handleRowKeyDown = (row: T) => (event: KeyboardEvent<HTMLTableRowElement>): void => {
    if (!onRowClick || isInteractiveTarget(event.target)) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onRowClick(row)
    }
  }

  if (error) {
    return <Notice tone="danger" action={error.onRetry ? { label: 'Try again', onClick: error.onRetry } : undefined} className={className}>{error.message}</Notice>
  }

  const emptyState = <EmptyState icon={empty.icon ?? IconDatabase} heading={empty.heading} description={empty.description} />
  if (rows.length === 0 && variant !== 'framed') {
    return <div className={`py-[var(--space-5)] ${className}`}>{emptyState}</div>
  }

  return (
    <div data-testid="table-frame" className={`overflow-x-auto ${look.frame} ${className}`}>
      <table aria-label={ariaLabel} className={`${TABLE_CLS} ${layout === 'fixed' ? 'table-fixed' : ''}`}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={String(column.key)} scope="col" style={column.width ? { width: column.width } : undefined} className={`${HEADER_CLS} ${density === 'compact' ? 'pb-[var(--space-1)]' : ''} ${look.edge} ${look.header} ${column.numeric ? 'text-right' : ''}`}>
                {column.header}
              </th>
            ))}
            {rowAction && <th scope="col" className={`${HEADER_CLS} ${look.edge} ${look.header} text-right`}><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={columns.length + (rowAction ? 1 : 0)} className="py-[var(--space-5)]">{emptyState}</td></tr>}
          {rows.map((row) => (
            <tr
              key={getRowId(row)}
              data-testid="table-row"
              tabIndex={onRowClick ? 0 : undefined}
              onClick={onRowClick ? (event) => { if (!isInteractiveTarget(event.target)) onRowClick(row) } : undefined}
              onKeyDown={handleRowKeyDown(row)}
              className={`hover:bg-[var(--hover-fill)] ${onRowClick ? 'cursor-pointer focus-visible:bg-[var(--hover-fill)] focus-visible:outline-none' : ''}`}
            >
              {columns.map((column) => {
                const value = row[column.key]
                return (
                  <td key={String(column.key)} className={`${cellClass} ${look.edge} ${TONE_CLS[column.tone ?? 'primary']} ${column.weight === 'regular' ? 'font-normal' : ''} ${column.numeric ? 'text-right tabular-nums' : ''}`}>
                    {column.render ? column.render(value, row) : String(value ?? '')}
                  </td>
                )
              })}
              {rowAction && <td className={`${cellClass} ${look.edge} text-right`}>{rowAction(row)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
