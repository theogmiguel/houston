// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DataTable, type DataTableColumn } from './DataTable'

interface Row {
  id: string
  name: string
  count: number
}

const COLUMNS: DataTableColumn<Row>[] = [
  { key: 'name', header: 'Name', render: (r) => r.name },
  { key: 'count', header: 'Count', numeric: true, render: (r) => r.count }
]

describe('DataTable — state matrix', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('Empty — rows undefined renders the not-fetched-yet row, distinct from an empty set', () => {
    act(() => {
      root.render(<DataTable columns={COLUMNS} getRowId={(r) => r.id} aria-label="Test table" />)
    })
    expect(container.querySelector('[data-testid="data-table"]')?.getAttribute('data-state')).toBe('empty')
    expect(container.querySelector('[data-testid="data-table-empty"]')).not.toBeNull()
  })

  it('Empty set — rows=[] renders the caller-provided empty-set label, not the not-fetched-yet copy', () => {
    act(() => {
      root.render(
        <DataTable columns={COLUMNS} rows={[]} getRowId={(r) => r.id} aria-label="Test table" emptySetLabel="No rows" />
      )
    })
    expect(container.querySelector('[data-testid="data-table"]')?.getAttribute('data-state')).toBe('empty-set')
    expect(container.querySelector('[data-testid="data-table-empty-set"]')?.textContent).toBe('No rows')
  })

  it('Filled — renders one row per item, in a real <table> with a sticky, opaque head', () => {
    const rows: Row[] = [
      { id: '1', name: 'Alpha', count: 3 },
      { id: '2', name: 'Beta', count: 12 }
    ]
    act(() => {
      root.render(<DataTable columns={COLUMNS} rows={rows} getRowId={(r) => r.id} aria-label="Test table" />)
    })
    expect(container.querySelectorAll('[data-testid="data-table-row"]')).toHaveLength(2)
    expect(container.querySelector('table')?.getAttribute('aria-label')).toBe('Test table')
    const head = container.querySelector('[data-testid="data-table-head"]')
    expect(head?.className).toContain('sticky')
    expect(head?.className).toContain('bg-[var(--surface)]')
  })

  it('Filled — hairline rows use --divider, not --border (the container-edge weight)', () => {
    const rows: Row[] = [{ id: '1', name: 'Alpha', count: 3 }]
    act(() => {
      root.render(<DataTable columns={COLUMNS} rows={rows} getRowId={(r) => r.id} aria-label="Test table" />)
    })
    const row = container.querySelector('[data-testid="data-table-row"]')
    expect(row?.className).toContain('border-[var(--divider)]')
    expect(row?.className).not.toContain('border-[var(--border)]')
  })

  it('Filled — a numeric column right-aligns with tabular-nums, so digits line up', () => {
    const rows: Row[] = [{ id: '1', name: 'Alpha', count: 3 }]
    act(() => {
      root.render(<DataTable columns={COLUMNS} rows={rows} getRowId={(r) => r.id} aria-label="Test table" />)
    })
    const cells = Array.from(container.querySelectorAll('td'))
    const countCell = cells.find((c) => c.textContent === '3')
    expect(countCell?.className).toContain('tabular-nums')
    expect(countCell?.className).toContain('text-right')
    const nameCell = cells.find((c) => c.textContent === 'Alpha')
    expect(nameCell?.className).not.toContain('tabular-nums')
  })

  it('Loading — shows a spinner row and marks the table aria-busy', () => {
    act(() => {
      root.render(<DataTable columns={COLUMNS} rows={undefined} getRowId={(r) => r.id} aria-label="Test table" loading />)
    })
    expect(container.querySelector('[data-testid="data-table"]')?.getAttribute('aria-busy')).toBe('true')
    expect(container.querySelector('[role="status"][aria-label="Loading"]')).not.toBeNull()
  })

  it('Error — reddens the border and offers Try again, which calls onRetry once', () => {
    const onRetry = vi.fn()
    act(() => {
      root.render(
        <DataTable
          columns={COLUMNS}
          rows={undefined}
          getRowId={(r) => r.id}
          aria-label="Test table"
          error={{ message: 'Fetch failed', onRetry }}
        />
      )
    })
    expect(container.querySelector('[data-testid="data-table"]')?.className).toContain('border-[var(--danger)]')
    const retry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Try again')
    expect(retry).not.toBeUndefined()
    act(() => (retry as HTMLButtonElement).click())
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('Hover — a row with onRowClick carries hover treatment and a pointer cursor; one without does not', () => {
    const rows: Row[] = [{ id: '1', name: 'Alpha', count: 3 }]
    act(() => {
      root.render(<DataTable columns={COLUMNS} rows={rows} getRowId={(r) => r.id} aria-label="Test table" onRowClick={() => {}} />)
    })
    const clickableRow = container.querySelector('[data-testid="data-table-row"]')
    expect(clickableRow?.className).toContain('cursor-pointer')
    expect(clickableRow?.className).toContain('hover:bg-')

    act(() => {
      root.render(<DataTable columns={COLUMNS} rows={rows} getRowId={(r) => r.id} aria-label="Test table" />)
    })
    const plainRow = container.querySelector('[data-testid="data-table-row"]')
    expect(plainRow?.className).not.toContain('cursor-pointer')
  })

  it('Active — clicking a row with onRowClick fires it with that row once', () => {
    const rows: Row[] = [
      { id: '1', name: 'Alpha', count: 3 },
      { id: '2', name: 'Beta', count: 12 }
    ]
    const onRowClick = vi.fn()
    act(() => {
      root.render(<DataTable columns={COLUMNS} rows={rows} getRowId={(r) => r.id} aria-label="Test table" onRowClick={onRowClick} />)
    })
    const rowsEl = container.querySelectorAll('[data-testid="data-table-row"]')
    act(() => (rowsEl[1] as HTMLElement).click())
    expect(onRowClick).toHaveBeenCalledTimes(1)
    expect(onRowClick).toHaveBeenCalledWith(rows[1])
  })

  it('Disabled / Selected — N/A: rows have no disabled or selected concept of their own in this generic primitive; a caller that needs either composes it into a column\'s own render (a Chip, a checkbox cell).', () => {
    expect(true).toBe(true)
  })

  it('Overflow — a scroll container caps body height so the sticky head, not page growth, handles overflow', () => {
    const rows: Row[] = [{ id: '1', name: 'Alpha', count: 3 }]
    act(() => {
      root.render(
        <DataTable columns={COLUMNS} rows={rows} getRowId={(r) => r.id} aria-label="Test table" maxBodyHeight={120} />
      )
    })
    const scrollBox = container.querySelector('[data-testid="data-table"] > div')
    expect((scrollBox as HTMLElement)?.style.maxHeight).toBe('120px')
  })
})
