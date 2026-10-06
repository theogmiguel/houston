// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  renderReadyApp,
  resetHarness,
  currentClient,
  deliverControl,
  type AppHarness
} from './test/appTestHarness'
import type { Routine } from './houston/generated/Routine'
import type { RoutineRun } from './houston/generated/RoutineRun'

const q = (c: Element, sel: string): Element | null => c.querySelector(sel)

function routine(over: Partial<Routine> = {}): Routine {
  return {
    id: 1,
    engine: 'claude',
    name: 'Inbox triage',
    prompt: 'Read the inbox.',
    cadence: { type: 'clock', hour: 9, minute: 0, weekdays: null },
    enabled: true,
    workspace_id: null,
    permission_mode: 'accept_edits',
    isolate: false,
    next_run_at_ms: 4102444800000,
    last_run_at_ms: null,
    last_run_session_id: null,
    last_error: null,
    revision: 'abc123',
    ...over
  }
}

function run(over: Partial<RoutineRun> = {}): RoutineRun {
  return {
    id: 5,
    routine_id: 1,
    trigger: 'schedule',
    status: 'ok',
    session_id: 9,
    error: null,
    started_at_ms: 4102444700000,
    ended_at_ms: 4102444750000,
    ...over
  }
}

async function openRoutines(container: Element): Promise<void> {
  const { act } = await import('react')
  const row = q(container, '[data-testid="rail-nav-row"][data-view="routines"]')
  expect(row, 'the rail has no Routines nav row').not.toBeNull()
  act(() => (row as HTMLElement).click())
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const { act } = await import('react')
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
  }
  throw new Error('Timed out waiting for the routine surface to update')
}

describe('App — Routines wiring', () => {
  let harness: AppHarness | null = null

  beforeEach(() => {
    resetHarness()
  })
  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('asks the daemon for the roster at connect', async () => {
    harness = await renderReadyApp()
    expect(currentClient().routineList).toHaveBeenCalled()
  })

  it('a delivered roster renders in the Routines list-detail page', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    const { act } = await import('react')
    await openRoutines(container)
    act(() => deliverControl({ type: 'routines', running: [], routines: [routine()] }))
    await waitFor(() => container.querySelector('[data-testid="routine-run-now"]') !== null)
    expect(container.textContent).toContain('Inbox triage')
    expect(container.querySelector('[data-testid="routine-create"]')).toBeTruthy()
    expect(container.textContent).toContain('Schedule')
  })

  it('a run in flight shows the Working status', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    const { act } = await import('react')
    await openRoutines(container)
    act(() => deliverControl({ type: 'routines', running: [1], routines: [routine()] }))
    await waitFor(() => container.textContent?.includes('Working') ?? false)
    expect(container.textContent).toContain('Working')
  })

  it('loads a routine\'s history and opens the delivered run pane', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    const { act } = await import('react')
    await openRoutines(container)
    act(() => deliverControl({ type: 'routines', running: [], routines: [routine()] }))
    await waitFor(() => container.textContent?.includes('Loading runs…') ?? false)
    expect(currentClient().routineRuns).toHaveBeenCalledWith(1)
    act(() => deliverControl({ type: 'routine_runs', runs: [run()] }))
    await waitFor(() => container.querySelector('[data-testid="routine-run-open"]') !== null)
    expect(container.querySelector('[data-testid="routine-run-open"]')).toBeTruthy()
  })

  it('a run event for a loaded routine lands in its history without another request', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    const { act } = await import('react')
    await openRoutines(container)
    act(() => deliverControl({ type: 'routines', running: [], routines: [routine()] }))
    await waitFor(() => container.textContent?.includes('Loading runs…') ?? false)
    act(() => deliverControl({ type: 'routine_runs', runs: [] }))
    await waitFor(() => container.textContent?.includes('No runs yet') ?? false)
    act(() =>
      deliverControl({
        type: 'routine_run_event',
        run: run({ id: 6, status: 'running', ended_at_ms: null })
      })
    )
    await waitFor(() => container.textContent?.includes('Working') ?? false)
    expect(container.querySelectorAll('[data-testid="table-row"]')).toHaveLength(1)
    expect(container.textContent).toContain('Working')
  })
})
