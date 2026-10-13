// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeSession } from '../test/appTestHarness'
import { RecoveryCheckControls } from './RecoveryCheckControls'

afterEach(cleanup)
it('rechecks without acknowledgement and requires an explicit assertion before acknowledging', () => {
  const recheck = vi.fn()
  const acknowledge = vi.fn()
  render(<RecoveryCheckControls info={makeSession({ state: 'interrupted', restore_deferred: 'spawn-failed', resume_notice: 'Previous uncontained process scope' })} connected onRecheck={recheck} onAcknowledge={acknowledge} />)
  fireEvent.click(screen.getByRole('button', { name: 'Recheck recovery' }))
  expect(recheck).toHaveBeenCalledOnce()
  expect(acknowledge).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Acknowledge prior processes stopped' }))
  expect(screen.getByRole('alertdialog')).toBeTruthy()
  expect(acknowledge).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'I verified they stopped' }))
  expect(acknowledge).toHaveBeenCalledOnce()
})

it('hides recovery actions for live panes and disables them while disconnected', () => {
  const props = { onRecheck: vi.fn(), onAcknowledge: vi.fn(), connected: true }
  const view = render(<RecoveryCheckControls {...props} info={makeSession({ state: 'running', resume_notice: 'Previous notice' })} />)
  expect(screen.queryByRole('button', { name: 'Recheck recovery' })).toBeNull()
  view.rerender(<RecoveryCheckControls {...props} connected={false} info={makeSession({ state: 'interrupted', restore_deferred: 'safe-mode' })} />)
  expect((screen.getByRole('button', { name: 'Recheck recovery' }) as HTMLButtonElement).disabled).toBe(true)
})
