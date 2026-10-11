// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EnvironmentEntry } from './environments'

const handlers = vi.hoisted(() => new Map<string, (payload: unknown) => void>())
const appQuit = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('./tray', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tray')>()
  return {
    ...actual,
    appQuit,
    syncTray: vi.fn(async () => {}),
    onTrayEvent: vi.fn(async (event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    })
  }
})
vi.mock('./host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./host')>()
  return { ...actual, getHostConfig: vi.fn(async () => ({ port: 4000, token: 'local-token' })) }
})
vi.mock('./environments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./environments')>()
  const entries: EnvironmentEntry[] = [
    { id: 'local', kind: 'local', slot: 0, port: 4000, token: 'local-token', state: 'ready' },
    { id: 'wsl:Ubuntu', kind: 'wsl', distro: 'Ubuntu', slot: 1, port: 5001, token: 'ubuntu-token', state: 'ready' }
  ]
  return { ...actual, listEnvironments: vi.fn(async () => entries) }
})

import { useTrayBridge } from './useTray'
import { TRAY_EVENT_STOP_DAEMON } from './tray'

afterEach(() => {
  vi.unstubAllGlobals()
  handlers.clear()
  appQuit.mockClear()
})

describe('useTray', () => {
  it("stops every environment's daemon", async () => {
    const calls: Array<{ url: string; auth: string; verb: string; quitAlready: boolean }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({
          url,
          auth: (init.headers as Record<string, string>).Authorization,
          verb: JSON.parse(init.body as string).verb,
          quitAlready: appQuit.mock.calls.length > 0
        })
        return new Response(JSON.stringify({ ok: true, stopped_sessions: 0, disarmed_routines: 0 }), { status: 200 })
      })
    )
    renderHook(() =>
      useTrayBridge({ connection: 'ready', sessions: new Map(), workspaces: [], onFocusPane: () => {} })
    )
    await waitFor(() => expect(handlers.has(TRAY_EVENT_STOP_DAEMON)).toBe(true))

    handlers.get(TRAY_EVENT_STOP_DAEMON)!(null)

    await waitFor(() => expect(appQuit).toHaveBeenCalledTimes(1))
    expect(calls.map(({ url, auth, verb }) => ({ url, auth, verb })).sort((a, b) => a.url.localeCompare(b.url))).toEqual([
      { url: 'http://127.0.0.1:4000/manage', auth: 'Bearer local-token', verb: 'daemon_shutdown' },
      { url: 'http://127.0.0.1:5001/manage', auth: 'Bearer ubuntu-token', verb: 'daemon_shutdown' }
    ])
    expect(calls.every((c) => !c.quitAlready)).toBe(true)
  })
})
