import type { KeyboardEvent, ReactNode } from 'react'
import { IconDatabase } from '../icons'
import { Notice } from './Notice'
import { EmptyState } from './EmptyState'

export interface TableColumn<T, K extends keyof T = keyof T> {
  key: K
  header: string
  numeric?: boolean
  width?: string
  render?: (value: T[K], row: T) => ReactNode
}

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
  empty?: { heading: string; description: string }
  error?: TableError
  className?: string
}

const TABLE_CLS = 'w-full border-collapse text-[length:var(--tr-text-ui-size)]'
const CELL_CLS = 'h-[var(--h-row)] border-b border-[var(--divider)] px-[var(--space-2-5)] text-[var(--text-secondary)] last:border-b-0'
const HEADER_CLS = 'h-[var(--h-row)] border-b border-[var(--divider)] px-[var(--space-2-5)] text-left text-[length:var(--tr-text-small-size)] font-semibold text-[var(--text-muted)] whitespace-nowrap'

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
  className = '',
  ...rest
}: TableProps<T, K>): React.JSX.Element {
  const ariaLabel = rest['aria-label']
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

  if (rows.length === 0) {
    return <div className={`py-[var(--space-5)] ${className}`}><EmptyState icon={IconDatabase} {...empty} /></div>
  }

  return (
    <div data-testid="table-frame" className={`overflow-x-auto rounded-[var(--tr-radius-button)] border border-[var(--divider)] bg-[var(--card-bg)] ${className}`}>
      <table aria-label={ariaLabel} className={TABLE_CLS}>
        <thead className="bg-[var(--card-bg)]">
          <tr>
            {columns.map((column) => (
              <th key={String(column.key)} scope="col" style={column.width ? { width: column.width } : undefined} className={`${HEADER_CLS} ${column.numeric ? 'text-right' : ''}`}>
                {column.header}
              </th>
            ))}
            {rowAction && <th scope="col" className={`${HEADER_CLS} text-right`}><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={getRowId(row)}
              data-testid="table-row"
              tabIndex={onRowClick ? 0 : undefined}
              onClick={onRowClick ? (event) => { if (!isInteractiveTarget(event.target)) onRowClick(row) } : undefined}
              onKeyDown={handleRowKeyDown(row)}
              className={onRowClick ? 'cursor-pointer hover:bg-[var(--hover-fill)] focus-visible:bg-[var(--hover-fill)] focus-visible:outline-none' : ''}
            >
              {columns.map((column) => {
                const value = row[column.key]
                return (
                  <td key={String(column.key)} className={`${CELL_CLS} ${column.numeric ? 'text-right tabular-nums text-[var(--text-primary)]' : ''}`}>
                    {column.render ? column.render(value, row) : String(value ?? '')}
                  </td>
                )
              })}
              {rowAction && <td className={`${CELL_CLS} text-right`}>{rowAction(row)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
