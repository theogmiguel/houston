// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Routine } from '../../houston/routineTypes'
import { RoutinesSurface } from './RoutinesSurface'

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
    id, name, prompt: 'Check the project.', cadence: { type: 'clock', hour: 9, minute: 0, weekdays: null },
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

describe('Routines page', () => {
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
    fireEvent.click(screen.getAllByTestId('list-detail-item')[0])
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
