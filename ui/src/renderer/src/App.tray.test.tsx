// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AppHarness,
  deliverHelloOk,
  makeSession,
  makeWorkspace,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'
import { TRAY_SYNC_MIN_INTERVAL_MS, type TraySyncPayload } from './houston/tray'

const { syncTrayMock, onTrayEventMock, appQuitMock, listeners } = vi.hoisted(() => {
  const listeners = new Map<string, (payload: never) => void>()
  return {
    listeners,
    syncTrayMock: vi.fn(async (_payload: unknown) => {}),
    appQuitMock: vi.fn(async () => {}),
    onTrayEventMock: vi.fn(async (event: string, handler: (payload: never) => void) => {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    })
  }
})

vi.mock('./houston/tray', async () => {
  const actual = await vi.importActual<typeof import('./houston/tray')>('./houston/tray')
  return {
    ...actual,
    syncTray: syncTrayMock,
    onTrayEvent: onTrayEventMock,
    appQuit: appQuitMock
  }
})

const { daemonShutdownMock } = vi.hoisted(() => ({ daemonShutdownMock: vi.fn() }))
vi.mock('./houston/manage', async () => {
  const actual = await vi.importActual<typeof import('./houston/manage')>('./houston/manage')
  return { ...actual, daemonShutdown: daemonShutdownMock }
})

const HERE = '/tmp/project'
const ELSEWHERE = '/tmp/other-repo'

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function flushTray(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, TRAY_SYNC_MIN_INTERVAL_MS + 60))
  })
}

function selectedWorkspaceName(harness: AppHarness): string | null {
  const btn = Array.from(harness.container.querySelectorAll('.witem[role="button"]')).find(
    (b) => b.getAttribute('aria-current') === 'true'
  )
  return btn ? (btn.textContent ?? '').trim() : null
}

function lastPayload(): TraySyncPayload {
  const call = syncTrayMock.mock.calls.at(-1)
  if (!call) throw new Error('tray_sync was never called')
  return call[0] as unknown as TraySyncPayload
}

describe('the tray is fed by this window', () => {
  let harness: AppHarness | null = null

  beforeEach(() => {
    resetHarness()
    localStorage.clear()
    listeners.clear()
    syncTrayMock.mockClear()
    onTrayEventMock.mockClear()
    appQuitMock.mockClear()
    daemonShutdownMock.mockReset()
  })

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('syncs the connection and the roster once the daemon says hello', async () => {
    harness = await renderReadyApp()
    await flushTray()
    const payload = lastPayload()
    expect(payload.connection).toBe('ready')
    expect(payload.sessions).toEqual([
      {
        id: 1,
        agent: 'shell',
        title: 'session-1',
        status: 'running',
        needsInput: false,
        workspace: 'project'
      }
    ])
  })

  it("carries the rail label for the pane's workspace, not its raw path", async () => {
    harness = await renderReadyApp()
    deliverHelloOk({
      sessions: [makeSession({ id: 1, project_dir: HERE, cwd: HERE })],
      workspaces: [makeWorkspace({ path: HERE, name: 'Renamed project' })]
    })
    await flushTray()
    expect(lastPayload().sessions[0].workspace).toBe('Renamed project')
  })

  it('raises the attention flag when a pane goes needs-input', async () => {
    harness = await renderReadyApp()
    deliverHelloOk({
      sessions: [makeSession({ id: 1, status: 'needs-input' })],
      workspaces: [makeWorkspace()]
    })
    await flushTray()
    expect(lastPayload().sessions[0]).toMatchObject({
      status: 'needsInput',
      needsInput: true
    })
  })

  it('opens the workspace a tray-clicked pane lives in, not just the pane', async () => {
    harness = await renderReadyApp()
    deliverHelloOk({
      sessions: [
        makeSession({ id: 1, project_dir: HERE, cwd: HERE }),
        makeSession({ id: 2, project_dir: ELSEWHERE, cwd: ELSEWHERE, title: 'session-2' })
      ],
      workspaces: [
        makeWorkspace({ path: HERE, name: 'project' }),
        makeWorkspace({ path: ELSEWHERE, name: 'other-repo' })
      ]
    })
    await flush()
    expect(selectedWorkspaceName(harness)).toBe('project')

    const focus = listeners.get('tray://focus-pane')
    if (!focus) throw new Error('App never subscribed to tray://focus-pane')
    await act(async () => {
      ;(focus as (session: number) => void)(2)
      await Promise.resolve()
    })
    expect(selectedWorkspaceName(harness)).toBe('other-repo')
  })

  it('ignores a tray click for a session the roster no longer has', async () => {
    harness = await renderReadyApp()
    await flush()
    const focus = listeners.get('tray://focus-pane')
    if (!focus) throw new Error('App never subscribed to tray://focus-pane')
    expect(() => (focus as (session: number) => void)(4242)).not.toThrow()
  })

  it('stops the daemon through the same client Settings uses, then quits', async () => {
    daemonShutdownMock.mockResolvedValue({ ok: true, stopped_sessions: 1, disarmed_routines: 0 })
    harness = await renderReadyApp()
    await flush()
    const stop = listeners.get('tray://stop-daemon')
    if (!stop) throw new Error('App never subscribed to tray://stop-daemon')
    await act(async () => {
      ;(stop as (payload: null) => void)(null)
      await Promise.resolve()
      await Promise.resolve()
    })
    await flush()
    expect(daemonShutdownMock).toHaveBeenCalledTimes(1)
    expect(appQuitMock).toHaveBeenCalledTimes(1)
  })

  it('still quits when the stop fails, exactly as the in-app quit does', async () => {
    daemonShutdownMock.mockRejectedValue(new Error('daemon did not answer'))
    harness = await renderReadyApp()
    await flush()
    const stop = listeners.get('tray://stop-daemon')
    if (!stop) throw new Error('App never subscribed to tray://stop-daemon')
    await act(async () => {
      ;(stop as (payload: null) => void)(null)
      await Promise.resolve()
      await Promise.resolve()
    })
    await flush()
    expect(appQuitMock).toHaveBeenCalledTimes(1)
  })
})
