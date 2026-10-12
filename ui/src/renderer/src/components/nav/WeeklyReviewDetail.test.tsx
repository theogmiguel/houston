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
  expect(screen.getByText(/Three repeated mistakes/)).toBeTruthy()
  expect(screen.getByText(/38 sessions/)).toBeTruthy()
  expect(screen.queryByRole('table', { name: 'Routine runs' })).toBeNull()
  expect(screen.getByRole('radiogroup', { name: 'Review schedule' })).toBeTruthy()
  fireEvent.click(screen.getByRole('radio', { name: 'Only when I run it' }))
  expect(onUpdateReviewSchedule).toHaveBeenCalledWith({ cadence: ROUTINE.cadence, enabled: false })
  fireEvent.click(screen.getByRole('radio', { name: 'Daily' }))
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

it('keeps review settings in label/value rows with the enabled switch outside the header', () => {
  const onEdit = vi.fn()
  render(<WeeklyReviewDetail workspaceName="A" routine={{ ...ROUTINE, model: 'sonnet' }} runsLoading={false} now={1} running={false} pending={false} atLimit={null}
    onRunNow={vi.fn()} onToggleEnabled={vi.fn()} onEdit={onEdit} onDelete={vi.fn()} onUpdateSchedule={vi.fn()} onUpdateEngine={vi.fn()} onOpenSession={vi.fn()} />)
  const settings = screen.getByRole('group', { name: 'Routine settings' })
  const toggle = screen.getByRole('switch', { name: 'Weekly review enabled' })
  expect(settings.contains(toggle)).toBe(true)
  expect(screen.getByTestId('routine-detail-header').contains(toggle)).toBe(false)
  expect(screen.getByRole('radiogroup', { name: 'Review schedule' })).toBeTruthy()
  expect(screen.getByRole('radio', { name: 'Only when I run it' })).toBeTruthy()
  expect(screen.getByText('Mondays at 09:00')).toBeTruthy()
  expect(screen.getByText('sonnet')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Change review provider and model' }))
  expect(onEdit).toHaveBeenCalled()
})
it('shows a running banner from reported review state without inventing session counts', () => {
  const { client, emit, state } = fixture()
  render(<WeeklyReviewDetail client={client} workspaceName="A" routine={ROUTINE} runsLoading={false} now={180_001} running pending={false} atLimit={null}
    onRunNow={vi.fn()} onToggleEnabled={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onUpdateSchedule={vi.fn()} onUpdateEngine={vi.fn()} onOpenSession={vi.fn()} />)
  const message = state('/a') as Extract<ServerMsg, { type: 'harness_state' }>
  message.reviews.unshift({ id: 8, workspace: '/a', routine_id: 1, run_id: 8, session_id: 8, status: 'running', started_at_ms: 1, sessions: null, finding_count: 0, run_dir: '/a/.houston/harness/r8' })
  emit(message)
  expect(screen.getByText('Reading sessions in A · started 3 min ago in a background pane')).toBeTruthy()
  expect(screen.queryByText('Published')).toBeNull()
})
