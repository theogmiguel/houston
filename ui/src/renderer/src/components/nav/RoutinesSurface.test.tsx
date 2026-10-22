// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Routine } from '../../houston/routineTypes'
import { RoutinesSurface } from './RoutinesSurface'
import { openSelect, pickOption } from '../../test/selectHarness'
import type { RoutineEngineRefusal } from '../../houston/generated/RoutineEngineRefusal'

const NOW = 10_000

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void { this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver) }
    disconnect(): void {}
    unobserve(): void {}
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1040)
})

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function routine(id: number, name = `Routine ${id}`, next = NOW + 60_000): Routine {
  return {
    kind: 'user', id, name, prompt: 'Check the project.', cadence: { type: 'clock', hour: 9, minute: 0, weekdays: null },
    enabled: true, engine: 'claude', next_run_at_ms: next, last_run_at_ms: null, permission_mode: 'accept_edits',
    isolate: false, revision: `rev-${id}`
  }
}

function surface(overrides: Partial<React.ComponentProps<typeof RoutinesSurface>> = {}): React.JSX.Element {
  return <RoutinesSurface
    routines={[routine(1), routine(2)]}
    running={[]}
    runs={{}}
    runsLoading={null}
    workspaces={[]}
    error={null}
    onDismissError={() => {}}
    onCreate={() => {}}
    onUpdate={() => {}}
    onDelete={() => {}}
    onRunNow={() => {}}
    onLoadRuns={() => {}}
    onOpenSession={() => {}}
    onRequest={() => {}}
    now={NOW}
    {...overrides}
  />
}

const ZCODE_REFUSAL: RoutineEngineRefusal = {
  engine: 'zcode',
  permission_mode: 'accept_edits',
  reason: 'its edit mode waits for approval on every shell command, and nobody gives it'
}

function disabledEngines(container: HTMLElement, testId: string): (string | undefined)[] {
  return openSelect(container, testId)
    .filter((row) => row.getAttribute('aria-disabled') === 'true')
    .map((row) => row.dataset.value)
}

describe('Routines page', () => {
  const workspaces = Array.from({ length: 7 }, (_, index) => ({ id: `/workspace-${index}`, name: `Workspace ${index}` }))
  const reviews = [0, 1].map((index) => ({ ...routine(index + 10), kind: 'harness_review' as const, workspace_id: workspaces[index].id, last_run_at_ms: NOW - 60_000 }))
  const client = { subscribe: () => () => {}, harnessState: vi.fn(), nightShiftState: vi.fn() } as unknown as import('../../houston/client').HoustonClient

  it('shows one built-in row across seven workspaces and leaves Yours unchanged', () => {
    render(surface({ client, routines: [...reviews, routine(3, 'My review')], workspaces, selectedRoutineId: 3 }))
    expect(screen.getAllByTestId('list-detail-section').map((node) => node.textContent)).toEqual(['Built in', 'Yours'])
    const rows = screen.getAllByTestId('list-detail-item')
    expect(rows).toHaveLength(3)
    expect(rows[0].textContent).toBe('Weekly reviewOn in 2 of 7 workspaces')
    expect(rows[1].textContent).toBe('Night shiftNot set up')
    expect(rows[2].textContent).toContain('My review')
    expect(screen.queryByRole('button', { name: 'Set up Weekly review' })).toBeNull()
  })

  it('shows Running on the Weekly review row while any workspace review runs', () => {
    const { rerender } = render(surface({ client, routines: reviews, workspaces, running: [], selectedRoutineId: 10 }))
    expect(within(screen.getAllByTestId('list-detail-item')[0]).queryByText('Running')).toBeNull()
    rerender(surface({ client, routines: reviews, workspaces, running: [reviews[1].id], selectedRoutineId: 10 }))
    const row = screen.getAllByTestId('list-detail-item')[0]
    expect(within(row).getByText('Running')).toBeTruthy()
    expect(row.textContent).toContain('On in 2 of 7 workspaces')
  })

  it('makes Weekly review the page heading and each workspace a sub-heading', () => {
    render(surface({ client, routines: reviews, workspaces, selectedRoutineId: 10 }))
    const detail = screen.getByTestId('list-detail-detail')
    const page = within(detail).getByRole('heading', { name: 'Weekly review' })
    expect(page.tagName).toBe('H2')
    expect(within(detail).getByText('Built in')).toBeTruthy()
    expect(within(detail).getByRole('heading', { name: 'Workspace 0' }).tagName).toBe('H3')
    expect(within(detail).getAllByText('Built in')).toHaveLength(1)
  })

  it('lists only configured workspaces and offers only the remainder for setup', () => {
    const { container } = render(surface({ client, routines: reviews, workspaces, selectedRoutineId: 11 }))
    const detail = screen.getByTestId('list-detail-detail')
    expect(within(detail).getByRole('heading', { name: 'Workspace 0' })).toBeTruthy()
    expect(within(detail).getByRole('heading', { name: 'Workspace 1' })).toBeTruthy()
    expect(within(detail).queryByText('Workspace 2')).toBeNull()
    expect(within(detail).getAllByText(/Next run:/)).toHaveLength(2)
    expect(within(detail).getAllByText(/Last run:/)).toHaveLength(2)
    expect(openSelect(container, 'review-setup-workspace').map((row) => row.dataset.value)).toEqual(workspaces.slice(2).map((workspace) => workspace.id))
    pickOption(container, 'review-setup-workspace', '/workspace-4')
    expect(screen.getByRole('heading', { name: 'Set up Weekly review' })).toBeTruthy()
    expect(screen.getByText('Review sessions in Workspace 4.')).toBeTruthy()
  })

  it('retains grouped selection after removal and supports keyboard movement to Yours', async () => {
    const { rerender } = render(surface({ client, routines: [...reviews, routine(3)], workspaces }))
    fireEvent.click(screen.getAllByTestId('list-detail-item')[0])
    rerender(surface({ client, routines: [routine(3)], workspaces }))
    expect(screen.getAllByTestId('list-detail-item')[0].getAttribute('aria-current')).toBe('true')
    expect(screen.getAllByText('Not set up')).toHaveLength(2)
    fireEvent.keyDown(screen.getAllByTestId('list-detail-item')[1], { key: 'ArrowDown' })
    expect(await screen.findByRole('heading', { name: 'Routine 3' })).toBeTruthy()
    fireEvent.keyDown(screen.getAllByTestId('list-detail-item')[1], { key: 'ArrowUp' })
    expect(screen.getByRole('heading', { name: 'Weekly review' })).toBeTruthy()
  })

  it('keeps controlled group selection when its last review is removed', () => {
    const onRoutineSelect = vi.fn()
    function Harness({ routines }: { routines: Routine[] }): React.JSX.Element {
      const [selectedRoutineId, setSelectedRoutineId] = useState<number | null>(3)
      return surface({ client, routines, workspaces, selectedRoutineId, onRoutineSelect: (id) => { onRoutineSelect(id); setSelectedRoutineId(id) } })
    }
    const { rerender } = render(<Harness routines={[...reviews, routine(3)]} />)
    fireEvent.keyDown(screen.getAllByTestId('list-detail-item')[1], { key: 'ArrowUp' })
    expect(onRoutineSelect).toHaveBeenCalledWith(0)
    expect(screen.getByRole('heading', { name: 'Workspace 1' })).toBeTruthy()
    rerender(<Harness routines={[routine(3)]} />)
    expect(screen.getByRole('heading', { name: 'No workspaces set up' })).toBeTruthy()
    expect(screen.getAllByTestId('list-detail-item')[0].getAttribute('aria-current')).toBe('true')
  })

  it('routes each workspace action to its own review and revision', () => {
    const onRunNow = vi.fn()
    const onUpdate = vi.fn()
    const onDelete = vi.fn()
    render(surface({ client, routines: reviews, workspaces, onRunNow, onUpdate, onDelete }))
    const second = screen.getByRole('region', { name: 'Review for Workspace 1' })
    fireEvent.click(within(second).getByRole('button', { name: 'Run now' }))
    expect(onRunNow).toHaveBeenCalledWith(11)
    expect(within(second).getByRole('button', { name: 'Starting…' })).toBeTruthy()
    fireEvent.click(within(second).getByRole('switch', { name: 'Weekly review enabled' }))
    expect(onUpdate).toHaveBeenCalledWith({ id: 11, expected_revision: 'rev-11', enabled: false })
    fireEvent.click(within(second).getByRole('radio', { name: 'Weekly' }))
    expect(onUpdate).toHaveBeenCalledWith({ id: 11, expected_revision: 'rev-11', enabled: true, cadence: { type: 'clock', hour: 9, minute: 0, weekdays: [2] } })
    fireEvent.click(within(second).getByRole('button', { name: 'Routine actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(onDelete).toHaveBeenCalledWith(11, 'rev-11')
    fireEvent.click(within(second).getByRole('button', { name: 'Change review provider and model' }))
    expect(screen.getByLabelText('Name').getAttribute('value')).toBe('Routine 11')
  })

  it('counts enabled reviews and hides setup when all workspaces have a review', () => {
    render(surface({ client, routines: [reviews[0], { ...reviews[1], enabled: false }], workspaces: workspaces.slice(0, 2) }))
    expect(screen.getByText('On in 1 of 2 workspaces')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Set up for a workspace' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Workspace 1' })).toBeTruthy()
  })
  it("Runs on disables an engine the routine's access refuses and offers it once the access allows it", async () => {
    const isolated = { ...routine(2), permission_mode: 'bypass_permissions' as const, isolate: true }
    const { container, rerender } = render(surface({ routines: [routine(1)], engineRefusals: [ZCODE_REFUSAL] }))
    await screen.findByRole('heading', { name: 'Routine 1' })
    expect(disabledEngines(container, 'routine-detail-engine')).toEqual(['zcode'])
    const zcode = openSelect(container, 'routine-detail-engine').find((row) => row.dataset.value === 'zcode')!
    expect(zcode.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe(
      `ZCode needs isolated full access: ${ZCODE_REFUSAL.reason}. Change the routine's access with Edit first.`
    )
    rerender(surface({ routines: [isolated], engineRefusals: [ZCODE_REFUSAL] }))
    await screen.findByRole('heading', { name: 'Routine 2' })
    expect(disabledEngines(container, 'routine-detail-engine')).toEqual([])
  })

  it('the new-routine editor receives the same refusals', async () => {
    const { container } = render(surface({ engineRefusals: [ZCODE_REFUSAL] }))
    fireEvent.click(screen.getByTestId('routine-create'))
    expect(disabledEngines(container, 'routine-engine')).toEqual(['zcode'])
  })

  it('uses the page title and opens the first selected routine in the list-detail view', async () => {
    render(surface())
    expect(screen.getByRole('heading', { name: 'Routines' })).toBeTruthy()
    expect(screen.queryByText('Next up')).toBeNull()
    expect(await screen.findByRole('heading', { name: 'Routine 1' })).toBeTruthy()
    expect(screen.getByText('Schedule')).toBeTruthy()
    expect(screen.getByText('Runs on')).toBeTruthy()
  })

  it('honors a deep-linked selection', () => {
    render(surface({ selectedRoutineId: 2 }))
    expect(screen.getByRole('heading', { name: 'Routine 2' })).toBeTruthy()
  })

  it('keeps local selection controlled while selecting a routine from the list', () => {
    function Harness(): React.JSX.Element {
      const [selectedRoutineId, setSelectedRoutineId] = useState<number | null>(2)
      return surface({ selectedRoutineId, onRoutineSelect: setSelectedRoutineId })
    }
    render(<Harness />)
    fireEvent.click(screen.getAllByTestId('list-detail-item')[2])
    expect(screen.getByRole('heading', { name: 'Routine 1' })).toBeTruthy()
  })

  it('shows a pending state until the daemon reports the run as active', () => {
    const onRunNow = vi.fn()
    render(surface({ routines: [routine(1)], onRunNow }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Run now' })[0])
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeTruthy()
    expect(onRunNow).toHaveBeenCalledWith(1)
  })

  it('shows the real concurrency count and waiting status for due routines', () => {
    render(surface({
      routines: [routine(1, 'Active 1'), routine(2, 'Active 2'), routine(3, 'Active 3'), routine(4, 'Queued', NOW - 1)],
      running: [1, 2, 3],
      selectedRoutineId: 4
    }))
    expect(screen.getByText('3 of 3 running. Routines run 3 at a time (Settings › Routines).')).toBeTruthy()
    expect(screen.getAllByLabelText('Waiting for a slot').length).toBeGreaterThan(0)
  })
})
