// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Routine } from '../../houston/routineTypes'
import { RoutinesSurface } from './RoutinesSurface'
import { openSelect } from '../../test/selectHarness'
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
  it('groups built-in reviews by kind and names each workspace', () => {
    render(surface({ routines: [
      { ...routine(1, 'Harness review'), kind: 'harness_review', workspace_id: '/a' },
      { ...routine(2, 'Harness review'), kind: 'harness_review', workspace_id: '/b' },
      { ...routine(3, 'My review'), prompt: '[houston harness review] a user prompt' }
    ], workspaces: [{ id: '/a', name: 'A' }, { id: '/b', name: 'B' }], selectedRoutineId: 3 }))
    const sections = screen.getAllByTestId('list-detail-section')
    expect(sections.map((node) => node.textContent)).toEqual(['Built in', 'Yours'])
    expect(screen.getAllByText('Weekly review')).toHaveLength(2)
    expect(screen.getByText('Daily 09:00 · A')).toBeTruthy()
    expect(screen.getByText('Daily 09:00 · B')).toBeTruthy()
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
