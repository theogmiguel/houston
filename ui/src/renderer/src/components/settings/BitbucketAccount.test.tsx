// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient } from '../../houston/client'
import { BitbucketAccount } from './BitbucketAccount'

afterEach(cleanup)

function fakeClient(): {
  client: HoustonClient
  receive: (message: unknown) => void
  fail: (message: unknown) => void
  calls: Record<string, ReturnType<typeof vi.fn>>
} {
  let handler: (message: unknown) => void = () => {}
  let errorHandler: (message: unknown) => void = () => {}
  const calls = { send: vi.fn() }
  const client = {
    subscribe: (type: string, callback: (message: unknown) => void) => {
      if (type === 'forge_settings') handler = callback
      if (type === 'error') errorHandler = callback
      return () => {}
    },
    ...calls
  } as unknown as HoustonClient
  return { client, receive: (m) => handler(m), fail: (m) => errorHandler(m), calls }
}

describe('Bitbucket Cloud account settings', () => {
  it('shows the current value, sends a token once and never echoes it back', () => {
    const { client, receive, calls } = fakeClient()
    render(<BitbucketAccount client={client} />)
    expect(calls.send).toHaveBeenCalledWith({ type: 'forge_settings_get' })
    act(() => receive({ bitbucket_enabled: false, bitbucket_account: null, keyring_error: null }))

    const toggle = screen.getByTestId('bitbucket-enabled')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    expect(calls.send).toHaveBeenCalledWith({ type: 'bitbucket_enabled_set', enabled: true })

    const disconnect = screen.getByText('Disconnect') as HTMLButtonElement
    expect(disconnect.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Atlassian account e-mail'), { target: { value: ' me@example.com ' } })
    const token = screen.getByLabelText('Bitbucket API token') as HTMLInputElement
    expect(token.type).toBe('password')
    fireEvent.change(token, { target: { value: 'ATATT-secret' } })
    fireEvent.click(screen.getByText('Save token'))
    expect(calls.send).toHaveBeenCalledWith({ type: 'bitbucket_token_set', email: 'me@example.com', token: 'ATATT-secret' })

    act(() => receive({ bitbucket_enabled: true, bitbucket_account: 'me@example.com', keyring_error: null }))
    expect(token.value).toBe('')
    expect(screen.getByTestId('bitbucket-enabled').getAttribute('aria-checked')).toBe('true')
    expect(document.body.textContent).toContain('Connected as me@example.com')
    expect(document.body.textContent).not.toContain('ATATT-secret')
    fireEvent.click(screen.getByText('Disconnect'))
    expect(calls.send).toHaveBeenCalledWith({ type: 'bitbucket_token_clear' })
  })

  it('shows a refused token and keeps the field', () => {
    const { client, receive, fail, calls } = fakeClient()
    render(<BitbucketAccount client={client} />)
    act(() => receive({ bitbucket_enabled: true, bitbucket_account: null, keyring_error: null }))
    fireEvent.change(screen.getByLabelText('Atlassian account e-mail'), { target: { value: 'me@example.com' } })
    const token = screen.getByLabelText('Bitbucket API token') as HTMLInputElement
    fireEvent.change(token, { target: { value: 'ATATT-secret' } })
    fireEvent.click(screen.getByText('Save token'))
    expect(calls.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'bitbucket_token_set' }))

    act(() => fail({ message: 'an unrelated failure', context: null }))
    expect(screen.queryByTestId('bitbucket-refusal')).toBeNull()
    const reason = 'storing the Bitbucket API token in the system keychain failed: locked'
    act(() => fail({ message: reason, context: 'forge_settings' }))
    expect(screen.getByTestId('bitbucket-refusal').textContent).toBe(reason)
    expect(token.value).toBe('ATATT-secret')
    expect(document.body.textContent).not.toContain('Connected as')
  })

  it('names an unusable keychain', () => {
    const { client, receive } = fakeClient()
    render(<BitbucketAccount client={client} />)
    act(() => receive({ bitbucket_enabled: true, bitbucket_account: null, keyring_error: 'no Secret Service' }))
    expect(document.body.textContent).toContain('OS keychain is not answering')
    expect(document.body.textContent).toContain('no Secret Service')
  })
})
