// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient } from '../../houston/client'
import type { RemoteInfo } from '../../houston/generated/RemoteInfo'
import type { ServerMsg } from '../../houston/generated/ServerMsg'
import { plainHttpOffLoopback } from '../../houston/useRemote'
import { bindError, RemoteSection, routeKind } from './RemoteSection'
import { CONNECT_PHONE_EVENT } from '../../connectPhone'

const renderSection = (client: HoustonClient, onChangeRoute = vi.fn()) => {
  render(<RemoteSection client={client} onChangeRoute={onChangeRoute} />)
  return onChangeRoute
}

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
  it('asks for the state, then shows the listener off with its reason and disabled actions', () => {
    const { client, emit, asClient } = fakeClient()
    renderSection(asClient)
    expect(client.remoteGet).toHaveBeenCalledOnce()
    expect(screen.getByText(/Asking the daemon/)).toBeTruthy()
    emit({ type: 'remote_state', remote: info({ devices: [{ id: 7, name: 'Laptop', created_at: 1, last_seen_at: null }] }) })
    expect(screen.getByTestId('settings-remote-status').textContent).toBe('Off. Nothing listens and nothing is sent.')
    for (const id of ['settings-remote-connect-phone', 'settings-remote-revoke-7', 'settings-remote-ntfy-edit', 'settings-remote-delay', 'settings-remote-detail', 'settings-remote-finished']) {
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(true)
    }
    expect(screen.getByText('Connect a phone').closest('[data-testid="settings-row"]')?.textContent).toContain('Turn on remote access first.')
    fireEvent.click(screen.getByTestId('settings-remote-enabled'))
    expect(client.remoteConfigure).toHaveBeenCalledWith({ enabled: true })
  })

  it('reports the listening address and a bind error', () => {
    const { emit, asClient } = fakeClient()
    renderSection(asClient)
    emit({ type: 'remote_state', remote: info({ enabled: true, listening: true }) })
    expect(screen.getByTestId('settings-remote-status').textContent).toBe('Listening at http://127.0.0.1:47823')
    emit({ type: 'remote_state', remote: info({ enabled: true, error: 'cannot listen on 127.0.0.1:47823: in use' }) })
    expect(screen.getByTestId('settings-remote-status').textContent).toContain('in use')
  })

  it('derives the route and hands Change… to the caller', () => {
    expect(routeKind({ bind: '127.0.0.1:47823', public_url: 'https://box.ts.net' })).toBe('Tailscale')
    expect(routeKind({ bind: '0.0.0.0:47823', public_url: 'http://192.168.1.20:47823' })).toBe('Same Wi-Fi')
    expect(routeKind({ bind: '127.0.0.1:47823', public_url: null })).toBe('Custom')
    expect(routeKind({ bind: '100.64.0.2:47823', public_url: 'https://box.ts.net' })).toBe('Custom')
    const { emit, asClient } = fakeClient()
    const onChangeRoute = renderSection(asClient)
    emit({ type: 'remote_state', remote: info({ enabled: true, listening: true, public_url: 'https://box.ts.net' }) })
    expect(screen.getByTestId('settings-remote-route').textContent).toBe('Tailscale')
    fireEvent.click(screen.getByTestId('settings-remote-route-change'))
    expect(onChangeRoute).toHaveBeenCalledOnce()
  })

  it('validates the listen address before sending it', () => {
    expect(bindError('127.0.0.1:47823')).toBeNull()
    expect(bindError('[::1]:80')).toBeNull()
    expect(bindError('localhost')).toContain('"localhost" must be IP:PORT')
    expect(bindError('127.0.0.1:70000')).toContain('"127.0.0.1:70000" must be IP:PORT')
    const { client, emit, asClient } = fakeClient()
    renderSection(asClient)
    emit({ type: 'remote_state', remote: info() })
    fireEvent.click(screen.getByTestId('settings-remote-bind-edit'))
    fireEvent.change(screen.getByTestId('settings-remote-bind-input'), { target: { value: 'nope' } })
    fireEvent.click(screen.getByTestId('settings-remote-bind-save'))
    expect(screen.getByText(/"nope" must be IP:PORT/)).toBeTruthy()
    expect(client.remoteConfigure).not.toHaveBeenCalled()
    fireEvent.change(screen.getByTestId('settings-remote-bind-input'), { target: { value: ' 0.0.0.0:47823 ' } })
    fireEvent.click(screen.getByTestId('settings-remote-bind-save'))
    expect(client.remoteConfigure).toHaveBeenCalledWith({ bind: '0.0.0.0:47823' })
    expect(screen.queryByTestId('settings-remote-bind-input')).toBeNull()
  })

  it('opens Connect phone from the Devices group', () => {
    const { emit, asClient, client } = fakeClient()
    const opened = vi.fn()
    window.addEventListener(CONNECT_PHONE_EVENT, opened)
    renderSection(asClient)
    emit({ type: 'remote_state', remote: info({ enabled: true, listening: true }) })
    fireEvent.click(screen.getByTestId('settings-remote-connect-phone'))
    expect(opened).toHaveBeenCalledOnce()
    expect(client.remotePairStart).not.toHaveBeenCalled()
    window.removeEventListener(CONNECT_PHONE_EVENT, opened)
  })

  it('lists devices and revokes only after confirmation', () => {
    const { client, emit, asClient } = fakeClient()
    renderSection(asClient)
    emit({ type: 'remote_state', remote: info({ enabled: true, listening: true, devices: [{ id: 7, name: 'Laptop', created_at: 1, last_seen_at: null }] }) })
    expect(screen.getByText('Laptop')).toBeTruthy()
    fireEvent.click(screen.getByTestId('settings-remote-revoke-7'))
    expect(client.remoteDeviceRevoke).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Revoke', { selector: 'button *' }))
    expect(client.remoteDeviceRevoke).toHaveBeenCalledWith(7)
  })

  it('shows remote refusals and ignores other errors', () => {
    const { emit, asClient } = fakeClient()
    renderSection(asClient)
    emit({ type: 'remote_state', remote: info() })
    emit({ type: 'error', message: 'unrelated', context: 'stdin' })
    expect(screen.queryByTestId('settings-remote-error')).toBeNull()
    emit({ type: 'error', message: 'remote bind "x" is not an address', context: 'remote' })
    expect(screen.getByTestId('settings-remote-error').textContent).toContain('remote bind')
  })

  it('saves and removes the ntfy topic without showing it back', () => {
    const { client, emit, asClient } = fakeClient()
    renderSection(asClient)
    emit({ type: 'remote_state', remote: info({ enabled: true, listening: true }) })
    expect(screen.getByTestId('settings-remote-ntfy-server').textContent).toBe('Off')
    fireEvent.click(screen.getByTestId('settings-remote-ntfy-edit'))
    expect(screen.queryByTestId('settings-remote-ntfy-clear')).toBeNull()
    fireEvent.change(screen.getByTestId('settings-remote-ntfy-url'), { target: { value: ' https://ntfy.sh/secret ' } })
    fireEvent.click(screen.getByTestId('settings-remote-ntfy-save'))
    expect(client.remoteConfigure).toHaveBeenCalledWith({ ntfy_url: 'https://ntfy.sh/secret' })
    emit({ type: 'remote_state', remote: info({ enabled: true, listening: true, ntfy_server: 'ntfy.sh' }) })
    expect(screen.getByTestId('settings-remote-ntfy-server').textContent).toBe('ntfy.sh')
    expect(document.body.textContent).not.toContain('secret')
    fireEvent.click(screen.getByTestId('settings-remote-ntfy-edit'))
    expect((screen.getByTestId('settings-remote-ntfy-url') as HTMLInputElement).value).toBe('')
    fireEvent.click(screen.getByTestId('settings-remote-ntfy-clear'))
    expect(client.remoteConfigure).toHaveBeenCalledWith({ ntfy_url: '' })
  })

  it('warns about plain HTTP off loopback in the Route row', () => {
    const { emit, asClient } = fakeClient()
    renderSection(asClient)
    emit({ type: 'remote_state', remote: info({ enabled: true, bind: '0.0.0.0:47823', public_url: 'http://192.168.1.20:47823' }) })
    expect(screen.getByTestId('settings-remote-plain-http').textContent).toContain('plain HTTP')
    expect(screen.getByTestId('settings-remote-route').textContent).toBe('Same Wi-Fi')
    expect(plainHttpOffLoopback({ bind: '127.0.0.1:47823', public_url: null })).toBe(false)
    expect(plainHttpOffLoopback({ bind: '100.64.0.2:47823', public_url: 'https://box.ts.net' })).toBe(false)
    expect(plainHttpOffLoopback({ bind: '[::1]:47823', public_url: null })).toBe(false)
  })
})
