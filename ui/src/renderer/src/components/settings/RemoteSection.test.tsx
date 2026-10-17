// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient } from '../../houston/client'
import type { RemoteInfo } from '../../houston/generated/RemoteInfo'
import type { ServerMsg } from '../../houston/generated/ServerMsg'
import { plainHttpOffLoopback } from '../../houston/useRemote'
import { bindError, RemoteSection, routeKind } from './RemoteSection'
import { deviceActivity } from './RemotePairing'

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
    dictation: false,
    tls: false,
    ca_fingerprint: null,
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
    remoteCaRegenerate: vi.fn(),
    remoteDeviceRevoke: vi.fn(),
    remoteDeviceSetTier: vi.fn()
  }
  const emit = (msg: ServerMsg): void => {
    act(() => {
      for (const h of handlers.get(msg.type) ?? []) h(msg)
    })
  }
  return { client, emit, asClient: client as unknown as HoustonClient }
}

afterEach(() => { cleanup(); vi.useRealTimers() })

describe('RemoteSection', () => {
  it('asks for the state, then shows the listener off with its reason and disabled actions', () => {
    const { client, emit, asClient } = fakeClient()
    renderSection(asClient)
    expect(client.remoteGet).toHaveBeenCalledOnce()
    expect(screen.getByText(/Asking the daemon/)).toBeTruthy()
    emit({ type: 'remote_state', remote: info({ devices: [{ id: 7, name: 'Laptop', tier: 'drive', created_at: 1, last_seen_at: null }] }) })
    expect(screen.getByTestId('settings-remote-status').textContent).toBe('Off. Nothing listens and nothing is sent.')
    for (const id of ['settings-remote-revoke-7', 'settings-remote-ntfy-edit', 'settings-remote-delay', 'settings-remote-detail', 'settings-remote-finished', 'settings-remote-dictation']) {
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(true)
    }
    expect((screen.getByTestId('settings-remote-connect-phone') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByText(/Showing a code turns it on/)).toBeTruthy()
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
    expect(routeKind({ bind: '127.0.0.1:47823', public_url: 'https://box.ts.net', tls: false })).toBe('Tailscale')
    expect(routeKind({ bind: '0.0.0.0:47823', public_url: 'https://192.168.1.20:47823', tls: true })).toBe('Same Wi-Fi')
    expect(routeKind({ bind: '0.0.0.0:47823', public_url: 'http://192.168.1.20:47823', tls: false })).toBe('Same Wi-Fi')
    expect(routeKind({ bind: '127.0.0.1:47823', public_url: null, tls: false })).toBe('Custom')
    expect(routeKind({ bind: '100.64.0.2:47823', public_url: 'https://box.ts.net', tls: false })).toBe('Custom')
    const { emit, asClient } = fakeClient()
    const onChangeRoute = renderSection(asClient)
    emit({ type: 'remote_state', remote: info({ enabled: true, listening: true, public_url: 'https://box.ts.net' }) })
    expect(screen.getByTestId('settings-remote-route').textContent).toBe('Tailscale')
    fireEvent.click(screen.getByText('Route and address'))
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
    fireEvent.click(screen.getByText('Route and address'))
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

  it('shows the pairing code inline after the daemon confirms listening', () => {
    const { emit, asClient, client } = fakeClient()
    renderSection(asClient)
    const remote = info({ public_url: 'https://box.ts.net', url: 'https://box.ts.net' })
    emit({ type: 'remote_state', remote })
    fireEvent.click(screen.getByTestId('settings-remote-connect-phone'))
    expect(client.remoteConfigure).toHaveBeenCalledWith({ enabled: true })
    expect(client.remotePairStart).not.toHaveBeenCalled()
    emit({ type: 'remote_state', remote: { ...remote, enabled: true, listening: true } })
    expect(client.remotePairStart).toHaveBeenCalledOnce()
    emit({ type: 'remote_pairing', url: 'https://box.ts.net/pair?code=fixture', qr_svg: '<svg/>', expires_at: Date.now() + 600_000 })
    expect(screen.getByRole('img', { name: 'Pairing code' })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('Scan with your phone')).toBeTruthy()
    emit({ type: 'remote_state', remote: { ...remote, enabled: true, listening: true, devices: [{ id: 7, name: 'Phone', tier: 'drive', created_at: Date.now(), last_seen_at: Date.now() }] } })
    expect(screen.queryByRole('img', { name: 'Pairing code' })).toBeNull()
    expect(screen.getByText('Phone')).toBeTruthy()
  })

  it('reports activity from last_seen_at and starts with the advanced rows collapsed', () => {
    const { emit, asClient } = fakeClient()
    renderSection(asClient)
    emit({ type: 'remote_state', remote: info({ enabled: true, devices: [
      { id: 1, name: 'Phone', tier: 'drive', created_at: 1, last_seen_at: Date.now() - 30_000 },
      { id: 2, name: 'Laptop', tier: 'drive', created_at: 1, last_seen_at: Date.now() - 3 * 3_600_000 },
      { id: 3, name: 'Unknown', tier: 'drive', created_at: 1, last_seen_at: null }
    ] }) })
    expect(screen.getByText('Active now')).toBeTruthy()
    expect(screen.getByText('Last seen 3h ago')).toBeTruthy()
    expect(screen.getByText('Last seen not reported')).toBeTruthy()
    for (const label of ['Phone notifications', 'Route and address']) {
      expect(screen.getByText(label).closest('details')?.open).toBe(false)
    }
  })

  it('formats paired dates in English whatever the system locale is', () => {
    const real = Date.prototype.toLocaleDateString
    vi.spyOn(Date.prototype, 'toLocaleDateString').mockImplementation(function (this: Date, locales, options) {
      return real.call(this, locales ?? 'pt-BR', options)
    })
    const { emit, asClient } = fakeClient()
    renderSection(asClient)
    emit({ type: 'remote_state', remote: info({ enabled: true, devices: [{ id: 1, name: 'Phone', tier: 'drive', created_at: Date.UTC(2026, 9, 8, 12), last_seen_at: null }] }) })
    expect(screen.getByText('Paired Oct 8')).toBeTruthy()
    vi.restoreAllMocks()
  })

  it('renders Revoke as an underlined link and Show pairing code with a phone glyph', () => {
    const { emit, asClient } = fakeClient()
    renderSection(asClient)
    emit({ type: 'remote_state', remote: info({ enabled: true, devices: [{ id: 7, name: 'Laptop', tier: 'drive', created_at: 1, last_seen_at: null }] }) })
    expect(screen.getByTestId('settings-remote-revoke-7').className).toContain('underline')
    expect(screen.getByTestId('settings-remote-connect-phone').querySelector('svg')).toBeTruthy()
  })

  it('requests a route for the default loopback address rather than an unreachable phone code', () => {
    const { emit, asClient, client } = fakeClient()
    const changeRoute = renderSection(asClient)
    emit({ type: 'remote_state', remote: info() })
    fireEvent.click(screen.getByTestId('settings-remote-connect-phone'))
    expect(changeRoute).toHaveBeenCalledOnce()
    expect(client.remotePairStart).not.toHaveBeenCalled()
    expect(client.remoteConfigure).not.toHaveBeenCalled()
  })

  it('gives Paired devices primary medium heading chrome and a right-aligned count', () => {
    const { emit, asClient } = fakeClient()
    renderSection(asClient)
    emit({ type: 'remote_state', remote: info({ devices: [{ id: 1, name: 'Phone', tier: 'drive', created_at: 1, last_seen_at: null }] }) })
    const heading = screen.getByRole('heading', { name: /Paired devices/ })
    expect(heading.classList.contains('text-[var(--text-primary)]')).toBe(true)
    expect(heading.classList.contains('font-medium')).toBe(true)
    expect(heading.lastElementChild?.classList.contains('ml-auto')).toBe(true)
    expect(heading.lastElementChild?.textContent).toBe('1')
  })

  it('paints Active now text in the success tone and retains the access warning', () => {
    const { emit, asClient } = fakeClient()
    renderSection(asClient)
    emit({ type: 'remote_state', remote: info({ enabled: true, devices: [{ id: 1, name: 'Phone', tier: 'drive', created_at: 1, last_seen_at: Date.now() }] }) })
    expect(screen.getByText('Active now').classList.contains('text-[var(--success)]')).toBe(true)
    expect(screen.getByText(/A paired device can read and type into any pane/)).toBeTruthy()
  })

  it('ages activity at the two-minute boundary and removes expired codes', () => {
    vi.useFakeTimers()
    const now = 1_790_000_000_000
    vi.setSystemTime(now)
    expect(deviceActivity(now - 119_999, now)).toBe('Active now')
    expect(deviceActivity(now - 120_000, now)).toBe('Last seen 2m ago')
    const { emit, asClient } = fakeClient()
    renderSection(asClient)
    emit({ type: 'remote_state', remote: info({ enabled: true, listening: true, devices: [{ id: 1, name: 'Phone', tier: 'drive', created_at: 1, last_seen_at: now - 60_000 }] }) })
    expect(screen.getByText('Active now')).toBeTruthy()
    emit({ type: 'remote_pairing', url: 'https://box.ts.net/#pair=fixture', qr_svg: '<svg/>', expires_at: now + 60_000 })
    expect(screen.getByRole('img', { name: 'Pairing code' })).toBeTruthy()
    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.getByText('Last seen 2m ago')).toBeTruthy()
    expect(screen.queryByRole('img', { name: 'Pairing code' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Show pairing code' })).toBeTruthy()
  })

  it('ends a pending request on a daemon refusal and hides codes without stopping the listener', () => {
    const { emit, asClient, client } = fakeClient()
    renderSection(asClient)
    emit({ type: 'remote_state', remote: info({ enabled: true, listening: true, public_url: 'https://box.ts.net' }) })
    fireEvent.click(screen.getByTestId('settings-remote-connect-phone'))
    emit({ type: 'error', context: 'remote', message: 'Could not issue a code' })
    expect(screen.getByTestId('settings-remote-error').textContent).toContain('Could not issue a code')
    expect((screen.getByTestId('settings-remote-connect-phone') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByTestId('settings-remote-connect-phone'))
    emit({ type: 'remote_pairing', url: 'https://box.ts.net/#pair=fixture', qr_svg: '<svg/>', expires_at: Date.now() + 600_000 })
    fireEvent.click(screen.getByRole('button', { name: 'Hide code' }))
    expect(screen.queryByRole('img', { name: 'Pairing code' })).toBeNull()
    expect(client.remoteConfigure).not.toHaveBeenCalled()
    expect(client.remoteDeviceRevoke).not.toHaveBeenCalled()
  })

  it('shows dictation from devices off by default, with what it sends, and turns it on', () => {
    const { client, emit, asClient } = fakeClient()
    renderSection(asClient)
    emit({ type: 'remote_state', remote: info({ enabled: true, listening: true }) })
    fireEvent.click(screen.getByText('Dictation'))
    const toggle = screen.getByTestId('settings-remote-dictation')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByTestId('settings-remote-dictation-disclosure').textContent).toContain('sent to Groq')
    fireEvent.click(toggle)
    expect(client.remoteConfigure).toHaveBeenCalledWith({ dictation: true })
    emit({ type: 'remote_state', remote: info({ enabled: true, listening: true, dictation: true }) })
    expect(screen.getByTestId('settings-remote-dictation').getAttribute('aria-checked')).toBe('true')
  })

  it('lists devices and revokes only after confirmation', () => {
    const { client, emit, asClient } = fakeClient()
    renderSection(asClient)
    emit({ type: 'remote_state', remote: info({ enabled: true, listening: true, devices: [{ id: 7, name: 'Laptop', tier: 'drive', created_at: 1, last_seen_at: null }] }) })
    expect(screen.getByText('Laptop')).toBeTruthy()
    fireEvent.click(screen.getByTestId('settings-remote-revoke-7'))
    expect(client.remoteDeviceRevoke).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Revoke', { selector: 'button *' }))
    expect(client.remoteDeviceRevoke).toHaveBeenCalledWith(7)
  })

  it('shows each device tier and changes it from the select', () => {
    const { client, emit, asClient } = fakeClient()
    renderSection(asClient)
    emit({ type: 'remote_state', remote: info({ enabled: true, listening: true, devices: [
      { id: 7, name: 'Laptop', tier: 'observe', created_at: 1, last_seen_at: null },
      { id: 8, name: 'Phone', tier: 'drive', created_at: 1, last_seen_at: null }
    ] }) })
    expect(screen.getByTestId('settings-remote-tier-7').textContent).toContain('Observe')
    expect(screen.getByTestId('settings-remote-tier-8').textContent).toContain('Drive')
    fireEvent.mouseDown(screen.getByTestId('settings-remote-tier-8'))
    fireEvent.mouseUp(screen.getByRole('option', { name: 'Manage' }))
    expect(client.remoteDeviceSetTier).toHaveBeenCalledWith(8, 'manage')
    emit({ type: 'remote_state', remote: info({ enabled: true, listening: true, devices: [
      { id: 7, name: 'Laptop', tier: 'observe', created_at: 1, last_seen_at: null },
      { id: 8, name: 'Phone', tier: 'manage', created_at: 1, last_seen_at: null }
    ] }) })
    expect(screen.getByTestId('settings-remote-tier-8').textContent).toContain('Manage')
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
    fireEvent.click(screen.getByText('Phone notifications'))
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
    expect(plainHttpOffLoopback({ bind: '127.0.0.1:47823', public_url: null, tls: false })).toBe(false)
    expect(plainHttpOffLoopback({ bind: '100.64.0.2:47823', public_url: 'https://box.ts.net', tls: false })).toBe(false)
    expect(plainHttpOffLoopback({ bind: '[::1]:47823', public_url: null, tls: false })).toBe(false)
    expect(plainHttpOffLoopback({ bind: '192.168.1.20:47823', public_url: null, tls: true })).toBe(false)
  })

  it('describes the Same Wi-Fi route over HTTPS with no plain-HTTP warning', () => {
    const { emit, asClient } = fakeClient()
    renderSection(asClient)
    emit({ type: 'remote_state', remote: info({ enabled: true, bind: '0.0.0.0:47823', public_url: 'https://192.168.1.20:47823', url: 'https://192.168.1.20:47823', tls: true, ca_fingerprint: 'AB:CD' }) })
    expect(screen.getByTestId('settings-remote-route').textContent).toBe('Same Wi-Fi')
    expect(screen.queryByTestId('settings-remote-plain-http')).toBeNull()
    expect(screen.getByText(/over HTTPS, with this computer's certificate/)).toBeTruthy()
  })

  it('shows the certificate fingerprint and regenerates only after confirmation', () => {
    const { client, emit, asClient } = fakeClient()
    renderSection(asClient)
    emit({ type: 'remote_state', remote: info({ enabled: true, listening: true, public_url: 'https://box.ts.net' }) })
    expect(screen.queryByTestId('settings-remote-ca-fingerprint')).toBeNull()
    emit({ type: 'remote_state', remote: info({ enabled: true, listening: true, bind: '192.168.1.20:47823', tls: true }) })
    expect(screen.getByTestId('settings-remote-ca-fingerprint').textContent).toContain('first serves HTTPS')
    emit({ type: 'remote_state', remote: info({ enabled: true, listening: true, bind: '192.168.1.20:47823', tls: true, ca_fingerprint: 'AB:CD' }) })
    expect(screen.getByTestId('settings-remote-ca-fingerprint').textContent).toBe('AB:CD')
    fireEvent.click(screen.getByText('Route and address'))
    fireEvent.click(screen.getByTestId('settings-remote-ca-regenerate'))
    expect(client.remoteCaRegenerate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Regenerate', { selector: 'button *' }))
    expect(client.remoteCaRegenerate).toHaveBeenCalledOnce()
  })
})
