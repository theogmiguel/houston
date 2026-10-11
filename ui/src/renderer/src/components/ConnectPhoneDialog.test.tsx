// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient } from '../houston/client'
import type { RemoteInfo } from '../houston/generated/RemoteInfo'
import type { ServerMsg } from '../houston/generated/ServerMsg'
import { openConnectPhone } from '../connectPhone'
import { ConnectPhoneDialog, ConnectPhoneHost, routeSettings } from './ConnectPhoneDialog'

function info(overrides: Partial<RemoteInfo> = {}): RemoteInfo {
  return { enabled: false, bind: '127.0.0.1:47823', public_url: null, url: 'http://127.0.0.1:47823', listening: false, error: null, ntfy_server: null, notify_delay_secs: 30, notify_detail: 'generic', notify_finished: false, devices: [], ...overrides }
}
function setup(host = false) {
  const handlers = new Map<string, Set<(message: ServerMsg) => void>>()
  const client = {
    remoteGet: vi.fn(), remoteConfigure: vi.fn(), remotePairStart: vi.fn(), remoteDeviceRevoke: vi.fn(),
    subscribe: (kind: string, handler: (message: ServerMsg) => void) => {
      const set = handlers.get(kind) ?? new Set()
      set.add(handler)
      handlers.set(kind, set)
      return () => set.delete(handler)
    }
  }
  const onClose = vi.fn()
  const asClient = client as unknown as HoustonClient
  const view = render(host ? <ConnectPhoneHost client={asClient} /> : <ConnectPhoneDialog client={asClient} onClose={onClose} />)
  const emit = (message: ServerMsg): void => {
    act(() => { for (const handler of handlers.get(message.type) ?? []) handler(message) })
  }
  return { client, onClose, emit, ...view }
}
const ready = { enabled: true, listening: true, public_url: 'https://box.ts.net', url: 'https://box.ts.net' }
const code = (): ServerMsg => ({ type: 'remote_pairing', url: 'https://box.ts.net/#pair=abc', qr_svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', expires_at: Date.now() + 600_000 })

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('ConnectPhoneDialog', () => {
  it('opens from the shared entry point and closes on Escape', () => {
    const { client } = setup(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    act(openConnectPhone)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(client.remoteGet).toHaveBeenCalledOnce()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('requires an explicit enable press with the security sentence visible and waits for acknowledgement', () => {
    const { client, emit } = setup()
    emit({ type: 'remote_state', remote: info() })
    expect(screen.getByText(/as much access as a shell/)).toBeTruthy()
    expect(client.remoteConfigure).not.toHaveBeenCalled()
    expect(client.remotePairStart).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Connection URL' }), { target: { value: 'https://box.ts.net' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enable remote access' }))
    expect(client.remoteConfigure).toHaveBeenCalledWith({ bind: '127.0.0.1:47823', public_url: 'https://box.ts.net', enabled: true })
    expect(client.remotePairStart).not.toHaveBeenCalled()
    emit({ type: 'remote_state', remote: info(ready) })
    expect(client.remotePairStart).toHaveBeenCalledOnce()
    emit(code())
    expect(screen.getByAltText('Pairing code')).toBeTruthy()
    expect(screen.getByText(/Waiting for the phone/)).toBeTruthy()
  })

  it('counts down, copies the link, and permits a new code after expiry', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const { emit, client } = setup()
    emit({ type: 'remote_state', remote: info(ready) })
    emit(code())
    expect(screen.getByText(/expires in 10:00/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await act(async () => { await Promise.resolve() })
    expect(writeText).toHaveBeenCalledWith('https://box.ts.net/#pair=abc')
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByText(/expires in 9:59/)).toBeTruthy()
    act(() => vi.advanceTimersByTime(599_000))
    expect(screen.queryByAltText('Pairing code')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Get a new code' }))
    expect(client.remotePairStart).toHaveBeenCalledTimes(2)
  })

  it('shows only a newly paired device as confirmed, then connects another', () => {
    const { client, emit, onClose } = setup()
    const old = { id: 1, name: 'Old phone', created_at: 1, last_seen_at: null }
    emit({ type: 'remote_state', remote: info({ ...ready, devices: [old] }) })
    emit(code())
    emit({ type: 'remote_state', remote: info({ ...ready, devices: [old] }) })
    expect(screen.queryByText(/is connected/)).toBeNull()
    emit({ type: 'remote_state', remote: info({ ...ready, devices: [old, { ...old, id: 2, name: 'Pixel 8' }] }) })
    expect(screen.getByText('Pixel 8 is connected')).toBeTruthy()
    expect(screen.queryByAltText('Pairing code')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Connect another' }))
    expect(client.remotePairStart).toHaveBeenCalledTimes(2)
    emit(code())
    emit({ type: 'remote_state', remote: info({ ...ready, devices: [old, { ...old, id: 2, name: 'Pixel 8' }, { ...old, id: 3, name: 'Tablet' }] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('applies the Wi-Fi route with the HTTP warning and preserves the configured port', () => {
    const { client, emit } = setup()
    emit({ type: 'remote_state', remote: info({ bind: '127.0.0.1:47824' }) })
    const route = screen.getByRole('combobox')
    fireEvent.keyDown(route, { key: 's' })
    expect(screen.getByText(/token and the pane text/)).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Connection URL' }), { target: { value: 'http://192.168.1.20:47824' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enable remote access' }))
    expect(client.remoteConfigure).toHaveBeenCalledWith({ bind: '0.0.0.0:47824', public_url: 'http://192.168.1.20:47824', enabled: true })
  })

  it('restores focus to the opener when unmounted', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const { unmount } = setup()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
    unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('hides the code if remote access is turned off', () => {
    const { emit } = setup()
    emit({ type: 'remote_state', remote: info(ready) })
    emit(code())
    emit({ type: 'remote_state', remote: info({ ...ready, enabled: false, listening: false }) })
    expect(screen.queryByAltText('Pairing code')).toBeNull()
    expect(screen.getByRole('button', { name: 'Enable remote access' })).toBeTruthy()
  })

  it('shows remote errors, and traps focus between its controls', () => {
    const { emit } = setup()
    emit({ type: 'remote_state', remote: info() })
    emit({ type: 'error', context: 'remote', message: 'cannot listen on 127.0.0.1:47823: in use' })
    expect(screen.getByText(/cannot listen/)).toBeTruthy()
    const close = screen.getByRole('button', { name: 'Close' })
    close.focus()
    fireEvent.keyDown(close, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('combobox'))
  })
})

describe('routeSettings', () => {
  it('keeps Tailscale on loopback and maps Wi-Fi to all interfaces', () => {
    expect(routeSettings('tailscale', '47824', 'https://box.ts.net/')).toEqual({ bind: '127.0.0.1:47824', public_url: 'https://box.ts.net' })
    expect(routeSettings('wifi', '47824', 'http://192.168.1.20:47824')).toEqual({ bind: '0.0.0.0:47824', public_url: 'http://192.168.1.20:47824' })
  })
  it('refuses the wrong protocol, wildcard URLs, credentials, and paths', () => {
    expect(routeSettings('tailscale', '47823', 'http://box.ts.net')).toBeNull()
    expect(routeSettings('wifi', '47823', 'http://0.0.0.0:47823')).toBeNull()
    expect(routeSettings('wifi', '47823', 'http://127.0.0.1:47823')).toBeNull()
    expect(routeSettings('wifi', '47823', 'http://192.168.1.20:47824')).toBeNull()
    expect(routeSettings('tailscale', '47823', 'https://user:pass@box.ts.net')).toBeNull()
    expect(routeSettings('tailscale', '47823', 'https://box.ts.net/path')).toBeNull()
  })
})
