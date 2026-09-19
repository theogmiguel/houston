// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RoutineRow } from './RoutineRow'
import type { Routine, RoutineRun } from '../../houston/routineTypes'

function noop(): void {}

const NOW = 1_700_000_000_000

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 1,
    engine: 'claude',
    name: 'Leak watch',
    prompt: 'p',
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
    trigger: 'manual',
    status: 'ok',
    session_id: 42,
    error: null,
    started_at_ms: NOW - 120_000,
    ended_at_ms: NOW - 60_000,
    ...overrides
  }
}

describe('RoutineRow', () => {
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

  it('shows the failure text and cadence chip when lastError is set', () => {
    act(() => {
      root.render(
        <RoutineRow
          routine={routine({ last_error: 'cwd no longer exists' })}
          workspace={undefined}
          now={NOW}
          onEdit={noop}
          onToggleEnabled={noop}
          onDelete={noop}
        />
      )
    })
    expect(container.textContent).toContain('cwd no longer exists')
    expect(container.textContent).toContain('every 15 minutes')
    expect(container.querySelector('[data-testid="routine-row"]')?.getAttribute('data-state')).toBe(
      'failing'
    )
  })

  it('treats an ABSENT last_error as no error, not as a failure', () => {
    const r = routine()
    delete (r as { last_error?: string | null }).last_error
    act(() => {
      root.render(
        <RoutineRow
          routine={r}
          workspace={undefined}
          now={NOW}
          onEdit={noop}
          onToggleEnabled={noop}
          onDelete={noop}
        />
      )
    })
    expect(container.textContent).not.toContain('last run failed')
    expect(container.textContent).not.toContain('undefined')
    expect(container.querySelector('[data-testid="routine-row"]')?.getAttribute('data-state')).toBe(
      'scheduled'
    )
  })

  it('names the workspace and access mode in the detail line', () => {
    act(() => {
      root.render(
        <RoutineRow
          routine={routine({ permission_mode: 'bypass_permissions', isolate: true })}
          workspace={{ id: '/home/dev/app', name: 'app' }}
          now={NOW}
          onEdit={noop}
          onToggleEnabled={noop}
          onDelete={noop}
        />
      )
    })
    expect(container.textContent).toContain('app')
    expect(container.textContent).toContain('full access')
    expect(container.textContent).toContain('isolated')
  })

  it('pauses and resumes through the heading switch', () => {
    const toggles: number[] = []
    act(() => {
      root.render(
        <RoutineRow
          routine={routine({ enabled: false })}
          workspace={undefined}
          now={NOW}
          onEdit={noop}
          onToggleEnabled={() => toggles.push(1)}
          onDelete={noop}
        />
      )
    })
    const sw = container.querySelector<HTMLButtonElement>('[data-testid="routine-switch"]')!
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(sw.getAttribute('aria-label')).toContain('Resume')
    act(() => sw.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(toggles).toEqual([1])
    expect(container.textContent).toContain('Paused')
  })

  it('fires onEdit and onDelete from the footer icon actions', () => {
    let edited = false
    let deleted = false
    act(() => {
      root.render(
        <RoutineRow
          routine={routine()}
          workspace={undefined}
          now={NOW}
          onEdit={() => {
            edited = true
          }}
          onToggleEnabled={noop}
          onDelete={() => {
            deleted = true
          }}
        />
      )
    })
    const byLabel = (t: string): HTMLButtonElement =>
      container.querySelector<HTMLButtonElement>(`[aria-label="${t}"]`)!
    act(() => byLabel('Edit Leak watch').dispatchEvent(new MouseEvent('click', { bubbles: true })))
    act(() => byLabel('Delete Leak watch').dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(edited).toBe(true)
    expect(deleted).toBe(true)
  })

  it('runs now through the footer action when the surface offers it', () => {
    let ran = 0
    act(() => {
      root.render(
        <RoutineRow
          routine={routine()}
          workspace={undefined}
          now={NOW}
          onRunNow={() => {
            ran += 1
          }}
          onEdit={noop}
          onToggleEnabled={noop}
          onDelete={noop}
        />
      )
    })
    const runNow = container.querySelector<HTMLButtonElement>('[data-testid="routine-run-now"]')!
    act(() => runNow.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(ran).toBe(1)
  })

  it('offers no Run-now when the surface does not pass the handler', () => {
    act(() => {
      root.render(
        <RoutineRow
          routine={routine()}
          workspace={undefined}
          now={NOW}
          onEdit={noop}
          onToggleEnabled={noop}
          onDelete={noop}
        />
      )
    })
    expect(container.querySelector('[data-testid="routine-run-now"]')).toBeNull()
  })

  it('shows Running in place of the schedule while the run is live', () => {
    act(() => {
      root.render(
        <RoutineRow
          routine={routine()}
          workspace={undefined}
          now={NOW}
          running
          onEdit={noop}
          onToggleEnabled={noop}
          onDelete={noop}
        />
      )
    })
    expect(container.querySelector('[data-testid="routine-row"]')?.getAttribute('data-state')).toBe(
      'running'
    )
    expect(container.textContent).toContain('Running')
  })

  it('opens the last run pane from the footer action', () => {
    let opened: number | null = null
    act(() => {
      root.render(
        <RoutineRow
          routine={routine({ last_run_session_id: 7 })}
          workspace={undefined}
          now={NOW}
          onOpenSession={(id) => {
            opened = id
          }}
          onEdit={noop}
          onToggleEnabled={noop}
          onDelete={noop}
        />
      )
    })
    const open = container.querySelector<HTMLButtonElement>('[data-testid="routine-open-session"]')!
    act(() => open.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(opened).toBe(7)
  })

  it('history: loading, empty, and newest-first rows with their outcome and pane', () => {
    const runs: RoutineRun[] = [
      run({ id: 12, status: 'failed', error: 'engine refused to start', session_id: null }),
      run({ id: 11, status: 'running', ended_at_ms: null, session_id: 42 })
    ]
    let opened: number | null = null
    act(() => {
      root.render(
        <RoutineRow
          routine={routine()}
          workspace={undefined}
          now={NOW}
          historyOpen
          runs={runs}
          onOpenSession={(id) => {
            opened = id
          }}
          onEdit={noop}
          onToggleEnabled={noop}
          onDelete={noop}
        />
      )
    })
    const rows = container.querySelectorAll('[data-testid="routine-run-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('Failed')
    expect(rows[0].textContent).toContain('Run now')
    expect(rows[0].textContent).toContain('engine refused to start')
    expect(rows[1].textContent).toContain('Running')
    const open = rows[1].querySelector<HTMLButtonElement>('[data-testid="routine-run-open"]')!
    act(() => open.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(opened).toBe(42)
  })

  it('history: an empty record says so rather than looking like a failure', () => {
    act(() => {
      root.render(
        <RoutineRow
          routine={routine()}
          workspace={undefined}
          now={NOW}
          historyOpen
          runs={[]}
          onEdit={noop}
          onToggleEnabled={noop}
          onDelete={noop}
        />
      )
    })
    expect(container.textContent).toContain('No runs yet.')
  })
})
