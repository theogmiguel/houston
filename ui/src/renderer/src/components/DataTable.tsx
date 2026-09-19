import type { ReactNode } from 'react'

export interface DataTableColumn<T> {
  key: string
  header: string
  numeric?: boolean
  width?: string
  render: (row: T) => ReactNode
}

export interface DataTableError {
  message: string
  onRetry: () => void
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[]
  rows?: T[]
  getRowId: (row: T) => string
  loading?: boolean
  error?: DataTableError
  emptySetLabel?: string
  onRowClick?: (row: T) => void
  maxBodyHeight?: number
  'aria-label': string
  className?: string
}

function Spinner(): React.JSX.Element {
  return (
    <span
      role="status"
      aria-label="Loading"
      className="inline-block h-[14px] w-[14px] animate-spin rounded-full border-2 border-current border-t-transparent opacity-70"
    />
  )
}

function colStyle<T>(col: DataTableColumn<T>): React.CSSProperties | undefined {
  if (!col.width) return undefined
  return { width: col.width, flex: `0 0 ${col.width}` }
}

export function DataTable<T>({
  columns,
  rows,
  getRowId,
  loading = false,
  error,
  emptySetLabel = 'Nothing here yet',
  onRowClick,
  maxBodyHeight = 360,
  className = '',
  ...rest
}: DataTableProps<T>): React.JSX.Element {
  const ariaLabel = rest['aria-label']
  const isEmpty = rows === undefined
  const isEmptySet = !isEmpty && !error && !loading && rows.length === 0
  const colCount = columns.length

  return (
    <div
      data-testid="data-table"
      aria-busy={loading || undefined}
      data-state={error ? 'error' : loading ? 'loading' : isEmpty ? 'empty' : isEmptySet ? 'empty-set' : 'filled'}
      className={`rounded-[var(--tr-radius-card)] border overflow-hidden ${
        error ? 'border-[var(--danger)]' : 'border-[var(--border)]'
      } ${className}`}
    >
      <div className="overflow-y-auto" style={{ maxHeight: maxBodyHeight }}>
        <table aria-label={ariaLabel} className="w-full border-collapse text-[length:var(--tr-text-ui-size)]">
          <thead
            data-testid="data-table-head"
            className="sticky top-0 z-[var(--z-base)] bg-[var(--surface)] border-b border-[var(--divider)]"
          >
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  style={colStyle(col)}
                  className={`h-[var(--h-row)] px-[var(--space-3)] font-medium text-[var(--text-secondary)] whitespace-nowrap ${
                    col.numeric ? 'text-right' : 'text-left'
                  }`}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {error ? (
              <tr>
                <td colSpan={colCount} className="px-[var(--space-3)] py-[var(--space-3)]">
                  <div className="flex items-center gap-[var(--space-2)] text-[var(--status-blocked-text)]">
                    <span>{error.message}</span>
                    <button
                      type="button"
                      onClick={error.onRetry}
                      className="rounded-[var(--tr-radius-button)] px-[var(--space-2)] h-[var(--h-ctl-mini)] border border-current text-[length:var(--tr-text-small-size)] font-semibold bg-transparent"
                    >
                      Try again
                    </button>
                  </div>
                </td>
              </tr>
            ) : loading ? (
              <tr>
                <td colSpan={colCount} className="px-[var(--space-3)] py-[var(--space-3)] text-[var(--text-muted)]">
                  <span className="inline-flex items-center gap-[var(--space-2)]">
                    <Spinner /> Loading…
                  </span>
                </td>
              </tr>
            ) : isEmpty ? (
              <tr data-testid="data-table-empty">
                <td colSpan={colCount} className="px-[var(--space-3)] py-[var(--space-3)] text-[var(--text-muted)]">
                  Nothing loaded yet
                </td>
              </tr>
            ) : isEmptySet ? (
              <tr data-testid="data-table-empty-set">
                <td colSpan={colCount} className="px-[var(--space-3)] py-[var(--space-3)] text-[var(--text-muted)]">
                  {emptySetLabel}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const id = getRowId(row)
                const clickable = !!onRowClick
                return (
                  <tr
                    key={id}
                    data-testid="data-table-row"
                    onClick={clickable ? () => onRowClick(row) : undefined}
                    className={`border-b border-[var(--divider)] last:border-b-0 ${
                      clickable ? 'cursor-pointer hover:bg-[var(--surface-hover)]' : ''
                    }`}
                  >
                    {columns.map((col) => (
                      <td
                        key={col.key}
                        style={colStyle(col)}
                        className={`h-[var(--h-row)] px-[var(--space-3)] text-[var(--text-primary)] ${
                          col.numeric ? 'text-right tabular-nums' : 'text-left'
                        }`}
                      >
                        {col.render(row)}
                      </td>
                    ))}
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
