// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { TaskSummary } from '../../houston/generated/TaskSummary'
import { TaskRow } from './TaskRow'

afterEach(cleanup)

const TASK: TaskSummary = {
  id: 7, workspace: '/project', number: 7, key: 'HOU-7', title: 'Global task',
  status: 'todo', priority: 'medium', parent_id: null, ref_url: null, revision: 1,
  created_by: 'user', created_at_ms: 1, updated_at_ms: 1, archived_at_ms: null,
  acceptance_checked: 0, acceptance_total: 0
}

it('shows the priority mark only when set and keeps the blank column for alignment', () => {
  const { container, rerender } = render(<TaskRow task={TASK} selected={false} now={2} onOpen={() => {}} />)
  expect(screen.getByTestId('task-priority-mark')).toBeTruthy()
  expect(container.querySelector('[data-task="7"]')?.className).toContain('--task-row-priority-width')

  rerender(<TaskRow task={{ ...TASK, priority: 'none' }} selected={false} now={2} onOpen={() => {}} />)
  expect(screen.queryByTestId('task-priority-mark')).toBeNull()
  const row = container.querySelector('[data-task="7"]')!
  expect(row.className).toContain('--task-row-priority-width')
  expect(row.firstElementChild?.textContent).toBe('')
})
