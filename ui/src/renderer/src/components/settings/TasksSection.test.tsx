// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClientMsg } from '../../houston/client'
import type { ServerMsg } from '../../houston/generated/ServerMsg'
import type { TaskReviewFocus } from '../../houston/generated/TaskReviewFocus'
import type { TaskReviewMode } from '../../houston/generated/TaskReviewMode'
import { pickOption, selectValue } from '../../test/selectHarness'
import { TasksSection } from './TasksSection'

const WORKSPACE = '/work/project'

interface ReviewSettings {
  reviewer: 'codex' | null
  reworkRounds: number
  mode: TaskReviewMode
  focus: TaskReviewFocus
}

function fakeClient(initial: ReviewSettings, sent: ClientMsg[]) {
  const handlers = new Map<string, Set<(msg: ServerMsg) => void>>()
  const emit = (msg: ServerMsg): void => {
    handlers.get(msg.type)?.forEach((handler) => handler(msg))
    handlers.get('*')?.forEach((handler) => handler(msg))
  }
  let review = initial
  const client = {
    subscribe: (kind: string, handler: (msg: ServerMsg) => void) => {
      const set = handlers.get(kind) ?? new Set()
      set.add(handler)
      handlers.set(kind, set)
      return () => set.delete(handler)
    },
    subscribeAll: (handler: (msg: ServerMsg) => void) => {
      const set = handlers.get('*') ?? new Set()
      set.add(handler)
      handlers.set('*', set)
      return () => set.delete(handler)
    },
    send: (msg: ClientMsg) => {
      sent.push(msg)
      if (msg.type === 'workspace_list') {
        emit({ type: 'workspace_list', workspaces: [{ path: WORKSPACE, name: 'Project' }] })
      }
    },
    tasksAccessGet: (workspace: string) => emit({ type: 'tasks_access', workspace, access: 'write' }),
    tasksAccessSet: (workspace: string, access: 'off' | 'read' | 'write') => emit({ type: 'tasks_access', workspace, access }),
    taskStartSettingsGet: (workspace: string) => emit({ type: 'task_start_settings', workspace, agent: 'claude', delivery: 'send' }),
    taskStartSettingsSet: (workspace: string, agent: 'claude', delivery: 'send') => emit({ type: 'task_start_settings', workspace, agent, delivery }),
    taskReviewSettingsGet: (workspace: string) => emit({
      type: 'task_review_settings',
      workspace,
      reviewer: review.reviewer,
      rework_rounds: review.reworkRounds,
      mode: review.mode,
      focus: review.focus
    }),
    taskReviewSettingsSet: (workspace: string, reviewer: 'codex' | null, reworkRounds: number, mode: TaskReviewMode, focus: TaskReviewFocus) => {
      sent.push({ type: 'task_review_settings_set', workspace, reviewer, rework_rounds: reworkRounds, mode, focus })
      review = { reviewer, reworkRounds, mode, focus }
      emit({ type: 'task_review_settings', workspace, reviewer, rework_rounds: reworkRounds, mode, focus })
    }
  }
  return client as unknown as Parameters<typeof TasksSection>[0]['client']
}

describe('Settings ▸ Tasks ▸ Review', () => {
  afterEach(cleanup)

  it('shows the current review mode and focus and sends changes without losing the reviewer or rework rounds', async () => {
    const sent: ClientMsg[] = []
    const client = fakeClient({ reviewer: 'codex', reworkRounds: 2, mode: 'handback', focus: 'security' }, sent)
    const view = render(<TasksSection client={client} workspace={WORKSPACE} />)
    const lastReviewSet = (): ClientMsg | undefined => sent.filter((message) => message.type === 'task_review_settings_set').at(-1)

    expect((await screen.findByRole('radio', { name: 'On handback', checked: true })).getAttribute('aria-checked')).toBe('true')
    expect(selectValue(view.container, 'settings-tasks-review-focus')).toContain('Security')

    act(() => screen.getByTestId('settings-tasks-review-mode-every_push').click())
    expect(lastReviewSet()).toEqual({
      type: 'task_review_settings_set',
      workspace: WORKSPACE,
      reviewer: 'codex',
      rework_rounds: 2,
      mode: 'every_push',
      focus: 'security'
    })

    pickOption(view.container, 'settings-tasks-review-focus', 'performance')
    expect(lastReviewSet()).toMatchObject({ type: 'task_review_settings_set', reviewer: 'codex', rework_rounds: 2, mode: 'every_push', focus: 'performance' })

    pickOption(view.container, 'settings-tasks-reviewer', 'claude')
    expect(lastReviewSet()).toMatchObject({ type: 'task_review_settings_set', reviewer: 'claude', rework_rounds: 2, mode: 'every_push', focus: 'performance' })

    const rounds = screen.getByTestId('settings-tasks-rework-rounds') as HTMLInputElement
    fireEvent.change(rounds, { target: { value: '3' } })
    fireEvent.blur(rounds)
    expect(lastReviewSet()).toMatchObject({ type: 'task_review_settings_set', reviewer: 'claude', rework_rounds: 3, mode: 'every_push', focus: 'performance' })
  })

  it('says what each review mode does and that the branch diff goes to the reviewer provider', async () => {
    const client = fakeClient({ reviewer: null, reworkRounds: 0, mode: 'manual', focus: 'bugs' }, [])
    render(<TasksSection client={client} workspace={WORKSPACE} />)
    expect(await screen.findByText(/Manual only: a review starts only when you ask/)).toBeTruthy()
    expect(screen.getByText(/On handback: a review starts when the implementer hands the task back/)).toBeTruthy()
    expect(screen.getByText(/On every push to an open PR: a review starts/)).toBeTruthy()
    expect(screen.getByText(/A review sends the branch diff to the reviewer's provider/)).toBeTruthy()
  })
})

