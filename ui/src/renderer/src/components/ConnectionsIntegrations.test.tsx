// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient } from '../houston/client'
import type { SlackInfo } from '../houston/generated/SlackInfo'
import { ConnectionsIntegrations } from './ConnectionsIntegrations'

afterEach(cleanup)

function fakeClient(): {
  client: HoustonClient
  receive: (type: string, message: unknown) => void
  calls: Record<string, ReturnType<typeof vi.fn>>
} {
  const handlers = new Map<string, (message: unknown) => void>()
  const calls = {
    send: vi.fn(),
    slackGet: vi.fn(),
    slackConnect: vi.fn(),
    slackDisconnect: vi.fn(),
    slackConfigure: vi.fn()
  }
  const client = {
    subscribe: (type: string, callback: (message: unknown) => void) => {
      handlers.set(type, callback)
      return () => handlers.delete(type)
    },
    ...calls
  } as unknown as HoustonClient
  return { client, receive: (type, message) => handlers.get(type)?.(message), calls }
}

const OFF: SlackInfo = {
  enabled: false,
  has_tokens: false,
  connection: 'off',
  team: null,
  bot_user_id: null,
  owner_user_id: null,
  channels: [],
  language: 'en',
  last_event_at_ms: null,
  last_catchup_at_ms: null,
  error: null
}

describe('Connections integrations', () => {
  it('shows the connected card and connects with both tokens without retaining them', () => {
    const { client, receive, calls } = fakeClient()
    render(<ConnectionsIntegrations client={client} />)
    expect(calls.slackGet).toHaveBeenCalled()
    act(() => receive('slack', { info: OFF, refusal: null }))
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    const app = screen.getByPlaceholderText('xapp-…') as HTMLInputElement
    const bot = screen.getByPlaceholderText('xoxb-…') as HTMLInputElement
    expect(app.type).toBe('password')
    fireEvent.change(app, { target: { value: 'xapp-1-secret' } })
    fireEvent.change(bot, { target: { value: 'xoxb-1-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls.slackConnect).toHaveBeenCalledWith('xapp-1-secret', 'xoxb-1-secret')

    act(() => receive('slack', { info: { ...OFF, enabled: true, has_tokens: true, connection: 'connected', team: 'Acme' }, refusal: null }))
    expect(app.value).toBe('')
    expect(bot.value).toBe('')
    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.getByText(/to Acme/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('secret')
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(calls.slackDisconnect).toHaveBeenCalled()
  })

  it('shows the daemon error for a reconnecting intake', () => {
    const { client, receive } = fakeClient()
    render(<ConnectionsIntegrations client={client} />)
    act(() => receive('slack', { info: { ...OFF, enabled: true, has_tokens: true, connection: 'retrying', error: 'invalid_auth: token revoked' }, refusal: null }))
    expect(screen.getByText('Reconnecting')).toBeTruthy()
    expect(screen.getByText('invalid_auth: token revoked')).toBeTruthy()
  })

  it('reconnects with saved keychain tokens when both fields stay empty', () => {
    const { client, receive, calls } = fakeClient()
    render(<ConnectionsIntegrations client={client} />)
    act(() => receive('slack', { info: { ...OFF, has_tokens: true }, refusal: null }))
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls.slackConnect).toHaveBeenCalledWith(null, null)
  })

  it('saves owner, channel map and language, applying a language choice immediately', async () => {
    const { client, receive, calls } = fakeClient()
    render(<ConnectionsIntegrations client={client} />)
    const saved = [{ channel_id: 'C1', workspace: '/w' }]
    act(() => {
      receive('workspace_list', { workspaces: [{ path: '/w', name: 'houston' }] })
      receive('slack', { info: { ...OFF, owner_user_id: 'U1', channels: saved }, refusal: null })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Owner' }), { target: { value: 'U2-unsaved' } })
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Language' }))
    const option = (await screen.findAllByRole('option')).find((item) => item.getAttribute('data-value') === 'pt_br')
    fireEvent.mouseUp(option as HTMLElement)
    expect(calls.slackConfigure).toHaveBeenCalledWith('U1', saved, 'pt_br')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls.slackConfigure).toHaveBeenLastCalledWith('U2-unsaved', saved, 'pt_br')
  })

  it('keeps typed values and displays a daemon refusal', () => {
    const { client, receive, calls } = fakeClient()
    render(<ConnectionsIntegrations client={client} />)
    act(() => receive('slack', { info: OFF, refusal: null }))
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Owner' }), { target: { value: '@me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls.slackConfigure).toHaveBeenCalledWith('@me', [], 'en')
    act(() => receive('slack', { info: OFF, refusal: 'owner "@me" is not a Slack member ID' }))
    expect(screen.getByText(/not a Slack member ID/)).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'Owner' }) as HTMLInputElement).value).toBe('@me')
  })

  it('requires both tokens together', () => {
    const { client } = fakeClient()
    render(<ConnectionsIntegrations client={client} />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    fireEvent.change(screen.getByPlaceholderText('xapp-…'), { target: { value: 'xapp-one' } })
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Enter both Slack tokens or leave both empty.')).toBeTruthy()
  })
})
