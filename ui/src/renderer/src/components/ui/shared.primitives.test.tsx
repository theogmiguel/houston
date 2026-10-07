// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import React, { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Drawer, ListDetail, Notice, RoutineDetail, Table, type ListDetailItem } from './index'

afterEach(cleanup)

const rows = [
  { rank: 1, model: 'opus', cost: '$10.00' },
  { rank: 2, model: 'codex', cost: '$2.00' }
]

function listItems(): ListDetailItem[] {
  return [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }, { id: 'three', title: 'Three' }]
}

describe('shared table, list-detail, drawer and notice primitives', () => {
  it('renders a routine detail panel with schedule, enabled state and working run action', () => {
    const onRunNow = vi.fn()
    const routine = {
      id: 7, name: 'Nightly dependency check', prompt: 'Update packages', cadence: { type: 'clock' as const, hour: 2, minute: 0, weekdays: null }, enabled: true,
      engine: 'claude' as const, next_run_at_ms: 10_000, last_run_at_ms: null, permission_mode: 'accept_edits' as const,
      isolate: false, revision: 'r1'
    }
    render(<RoutineDetail routine={routine} runs={[]} runsLoading={false} now={0} running={false} pending={false} atLimit={{ running: 3, limit: 3 }} onRunNow={onRunNow} onToggleEnabled={() => {}} onEdit={() => {}} onDelete={() => {}} onUpdateSchedule={() => {}} onUpdateEngine={() => {}} onOpenSession={() => {}} />)
    expect(screen.getByRole('heading', { name: routine.name })).toBeTruthy()
    expect(screen.getByText('3 of 3 running. Routines run 3 at a time (Settings › Routines).')).toBeTruthy()
    screen.getByRole('button', { name: 'Run now' }).click()
    expect(onRunNow).toHaveBeenCalledOnce()
  })

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

  it('shows one empty card, not an empty list beside an empty detail, when there is nothing to list', () => {
    render(<ListDetail items={[]} selectedId={null} onSelect={() => {}} backLabel="Back" listEmpty={<p>No routines</p>} renderDetail={() => <p>Select a routine</p>} />)
    expect(screen.getByText('No routines')).toBeTruthy()
    expect(screen.queryByText('Select a routine')).toBeNull()
    expect(screen.queryByTestId('list-detail-detail')).toBeNull()
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

  it('supports a headerless drawer labelled by its dialog purpose', () => {
    const onClose = vi.fn()
    function Example(): React.JSX.Element {
      const [open, setOpen] = React.useState(false)
      return <><button onClick={() => setOpen(true)}>Open task</button><Drawer open={open} heading="Task details" hideHeader tone="content" onClose={() => { onClose(); setOpen(false) }}><button>Close task details</button></Drawer></>
    }
    render(<Example />)
    const opener = screen.getByRole('button', { name: 'Open task' })
    opener.focus()
    fireEvent.click(opener)
    const drawer = screen.getByRole('dialog', { name: 'Task details' })
    expect(drawer.className).toContain('bg-[var(--content-bg)]')
    expect(within(drawer).queryByRole('button', { name: 'Close drawer' })).toBeNull()
    const close = within(drawer).getByRole('button', { name: 'Close task details' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
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
