// @vitest-environment jsdom
import { act, fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { HoustonClient } from '../../houston/client'
import type { ServerMsg } from '../../houston/generated/ServerMsg'
import { ZcodeQuotaCheckSetting } from './ZcodeQuotaCheckSetting'

afterEach(cleanup)
it('shows the daemon value and changes it only after confirmation from the daemon', () => {
  let receiver: ((message: ServerMsg) => void) | undefined
  const send = vi.fn()
  const unsubscribe = vi.fn()
  const client = { send, subscribeAll: (handler: (message: ServerMsg) => void) => { receiver = handler; return unsubscribe } } as unknown as HoustonClient
  const view = render(<ZcodeQuotaCheckSetting client={client} />)
  expect(send).toHaveBeenCalledWith({ type: 'zcode_quota_check_get' })
  const toggle = screen.getByRole('switch') as HTMLButtonElement
  expect(toggle.disabled).toBe(true)
  act(() => receiver!({ type: 'zcode_quota_check', enabled: false }))
  expect(screen.queryByText('Off')).toBeNull()
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  fireEvent.click(toggle)
  expect(send).toHaveBeenLastCalledWith({ type: 'zcode_quota_check_set', enabled: true })
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  act(() => receiver!({ type: 'zcode_quota_check', enabled: true }))
  expect(screen.queryByText('On')).toBeNull()
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  expect(screen.getByText('Check ZCode plan quota when a pane stalls')).toBeTruthy()
  expect(screen.getByText(/When a ZCode pane has been working for 20 minutes/)).toBeTruthy()
  view.unmount()
  expect(unsubscribe).toHaveBeenCalledOnce()
})
