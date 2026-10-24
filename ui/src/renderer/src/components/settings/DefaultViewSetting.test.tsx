// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { HoustonClient } from '../../houston/client'
import type { ServerMsg } from '../../houston/generated/ServerMsg'
import { searchSettingsRows } from '../../settingsRowRegistry'
import { DefaultViewSetting } from './DefaultViewSetting'

afterEach(cleanup)

it('shows the daemon’s default view and changes it through the daemon', () => {
  let receiver: ((message: ServerMsg) => void) | undefined
  const send = vi.fn()
  const unsubscribe = vi.fn()
  const client = {
    send,
    subscribe: (kind: string, handler: (message: ServerMsg) => void) => {
      expect(kind).toBe('default_view')
      receiver = handler
      return unsubscribe
    }
  } as unknown as HoustonClient
  const view = render(<DefaultViewSetting client={client} />)
  expect(send).toHaveBeenCalledWith({ type: 'default_view_get' })
  act(() => receiver!({ type: 'default_view', view: 'terminal' }))
  const terminal = screen.getByRole('radio', { name: 'Terminal' })
  expect(terminal.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(screen.getByRole('radio', { name: 'Thread' }))
  expect(send).toHaveBeenLastCalledWith({ type: 'default_view_set', view: 'thread' })
  act(() => receiver!({ type: 'default_view', view: 'thread' }))
  expect(screen.getByRole('radio', { name: 'Thread' }).getAttribute('aria-checked')).toBe('true')
  view.unmount()
  expect(unsubscribe).toHaveBeenCalledOnce()
})

it('is found by settings search on the CLIs page', () => {
  expect(searchSettingsRows('default view').map((hit) => [hit.section.id, hit.title])).toContainEqual(['agents-clis', 'Default view'])
})
