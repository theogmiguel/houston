// @vitest-environment jsdom
import { act, fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { HoustonClient } from '../../houston/client'
import type { ServerMsg } from '../../houston/generated/ServerMsg'
import { AgentBrowserSetting } from './AgentBrowserSetting'

afterEach(cleanup)
it('shows the daemon value and changes it only after confirmation from the daemon', () => {
  let receiver: ((message: ServerMsg) => void) | undefined
  const send = vi.fn()
  const unsubscribe = vi.fn()
  const client = { send, subscribeAll: (handler: (message: ServerMsg) => void) => { receiver = handler; return unsubscribe } } as unknown as HoustonClient
  const view = render(<AgentBrowserSetting client={client} />)
  expect(send).toHaveBeenCalledWith({ type: 'agent_browser_get' })
  const toggle = screen.getByRole('switch', { name: 'Let agents use the browser' }) as HTMLButtonElement
  expect(toggle.disabled).toBe(true)
  act(() => receiver!({ type: 'agent_browser', enabled: true }))
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(toggle)
  expect(send).toHaveBeenLastCalledWith({ type: 'agent_browser_set', enabled: false })
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  act(() => receiver!({ type: 'agent_browser', enabled: false }))
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  view.unmount()
  expect(unsubscribe).toHaveBeenCalledOnce()
})

it('stays disabled without a daemon connection', () => {
  render(<AgentBrowserSetting client={null} />)
  expect((screen.getByRole('switch', { name: 'Let agents use the browser' }) as HTMLButtonElement).disabled).toBe(true)
})
