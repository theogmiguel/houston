// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { daemonShutdown, daemonStatus, ManageError } from './manage'

vi.mock('./host', () => ({
  getHostConfig: vi.fn().mockResolvedValue({ port: 4242, token: 'tok-123' })
}))

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('houston/manage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('daemon_status posts the versioned verb and the bearer token, and returns the parsed reply', async () => {
    const status = {
      manage_version: 1,
      protocol_version: 92,
      build: 'abc1234',
      pid: 4321,
      started_at: '2026-09-05T07:00:00Z',
      live_sessions: { count: 3, ids: [1, 2, 3] },
      routines_enabled: 2,
      clients_connected: 1,
      handoff: { supported: false, reason: 'unsupported platform' },
      reap: { armed: false, deadline_ms: null }
    }
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(jsonResponse(status))

    const result = await daemonStatus()
    expect(result).toEqual(status)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:4242/manage')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok-123')
    expect(JSON.parse(init?.body as string)).toEqual({ manage_version: 1, verb: 'daemon_status' })
  })

  it('daemon_shutdown returns the stop counts on a 2xx reply', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, stopped_sessions: 3, disarmed_routines: 2 })
    )
    const result = await daemonShutdown()
    expect(result).toEqual({ ok: true, stopped_sessions: 3, disarmed_routines: 2 })
  })

  it('surfaces a non-2xx status as a ManageError naming the daemon HTTP code', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(jsonResponse({}, 401))
    await expect(daemonStatus()).rejects.toThrow(ManageError)
    await expect(daemonStatus()).rejects.toThrow(/401/)
  })

  it('surfaces an { error } reply verbatim even on a 2xx status', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'refused: 3 live SSH sessions' }))
    await expect(daemonShutdown()).rejects.toThrow('refused: 3 live SSH sessions')
  })

  it('wraps a network failure (fetch rejecting) as a ManageError naming what was attempted', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockRejectedValue(new TypeError('Load failed'))
    await expect(daemonStatus()).rejects.toThrow(ManageError)
    await expect(daemonStatus()).rejects.toThrow(
      "Could not reach the daemon's management endpoint at 127.0.0.1:4242/manage: Load failed"
    )
  })
})
