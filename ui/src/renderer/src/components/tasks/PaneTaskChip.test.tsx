// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import type { SessionTask } from '../../houston/generated/SessionTask'
import { TASKS_OPEN_EVENT } from '../../sidePanel'
import { PaneTaskChip } from './PaneTaskChip'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TASK: SessionTask = {
  task_id: 7,
  key: 'HOU-2',
  title: 'Fix task navigation',
  status: 'in_progress',
  run_id: 11,
  run_state: 'running'
}

describe('PaneTaskChip', () => {
  let container: HTMLDivElement
  let root: Root
  let clipboardDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
  })

  it('opens the task drawer on click and copies its key on Ctrl+click', async () => {
    const open = vi.fn()
    window.addEventListener(TASKS_OPEN_EVENT, open)
    const writeText = vi.fn().mockResolvedValue(undefined)
    clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await act(async () => {
      root.render(<PaneTaskChip task={TASK} />)
      await Promise.resolve()
    })
    const chip = await screen.findByRole('button', { name: 'Open HOU-2 · Ctrl+click to copy key' })
    expect(chip.textContent).toContain('HOU-2')
    act(() => chip.click())
    expect(open.mock.calls[0]?.[0]).toMatchObject({ detail: { openId: 7 } })
    act(() => chip.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })))
    expect(writeText).toHaveBeenCalledWith('HOU-2')
    expect(open).toHaveBeenCalledTimes(1)
    window.removeEventListener(TASKS_OPEN_EVENT, open)
  })
})
