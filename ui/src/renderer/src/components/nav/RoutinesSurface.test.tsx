// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RoutinesSurface, sortRoutines } from './RoutinesSurface'
import type { Routine, RoutineRun } from '../../houston/routineTypes'

function noop(): void {}

const NOW = new Date(2026, 8, 9, 12, 0, 0).getTime()

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 1,
    engine: 'claude',
    name: 'Leak watch',
    prompt: 'Check for leaked file descriptors.',
    cadence: { type: 'interval', seconds: 900 },
    enabled: true,
    workspace_id: null,
    permission_mode: 'accept_edits',
    isolate: false,
    next_run_at_ms: NOW + 3600_000,
    last_run_at_ms: null,
    last_run_session_id: null,
    last_error: null,
    revision: 'rev-1',
    ...overrides
  }
}

function run(overrides: Partial<RoutineRun> = {}): RoutineRun {
  return {
    id: 10,
    routine_id: 1,
    trigger: 'schedule',
    status: 'ok',
    session_id: 42,
    error: null,
    started_at_ms: NOW - 60_000,
    ended_at_ms: NOW - 30_000,
    ...overrides
  }
}

describe('RoutinesSurface — "Next up"', () => {
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
  })

  function render(props: Partial<React.ComponentProps<typeof RoutinesSurface>> = {}): void {
    act(() => {
      root.render(
        <RoutinesSurface
          routines={[]}
          running={[]}
          runs={{}}
          runsLoading={null}
          workspaces={[]}
          error={null}
          onDismissError={noop}
          onCreate={noop}
          onUpdate={noop}
          onDelete={noop}
          onRunNow={noop}
          onLoadRuns={noop}
          onOpenSession={noop}
          onRequest={noop}
          now={NOW}
          {...props}
        />
      )
    })
  }

  function rows(): HTMLElement[] {
    return Array.from(container.querySelectorAll('[data-testid="routine-row"]'))
  }

  function groupHeading(el: HTMLElement): string | null {
    return (
      el
        .closest('[data-testid="settings-group"]')
        ?.querySelector('[data-testid="settings-subhead"]')?.textContent ?? null
    )
  }

  it('a routine is created and edited here: New routine opens the editor in place', () => {
    render({ routines: [routine()] })
    expect(container.querySelector('[data-testid="routine-editor"]')).toBeNull()
    fireEvent.click(container.querySelector('[data-testid="routine-create"]')!)
    expect(container.querySelector('[data-testid="routine-editor"]')).toBeTruthy()
  })

  it('the row\'s edit action opens this surface\'s editor with the routine loaded', () => {
    render({ routines: [routine()] })
    fireEvent.click(container.querySelector('[data-testid="routine-edit"]')!)
    const editor = container.querySelector('[data-testid="routine-editor"]')
    expect(editor).toBeTruthy()
    expect(editor?.textContent).toContain('Leak watch')
  })

  it('says what a routine is when there is nothing scheduled, with no bot anywhere', () => {
    render()
    const empty = container.querySelector('[data-testid="routines-empty"]')
    expect(empty).toBeTruthy()
    expect(empty?.textContent).toContain('its own engine')
    expect(empty?.textContent).toContain('terminal pane')
    expect(container.textContent?.toLowerCase()).not.toContain('bot')
  })

  it('lists a paused routine under Paused instead of dropping it', () => {
    render({
      routines: [
        routine({ id: 1, name: 'Live' }),
        routine({ id: 2, name: 'Paused', enabled: false })
      ]
    })
    expect(rows()).toHaveLength(2)
    const paused = rows().find((r) => r.textContent?.includes('Paused'))!
    expect(groupHeading(paused)).toBe('Paused')
  })

  it('groups Today / This week / Later by the next fire\'s calendar day, soonest first', () => {
    render({
      routines: [
        routine({ id: 1, name: 'TodayOne', next_run_at_ms: NOW + 3600_000 }),
        routine({ id: 2, name: 'WeekOne', next_run_at_ms: NOW + 3 * 86_400_000 }),
        routine({ id: 3, name: 'LaterOne', next_run_at_ms: NOW + 10 * 86_400_000 })
      ]
    })
    const byName = (name: string): HTMLElement =>
      rows().find((r) => r.textContent?.includes(name))!
    expect(groupHeading(byName('TodayOne'))).toBe('Today')
    expect(groupHeading(byName('WeekOne'))).toBe('This week')
    expect(groupHeading(byName('LaterOne'))).toBe('Later')
  })

  it('says Running rather than a next time while a run is in flight', () => {
    render({ routines: [routine()], running: [1] })
    expect(rows()[0].textContent).toContain('Running')
    expect(rows()[0].getAttribute('data-state')).toBe('running')
  })

  it('runs a routine now through the row action', () => {
    const onRunNow = vi.fn()
    render({ routines: [routine()], onRunNow })
    fireEvent.click(container.querySelector('[data-testid="routine-run-now"]')!)
    expect(onRunNow).toHaveBeenCalledWith(1)
  })

  it('deletes with the revision the row currently shows', () => {
    const onDelete = vi.fn()
    render({ routines: [routine({ revision: 'rev-9' })], onDelete })
    fireEvent.click(container.querySelector('[data-testid="routine-delete"]')!)
    expect(onDelete).toHaveBeenCalledWith(1, 'rev-9')
  })

  it('history: opening the chevron for an uncached routine asks for its runs', () => {
    const onLoadRuns = vi.fn()
    render({ routines: [routine()], runs: {}, runsLoading: 1, onLoadRuns })
    expect(container.querySelector('[data-testid="routine-history"]')).toBeNull()
    fireEvent.click(container.querySelector('[data-testid="routine-history-toggle"]')!)
    expect(onLoadRuns).toHaveBeenCalledWith(1)
    expect(container.querySelector('[data-testid="routine-history"]')?.textContent).toContain(
      'Loading runs…'
    )
  })

  it('history: a cached record renders newest first, failures carrying their text', () => {
    render({
      routines: [routine()],
      runs: { 1: [run({ id: 11, status: 'failed', error: 'engine refused to start' }), run({ id: 10 })] }
    })
    fireEvent.click(container.querySelector('[data-testid="routine-history-toggle"]')!)
    const runRows = container.querySelectorAll('[data-testid="routine-run-row"]')
    expect(runRows).toHaveLength(2)
    expect(runRows[0].textContent).toContain('Failed')
    expect(runRows[0].textContent).toContain('engine refused to start')
  })

  it('history: a loaded-but-empty record says so', () => {
    render({ routines: [routine()], runs: { 1: [] } })
    fireEvent.click(container.querySelector('[data-testid="routine-history-toggle"]')!)
    expect(container.querySelector('[data-testid="routine-history"]')?.textContent).toContain(
      'No runs yet.'
    )
  })

  it('history: opening a run\'s pane hands the session up to the app', () => {
    const onOpenSession = vi.fn()
    render({ routines: [routine()], runs: { 1: [run({ session_id: 42 })] }, onOpenSession })
    fireEvent.click(container.querySelector('[data-testid="routine-history-toggle"]')!)
    fireEvent.click(container.querySelector('[data-testid="routine-run-open"]')!)
    expect(onOpenSession).toHaveBeenCalledWith(42)
  })

  it('the last run\'s pane opens from the row when one exists', () => {
    const onOpenSession = vi.fn()
    render({ routines: [routine({ last_run_session_id: 7 })], onOpenSession })
    fireEvent.click(container.querySelector('[data-testid="routine-open-session"]')!)
    expect(onOpenSession).toHaveBeenCalledWith(7)
  })
})

describe('sortRoutines', () => {
  it('sorts by soonest next run, then oldest id', () => {
    const order = sortRoutines([
      routine({ id: 3, next_run_at_ms: NOW + 10 }),
      routine({ id: 1, next_run_at_ms: NOW + 1 }),
      routine({ id: 2, next_run_at_ms: NOW + 10 })
    ]).map((r) => r.id)
    expect(order).toEqual([1, 2, 3])
  })
})
