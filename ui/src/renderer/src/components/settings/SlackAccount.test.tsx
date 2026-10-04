// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient } from '../../houston/client'
import type { SlackInfo } from '../../houston/generated/SlackInfo'
import { SlackAccount } from './SlackAccount'

afterEach(cleanup)

function fakeClient(): {
  client: HoustonClient
  receive: (message: unknown) => void
  calls: Record<string, ReturnType<typeof vi.fn>>
} {
  let handler: (message: unknown) => void = () => {}
  const calls = {
    send: vi.fn(),
    slackGet: vi.fn(),
    slackConnect: vi.fn(),
    slackDisconnect: vi.fn(),
    slackConfigure: vi.fn()
  }
  const client = {
    subscribe: (type: string, callback: (message: unknown) => void) => {
      if (type === 'slack') handler = callback
      return () => {}
    },
    ...calls
  } as unknown as HoustonClient
  return { client, receive: (m) => handler(m), calls }
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

describe('Slack intake settings', () => {
  it('sends both tokens once and never shows them again', () => {
    const { client, receive, calls } = fakeClient()
    render(<SlackAccount client={client} />)
    expect(calls.slackGet).toHaveBeenCalled()
    act(() => receive({ info: OFF, refusal: null }))

    const connect = screen.getByTestId('slack-connect') as HTMLButtonElement
    expect(connect.disabled).toBe(true)
    const app = screen.getByLabelText('Slack app-level token') as HTMLInputElement
    const bot = screen.getByLabelText('Slack bot token') as HTMLInputElement
    expect(app.type).toBe('password')
    fireEvent.change(app, { target: { value: 'xapp-1-secret' } })
    fireEvent.change(bot, { target: { value: 'xoxb-1-secret' } })
    fireEvent.click(connect)
    expect(calls.slackConnect).toHaveBeenCalledWith('xapp-1-secret', 'xoxb-1-secret')

    act(() =>
      receive({ info: { ...OFF, enabled: true, has_tokens: true, connection: 'connected', team: 'Acme' }, refusal: null })
    )
    expect(app.value).toBe('')
    expect(bot.value).toBe('')
    expect(screen.getByTestId('slack-status').textContent).toContain('Connected · to Acme')
    expect(document.body.textContent).not.toContain('secret')
    fireEvent.click(screen.getByTestId('slack-disconnect'))
    expect(calls.slackDisconnect).toHaveBeenCalled()
  })

  it('reconnects with the stored tokens when the fields are empty', () => {
    const { client, receive, calls } = fakeClient()
    render(<SlackAccount client={client} />)
    act(() => receive({ info: { ...OFF, has_tokens: true }, refusal: null }))
    fireEvent.click(screen.getByTestId('slack-connect'))
    expect(calls.slackConnect).toHaveBeenCalledWith(null, null)
  })

  it('shows the current language and saves it with the rest of the settings', () => {
    const { client, receive, calls } = fakeClient()
    render(<SlackAccount client={client} />)
    act(() => receive({ info: { ...OFF, language: 'pt_br' }, refusal: null }))
    const select = screen.getByLabelText('Language Houston writes in Slack')
    expect(select.textContent).toContain('Português (Brasil)')
    fireEvent.click(screen.getByTestId('slack-save'))
    expect(calls.slackConfigure).toHaveBeenCalledWith(null, [], 'pt_br')
  })

  it('applies a language as soon as it is chosen, with the saved owner and channels', async () => {
    const { client, receive, calls } = fakeClient()
    render(<SlackAccount client={client} />)
    const saved = [{ channel_id: 'C1', workspace: '/w' }]
    act(() => receive({ info: { ...OFF, owner_user_id: 'U1', channels: saved }, refusal: null }))
    fireEvent.change(screen.getByLabelText("Owner's Slack member ID"), { target: { value: 'U2-unsaved' } })
    fireEvent.mouseDown(screen.getByLabelText('Language Houston writes in Slack'))
    const option = (await screen.findAllByRole('option')).find((o) => o.getAttribute('data-value') === 'pt_br')
    fireEvent.mouseUp(option as HTMLElement)
    expect(calls.slackConfigure).toHaveBeenCalledWith('U1', saved, 'pt_br')
  })

  it('keeps what was typed and shows a refusal', () => {
    const { client, receive, calls } = fakeClient()
    render(<SlackAccount client={client} />)
    act(() => receive({ info: OFF, refusal: null }))
    fireEvent.change(screen.getByLabelText("Owner's Slack member ID"), { target: { value: '@me' } })
    fireEvent.click(screen.getByTestId('slack-save'))
    expect(calls.slackConfigure).toHaveBeenCalledWith('@me', [], 'en')
    act(() => receive({ info: OFF, refusal: 'owner "@me" is not a Slack member ID' }))
    expect(screen.getByTestId('slack-refusal').textContent).toContain('not a Slack member ID')
    expect((screen.getByLabelText("Owner's Slack member ID") as HTMLInputElement).value).toBe('@me')
  })
})
