// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { HoustonClient, ServerMsg } from '../../houston/client'
import type { Routine } from '../../houston/routineTypes'
import { WeeklyReviewDetail } from './WeeklyReviewDetail'
import { RoutinesSurface } from './RoutinesSurface'

afterEach(cleanup)
const ROUTINE: Routine = { kind: 'harness_review', id: 1, name: 'Harness review', prompt: 'Review sessions', workspace_id: '/a', cadence: { type: 'clock', hour: 9, minute: 0, weekdays: [2] }, enabled: true, engine: 'claude', next_run_at_ms: 1, permission_mode: 'accept_edits', isolate: false, revision: 'r1' }
function fixture() {
  const handlers = new Map<string, Set<(message: ServerMsg) => void>>()
  const emit = (message: ServerMsg) => act(() => handlers.get(message.type)?.forEach((handler) => handler(message)))
  const harnessState = vi.fn()
  const harnessReport = vi.fn()
  const harnessRoutineCreate = vi.fn()
  const client = { harnessState, harnessReport, harnessRoutineCreate,
    subscribe: (type: string, handler: (message: ServerMsg) => void) => {
      const set = handlers.get(type) ?? new Set(); set.add(handler); handlers.set(type, set); return () => set.delete(handler)
    }
  } as unknown as HoustonClient
  const state = (workspace: string, routine: Routine | null = ROUTINE) => ({ type: 'harness_state', workspace, routine, models: [], provider_coverage: [], engine_refusals: [], findings: [], reviews: [
    { id: 7, workspace, routine_id: 1, run_id: 3, status: 'published', started_at_ms: 1, sessions: 38, finding_count: 3, run_dir: '/a/.houston/harness/r3', summary: 'Three repeated mistakes' }
  ] } as ServerMsg)
  return { client, emit, state, harnessState, harnessReport, harnessRoutineCreate }
}
it('uses review history for its workspace and writes schedule helpers including the enabled flag', () => {
  const { client, emit, state, harnessReport } = fixture()
  const onUpdateReviewSchedule = vi.fn()
  render(<WeeklyReviewDetail client={client} workspaceName="A" routine={ROUTINE} onUpdateReviewSchedule={onUpdateReviewSchedule}
    runs={[{ id: 99, routine_id: 1, trigger: 'manual', status: 'ok', started_at_ms: 1 }]} runsLoading={false}
    now={100} running={false} pending={false} atLimit={null} onRunNow={vi.fn()} onToggleEnabled={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onUpdateSchedule={vi.fn()} onUpdateEngine={vi.fn()} onOpenSession={vi.fn()} />)
  emit(state('/b'))
  expect(screen.queryByText('Three repeated mistakes')).toBeNull()
  emit(state('/a'))
  expect(screen.getByText('Three repeated mistakes')).toBeTruthy()
  expect(screen.getByText(/38 sessions/)).toBeTruthy()
  expect(screen.queryByRole('table', { name: 'Routine runs' })).toBeNull()
  const schedule = screen.getByRole('combobox', { name: 'Review schedule' })
  fireEvent.mouseDown(schedule)
  fireEvent.mouseUp(screen.getByRole('option', { name: 'Only when I run it' }))
  expect(onUpdateReviewSchedule).toHaveBeenCalledWith({ cadence: ROUTINE.cadence, enabled: false })
  fireEvent.mouseDown(schedule)
  fireEvent.mouseUp(screen.getByRole('option', { name: 'Daily 09:00' }))
  expect(onUpdateReviewSchedule).toHaveBeenCalledWith({ cadence: { type: 'clock', hour: 9, minute: 0, weekdays: null }, enabled: true })
  fireEvent.click(screen.getByRole('button', { name: 'Open report' }))
  expect(harnessReport).toHaveBeenCalledWith(7)
  emit({ type: 'error', context: 'harness_report:7', message: 'Review 7 report unavailable' })
  expect(screen.getByText('Review 7 report unavailable')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(harnessReport).toHaveBeenCalledTimes(2)
  emit({ type: 'harness_report', review_id: 7, markdown: 'Workspace A report', truncated: false })
  expect(screen.getByRole('dialog', { name: 'Weekly review report' })).toBeTruthy()
})
it('creates a missing per-workspace review with shared setup fields without starting a run', () => {
  const { client, emit, state, harnessRoutineCreate } = fixture()
  const onRunNow = vi.fn()
  render(<RoutinesSurface client={client} routines={[]} running={[]} runs={{}} runsLoading={null} workspaces={[{ id: '/a', name: 'A' }]} error={null}
    onDismissError={vi.fn()} onCreate={vi.fn()} onUpdate={vi.fn()} onDelete={vi.fn()} onRunNow={onRunNow} onLoadRuns={vi.fn()} onOpenSession={vi.fn()} onRequest={vi.fn()} now={1} />)
  fireEvent.click(screen.getByRole('button', { name: 'Set up Weekly review' }))
  emit(state('/a', null))
  expect(screen.getByText('What a review sends to its provider')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Create routine' }))
  expect(harnessRoutineCreate).toHaveBeenCalledWith({ workspace: '/a', engine: 'claude', model: null, cadence: ROUTINE.cadence, enabled: false })
  expect(onRunNow).not.toHaveBeenCalled()
})
