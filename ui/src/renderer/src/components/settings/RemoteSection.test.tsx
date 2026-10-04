// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient } from '../../houston/client'
import type { RemoteInfo } from '../../houston/generated/RemoteInfo'
import type { ServerMsg } from '../../houston/generated/ServerMsg'
import { plainHttpOffLoopback } from '../../houston/useRemote'
import { RemoteSection } from './RemoteSection'

function info(overrides: Partial<RemoteInfo> = {}): RemoteInfo {
  return {
    enabled: false,
    bind: '127.0.0.1:47823',
    public_url: null,
    url: 'http://127.0.0.1:47823',
    listening: false,
    error: null,
    ntfy_server: null,
    notify_delay_secs: 30,
    notify_detail: 'generic',
    notify_finished: false,
    devices: [],
    ...overrides
  }
}

function fakeClient() {
  const handlers = new Map<string, Set<(msg: ServerMsg) => void>>()
  const client = {
    subscribe: (kind: string, handler: (msg: ServerMsg) => void) => {
      const set = handlers.get(kind) ?? new Set()
      set.add(handler)
      handlers.set(kind, set)
      return () => set.delete(handler)
    },
    remoteGet: vi.fn(),
    remoteConfigure: vi.fn(),
    remotePairStart: vi.fn(),
    remoteDeviceRevoke: vi.fn()
  }
  const emit = (msg: ServerMsg): void => {
    act(() => {
      for (const h of handlers.get(msg.type) ?? []) h(msg)
    })
  }
  return { client, emit, asClient: client as unknown as HoustonClient }
}

afterEach(cleanup)

describe('RemoteSection', () => {
  it('asks for the state, then shows the listener off by default', () => {
    const { client, emit, asClient } = fakeClient()
    render(<RemoteSection client={asClient} />)
    expect(client.remoteGet).toHaveBeenCalledOnce()
    expect(screen.getByText(/Asking the daemon/)).toBeTruthy()
    emit({ type: 'remote_state', remote: info() })
    expect(screen.getByTestId('settings-remote-status').textContent).toBe('Off.')
    expect((screen.getByTestId('settings-remote-pair') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('settings-remote-enabled'))
    expect(client.remoteConfigure).toHaveBeenCalledWith({ enabled: true })
  })

  it('reports the listening address and a bind error', () => {
    const { emit, asClient } = fakeClient()
    render(<RemoteSection client={asClient} />)
    emit({ type: 'remote_state', remote: info({ enabled: true, listening: true }) })
    expect(screen.getByTestId('settings-remote-status').textContent).toContain('http://127.0.0.1:47823')
    emit({ type: 'remote_state', remote: info({ enabled: true, error: 'cannot listen on 127.0.0.1:47823: in use' }) })
    expect(screen.getByTestId('settings-remote-status').textContent).toContain('in use')
  })

  it('shows the pairing code until a device pairs', () => {
    const { client, emit, asClient } = fakeClient()
    render(<RemoteSection client={asClient} />)
    emit({ type: 'remote_state', remote: info({ enabled: true, listening: true }) })
    fireEvent.click(screen.getByTestId('settings-remote-pair'))
    expect(client.remotePairStart).toHaveBeenCalledOnce()
    emit({
      type: 'remote_pairing',
      url: 'http://127.0.0.1:47823/#pair=abc',
      qr_svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      expires_at: Date.now() + 600_000
    })
    expect((screen.getByTestId('settings-remote-pair-url') as HTMLInputElement).value).toBe('http://127.0.0.1:47823/#pair=abc')
    expect(screen.getByAltText('Pairing code')).toBeTruthy()
    emit({
      type: 'remote_state',
      remote: info({ enabled: true, listening: true, devices: [{ id: 1, name: 'Pixel', created_at: Date.now(), last_seen_at: Date.now() }] })
    })
    expect(screen.queryByTestId('settings-remote-pair-url')).toBeNull()
    expect(screen.getByText('Pixel')).toBeTruthy()
  })

  it('revokes a device only on the second press', () => {
    const { client, emit, asClient } = fakeClient()
    render(<RemoteSection client={asClient} />)
    emit({ type: 'remote_state', remote: info({ devices: [{ id: 7, name: 'Laptop', created_at: 1, last_seen_at: null }] }) })
    const button = screen.getByTestId('settings-remote-revoke-7')
    fireEvent.click(button)
    expect(client.remoteDeviceRevoke).not.toHaveBeenCalled()
    fireEvent.click(button)
    expect(client.remoteDeviceRevoke).toHaveBeenCalledWith(7)
  })

  it('shows remote refusals and ignores other errors', () => {
    const { emit, asClient } = fakeClient()
    render(<RemoteSection client={asClient} />)
    emit({ type: 'remote_state', remote: info() })
    emit({ type: 'error', message: 'unrelated', context: 'stdin' })
    expect(screen.queryByTestId('settings-remote-error')).toBeNull()
    emit({ type: 'error', message: 'remote bind "x" is not an address', context: 'remote' })
    expect(screen.getByTestId('settings-remote-error').textContent).toContain('remote bind')
  })

  it('saves and clears the ntfy topic without showing it back', () => {
    const { client, emit, asClient } = fakeClient()
    render(<RemoteSection client={asClient} />)
    emit({ type: 'remote_state', remote: info() })
    const input = screen.getByTestId('settings-remote-ntfy-url') as HTMLInputElement
    fireEvent.change(input, { target: { value: ' https://ntfy.sh/secret ' } })
    fireEvent.click(screen.getByTestId('settings-remote-ntfy-save'))
    expect(client.remoteConfigure).toHaveBeenCalledWith({ ntfy_url: 'https://ntfy.sh/secret' })
    expect(input.value).toBe('')
    emit({ type: 'remote_state', remote: info({ ntfy_server: 'https://ntfy.sh' }) })
    expect(screen.getByText(/sending to https:\/\/ntfy.sh\./)).toBeTruthy()
    fireEvent.click(screen.getByTestId('settings-remote-ntfy-clear'))
    expect(client.remoteConfigure).toHaveBeenCalledWith({ ntfy_url: '' })
  })

  it('warns about plain HTTP off loopback', () => {
    const { emit, asClient } = fakeClient()
    render(<RemoteSection client={asClient} />)
    emit({ type: 'remote_state', remote: info({ enabled: true, bind: '0.0.0.0:47823', public_url: 'http://192.168.1.20:47823' }) })
    expect(screen.getByTestId('settings-remote-plain-http')).toBeTruthy()
    expect(plainHttpOffLoopback({ bind: '127.0.0.1:47823', public_url: null })).toBe(false)
    expect(plainHttpOffLoopback({ bind: '100.64.0.2:47823', public_url: 'https://box.ts.net' })).toBe(false)
    expect(plainHttpOffLoopback({ bind: '[::1]:47823', public_url: null })).toBe(false)
  })
})
