// @vitest-environment jsdom
import { act, fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { HoustonClient } from '../../houston/client'
import type { ServerMsg } from '../../houston/generated/ServerMsg'
import { GeneratedTitlesSetting } from './GeneratedTitlesSetting'

afterEach(cleanup)
it('shows the daemon value and changes it only after confirmation from the daemon', () => {
  let receiver: ((message: ServerMsg) => void) | undefined
  const send = vi.fn()
  const unsubscribe = vi.fn()
  const client = { send, subscribeAll: (handler: (message: ServerMsg) => void) => { receiver = handler; return unsubscribe } } as unknown as HoustonClient
  const view = render(<GeneratedTitlesSetting client={client} />)
  expect(send).toHaveBeenCalledWith({ type: 'generated_titles_get' })
  const toggle = screen.getByRole('switch') as HTMLButtonElement
  expect(toggle.disabled).toBe(true)
  act(() => receiver!({ type: 'generated_titles', enabled: false }))
  expect(screen.getByText('Off')).toBeTruthy()
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  fireEvent.click(toggle)
  expect(send).toHaveBeenLastCalledWith({ type: 'generated_titles_set', enabled: true })
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  act(() => receiver!({ type: 'generated_titles', enabled: true }))
  expect(screen.getByText('On')).toBeTruthy()
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  expect(screen.getByText('What leaves your machine')).toBeTruthy()
  view.unmount()
  expect(unsubscribe).toHaveBeenCalledOnce()
})
