// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientMsg } from '../../houston/client'
import type { ServerMsg } from '../../houston/generated/ServerMsg'
import type { TaskDetailData } from '../../houston/useTasks'
import type { TaskDomain } from '../../houston/taskDomain'
import { TaskWorkflowPanel } from './TaskWorkflowPanel'

const DETAIL: TaskDetailData = {
  task: {
    id: 42, workspace: '/work/app', number: 42, key: 'HOU-42', title: 'Finish recovery UI', description: '',
    status: 'todo', priority: 'medium', parent_id: null, ref_url: 'https://github.com/acme/app/issues/42',
    revision: 8, created_by: 'user', created_at_ms: 1, updated_at_ms: 2, archived_at_ms: null
  },
  acceptance: [], comments: [], history: [], runs: []
}

const DOMAIN: TaskDomain = {
  task_id: 42, kind: 'slice', project_id: 9, delivery_id: null, slice_total: 0, slice_done: 0, planning_session_id: null, blocked_by: [13],
  readiness: {
    ready: false, reasons: ['Blocked by HOU-13', 'Acceptance is not verifiable'],
    acceptance_total: 2, acceptance_verifiable: 0, acceptance_executable: 0, unresolved_questions: 0,
    unresolved_tracker_conflicts: 0, unfinished_blockers: [13]
  }, plan: null, unresolved_tracker_conflicts: 0
}

describe('task workflow panel', () => {
  afterEach(cleanup)
  it('keeps the not-ready bypass explicit and opens planning in its recorded pane', async () => {
    const handlers = new Set<(message: ServerMsg) => void>()
    const sent: ClientMsg[] = []
    const client = {
      subscribeAll: (handler: (message: ServerMsg) => void) => { handlers.add(handler); return () => handlers.delete(handler) },
      taskSnapshot: () => {},
      taskSave: () => {},
      send: (message: ClientMsg) => sent.push(message)
    }
    const onOpenSession = vi.fn()
    const onStartRequested = vi.fn()
    render(<TaskWorkflowPanel client={client} detail={DETAIL} onOpenSession={onOpenSession} onStartRequested={onStartRequested} />)

    const domainState: ServerMsg = { type: 'task_domain_state', domain: DOMAIN }
    act(() => handlers.forEach((handler) => handler(domainState)))
    expect(await screen.findByText('Blocked by HOU-13')).toBeTruthy()
    expect(screen.getByText('0 of 2 acceptance items are executable.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Start anyway' }))
    expect(onStartRequested).toHaveBeenCalledWith(42, '/work/app')
    expect(sent.at(-1)).toMatchObject({ type: 'task_start', id: 42, override_readiness: true })

    fireEvent.click(screen.getByRole('button', { name: 'Generate plan' }))
    expect(sent.at(-1)).toMatchObject({ type: 'task_plan_start', id: 42, expected_revision: 8, agent: 'claude' })
    const planStarted: ServerMsg = { type: 'task_plan_started', id: 42, session_id: 91, revision: 8 }
    act(() => handlers.forEach((handler) => handler(planStarted)))
    expect(onOpenSession).toHaveBeenCalledWith(91)
  })

  it('names the current parent in the Delivery select even when it is not a delivery of this project', () => {
    const handlers = new Set<(message: ServerMsg) => void>()
    const client = {
      subscribeAll: (handler: (message: ServerMsg) => void) => { handlers.add(handler); return () => handlers.delete(handler) },
      taskSnapshot: () => {},
      taskSave: () => {},
      send: () => {}
    }
    const detail: TaskDetailData = { ...DETAIL, task: { ...DETAIL.task, parent_id: 7 } }
    render(<TaskWorkflowPanel client={client} detail={detail} onOpenSession={() => {}} />)
    const parent = { ...DETAIL.task, id: 7, number: 7, key: 'HOU-7', title: 'Parent work', parent_id: null, acceptance_checked: 0, acceptance_total: 0 }
    act(() => handlers.forEach((handler) => {
      handler({ type: 'task_domain_state', domain: DOMAIN })
      handler({ type: 'task_snapshot', scope: '/work/app', tasks: [parent], counts: { ready: 0, backlog: 0, todo: 1, in_progress: 0, in_review: 0, done: 0, canceled: 0 } })
    }))
    expect(screen.getByRole('combobox', { name: 'Delivery' }).textContent).toBe('HOU-7 — Parent work')
  })

  it('binds plan approval to the task revision and marks older approvals stale', () => {
    const handlers = new Set<(message: ServerMsg) => void>()
    const sent: ClientMsg[] = []
    const client = {
      subscribeAll: (handler: (message: ServerMsg) => void) => { handlers.add(handler); return () => handlers.delete(handler) },
      taskSnapshot: () => {},
      taskSave: () => {},
      send: (message: ClientMsg) => sent.push(message)
    }
    render(<TaskWorkflowPanel client={client} detail={DETAIL} onOpenSession={() => {}} />)
    const planDomain: TaskDomain = {
      ...DOMAIN,
      readiness: { ...DOMAIN.readiness, ready: true, reasons: [], unfinished_blockers: [] },
      plan: {
        revision: 2,
        proposal: { description: 'Use the current recovery APIs.', acceptance: ['Expose user controls'], pointers: ['TaskWorkflowPanel'], out_of_scope: ['Automatic execution'], questions: [] },
        answers: [],
        approved_revision: 7
      }
    }
    const state: ServerMsg = { type: 'task_domain_state', domain: planDomain }
    act(() => handlers.forEach((handler) => handler(state)))

    expect(screen.getByText('This approval is stale. Review and approve the current task revision.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Approve this plan revision' }))
    expect(sent.at(-1)).toMatchObject({ type: 'task_plan_approve', id: 42, expected_revision: 8, plan_revision: 2 })
  })

  it('rejects the current plan revision only with a reason', () => {
    const handlers = new Set<(message: ServerMsg) => void>()
    const sent: ClientMsg[] = []
    const client = {
      subscribeAll: (handler: (message: ServerMsg) => void) => { handlers.add(handler); return () => handlers.delete(handler) },
      taskSnapshot: () => {},
      taskSave: () => {},
      send: (message: ClientMsg) => sent.push(message)
    }
    render(<TaskWorkflowPanel client={client} detail={DETAIL} onOpenSession={() => {}} />)
    const planDomain: TaskDomain = {
      ...DOMAIN,
      plan: {
        revision: 3,
        proposal: { description: 'Rewrite the recovery flow.', acceptance: ['`bun run test`'], pointers: [], out_of_scope: [], questions: [] },
        answers: [],
        approved_revision: null
      }
    }
    act(() => handlers.forEach((handler) => handler({ type: 'task_domain_state', domain: planDomain })))

    fireEvent.click(screen.getByRole('button', { name: 'Reject plan' }))
    const dialog = screen.getByRole('dialog', { name: 'Reject plan' })
    const submit = dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: 'Reason' }), { target: { value: '   ' } })
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: 'Reason' }), { target: { value: '  Keep the old API.  ' } })
    fireEvent.click(submit)
    expect(sent.at(-1)).toEqual({ type: 'task_plan_reject', id: 42, expected_revision: 8, plan_revision: 3, reason: 'Keep the old API.' })
    expect(screen.queryByRole('dialog')).toBeNull()

    const before = sent.length
    fireEvent.click(screen.getByRole('button', { name: 'Reject plan' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(sent.length).toBe(before)
  })

  it('leaves a daemon refusal to the task banner instead of repeating it inside the panel', () => {
    const handlers = new Set<(message: ServerMsg) => void>()
    const client = {
      subscribeAll: (handler: (message: ServerMsg) => void) => { handlers.add(handler); return () => handlers.delete(handler) },
      taskSnapshot: () => {},
      taskSave: () => {},
      send: () => {}
    }
    render(<TaskWorkflowPanel client={client} detail={DETAIL} onOpenSession={vi.fn()} />)
    const emit = (message: ServerMsg): void => handlers.forEach((handler) => handler(message))
    act(() => emit({ type: 'task_domain_state', domain: DOMAIN }))
    act(() => emit({ type: 'task_refused', id: 42, kind: 'invalid', message: 'a Slice must reference its parent Delivery through parent_id' }))
    expect(screen.queryByText(/must reference its parent Delivery/)).toBeNull()
  })
})
