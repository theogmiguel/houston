// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AppHarness,
  deliverHelloOk,
  deliverControl,
  makeSession,
  makeWorkspace,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'
import { NOTIFICATION_EVENT_FOCUS_PANE, TRAY_SYNC_MIN_INTERVAL_MS, type TraySyncPayload } from './houston/tray'

const { syncTrayMock, onTrayEventMock, listeners } = vi.hoisted(() => {
  const listeners = new Map<string, (payload: never) => void>()
  return {
    listeners,
    syncTrayMock: vi.fn(async (_payload: unknown) => {}),
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
    onTrayEvent: onTrayEventMock
  }
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

  it('updates the tray payload after a pure status event without a replacement roster', async () => {
    harness = await renderReadyApp({ sessions: [makeSession({ id: 1, status: 'working' })] })
    await flushTray()
    expect(lastPayload().sessions[0].status).toBe('running')
    deliverControl({ type: 'agent_status', session: 1, status: 'needs-input' })
    await flushTray()
    expect(lastPayload().sessions[0]).toMatchObject({ status: 'needsInput', needsInput: true })
    deliverControl({ type: 'agent_status', session: 1, status: 'idle' })
    await flushTray()
    expect(lastPayload().sessions[0]).toMatchObject({ status: 'idle', needsInput: false })
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

  it('opens the workspace a desktop-notification click targets', async () => {
    harness = await renderReadyApp({
      sessions: [makeSession({ id: 1, project_dir: HERE, cwd: HERE }), makeSession({ id: 2, project_dir: ELSEWHERE, cwd: ELSEWHERE, title: 'session-2' })],
      workspaces: [makeWorkspace({ path: HERE, name: 'project' }), makeWorkspace({ path: ELSEWHERE, name: 'other-repo' })]
    })
    await flush()
    const focus = listeners.get(NOTIFICATION_EVENT_FOCUS_PANE)
    if (!focus) throw new Error(`App never subscribed to ${NOTIFICATION_EVENT_FOCUS_PANE}`)
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

  it('does not depend on a renderer listener to quit from the native tray', async () => {
    harness = await renderReadyApp()
    await flush()
    expect(listeners.has('tray://stop-daemon')).toBe(false)
  })
})
