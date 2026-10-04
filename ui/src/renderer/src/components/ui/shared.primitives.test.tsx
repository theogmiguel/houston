// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import React, { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Drawer, ListDetail, Notice, Table, type ListDetailItem } from './index'

const rows = [
  { rank: 1, model: 'opus', cost: '$10.00' },
  { rank: 2, model: 'codex', cost: '$2.00' }
]

function listItems(): ListDetailItem[] {
  return [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }, { id: 'three', title: 'Three' }]
}

describe('shared table, list-detail, drawer and notice primitives', () => {
  it('types columns by row key and aligns numeric columns with tabular figures', () => {
    render(<Table aria-label="Usage breakdown" rows={rows} getRowId={(row) => row.model} columns={[{ key: 'rank', header: '#' }, { key: 'model', header: 'Model' }, { key: 'cost', header: 'Cost', numeric: true }]} />)
    const table = screen.getByRole('table', { name: 'Usage breakdown' })
    expect(within(table).getByRole('columnheader', { name: 'Cost' }).className).toContain('text-right')
    expect(within(table).getByRole('cell', { name: '$10.00' }).className).toContain('tabular-nums')
    // @ts-expect-error columns must use a key from the row type
    const invalidColumn = <Table aria-label="Bad" rows={rows} getRowId={() => 'bad'} columns={[{ key: 'missing', header: 'Missing' }]} />
    void invalidColumn
  })

  it('supports row click by mouse and keyboard and ignores nested actions', () => {
    const onRowClick = vi.fn()
    const onAction = vi.fn()
    render(<Table aria-label="Rows" rows={rows} getRowId={(row) => row.model} onRowClick={onRowClick} rowAction={() => <button onClick={onAction}>Open</button>} columns={[{ key: 'model', header: 'Model' }]} />)
    const row = within(screen.getByRole('table', { name: 'Rows' })).getByText('opus').closest('tr')!
    row.focus()
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(onRowClick).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getAllByRole('button', { name: 'Open' })[0])
    expect(onAction).toHaveBeenCalledOnce()
    expect(onRowClick).toHaveBeenCalledOnce()
  })

  it('shows EmptyState and Notice for empty and error states', () => {
    const { rerender } = render(<Table aria-label="Empty" rows={rows.slice(0, 0)} getRowId={(row) => row.model} columns={[{ key: 'model', header: 'Model' }]} empty={{ heading: 'No models', description: 'Choose another range.' }} />)
    expect(screen.getByRole('heading', { name: 'No models' })).toBeTruthy()
    rerender(<Table aria-label="Error" rows={rows} getRowId={(row) => row.model} columns={[{ key: 'model', header: 'Model' }]} error={{ message: 'Could not load usage.' }} />)
    expect(screen.getByRole('alert').textContent).toContain('Could not load usage.')
  })

  it('controls list selection and moves it with the arrow keys', () => {
    function ControlledList(): React.JSX.Element {
      const [selectedId, setSelectedId] = useState<string | null>('one')
      return <ListDetail items={listItems()} selectedId={selectedId} onSelect={setSelectedId} backLabel="Back" renderDetail={(item) => <div>{item?.title ?? 'No selection'}</div>} />
    }
    render(<ControlledList />)
    const first = screen.getByRole('button', { name: 'One' })
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(screen.getByRole('button', { name: 'Two' }).getAttribute('aria-current')).toBe('true')
  })

  it('traps focus, closes on Escape and restores focus to the opener', () => {
    const onClose = vi.fn()
    function Example(): React.JSX.Element {
      const [open, setOpen] = React.useState(false)
      return <><button onClick={() => setOpen(true)}>Open drawer</button><Drawer open={open} heading="Task details" onClose={() => { onClose(); setOpen(false) }}><button>First action</button><button>Last action</button></Drawer></>
    }
    render(<Example />)
    const opener = screen.getByRole('button', { name: 'Open drawer' })
    opener.focus()
    fireEvent.click(opener)
    const drawer = screen.getByRole('dialog', { name: 'Task details' })
    const close = within(drawer).getByRole('button', { name: 'Close drawer' })
    expect(document.activeElement).toBe(close)
    close.focus()
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    const lastAction = within(drawer).getByRole('button', { name: 'Last action' })
    expect(document.activeElement).toBe(lastAction)
    fireEvent.keyDown(lastAction, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(opener)
    fireEvent.click(opener)
    fireEvent.mouseDown(screen.getByTestId('drawer-backdrop'))
    expect(screen.queryByRole('dialog', { name: 'Task details' })).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(document.activeElement).toBe(opener)
  })

  it('closes when the backdrop is pressed and renders tone and optional action', () => {
    const onClick = vi.fn()
    render(<Notice tone="warn" action={{ label: 'Settings', onClick }}>3 of 3 running.</Notice>)
    expect(screen.getByText('3 of 3 running.').closest('[data-tone]')?.getAttribute('data-tone')).toBe('warn')
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(onClick).toHaveBeenCalledOnce()
  })
})
