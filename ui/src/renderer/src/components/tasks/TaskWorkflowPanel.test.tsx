// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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
    acceptance_total: 2, acceptance_verifiable: 0, unresolved_questions: 0,
    unresolved_tracker_conflicts: 0, unfinished_blockers: [13]
  }, plan: null, unresolved_tracker_conflicts: 0
}

describe('task workflow panel', () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'Start anyway' }))
    expect(onStartRequested).toHaveBeenCalledWith(42, '/work/app')
    expect(sent.at(-1)).toMatchObject({ type: 'task_start', id: 42, override_readiness: true })

    fireEvent.click(screen.getByRole('button', { name: 'Generate plan' }))
    expect(sent.at(-1)).toMatchObject({ type: 'task_plan_start', id: 42, expected_revision: 8, agent: 'claude' })
    const planStarted: ServerMsg = { type: 'task_plan_started', id: 42, session_id: 91, revision: 8 }
    act(() => handlers.forEach((handler) => handler(planStarted)))
    expect(onOpenSession).toHaveBeenCalledWith(91)
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
})
