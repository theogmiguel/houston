// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskComposer } from './TaskComposer'

describe('TaskComposer', () => {
  afterEach(cleanup)

  it('moves focus into a newly added acceptance item so typing fills it', () => {
    const onCreate = vi.fn()
    render(<TaskComposer parentOptions={[]} onCancel={() => {}} onCreate={onCreate} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Task title' }), { target: { value: 'Cap retries' } })
    act(() => fireEvent.click(screen.getByTestId('task-composer-add-item')))
    const item = screen.getByRole('textbox', { name: 'Acceptance item 1' })
    expect(document.activeElement).toBe(item)
  })
})
