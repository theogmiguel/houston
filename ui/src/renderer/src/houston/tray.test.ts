// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { SessionInfo } from './generated/SessionInfo'
import {
  buildTrayPayload,
  createTraySync,
  orderForTray,
  trayStatusFor,
  updateTrayActivity,
  type TrayActivity
} from './tray'

function session(over: Partial<SessionInfo> & { id: number }): SessionInfo {
  return {
    agent: 'claude',
    project_dir: '/repo',
    cwd: '/repo',
    state: 'running',
    title: 'pane',
    hidden: false,
    live_children: 0,
    children_waiting: 0,
    ...over
  } as SessionInfo
}

describe('trayStatusFor', () => {
  it('reads the hook status of a running pane', () => {
    expect(trayStatusFor(session({ id: 1, status: 'working' }))).toBe('running')
    expect(trayStatusFor(session({ id: 1, status: 'spawning' }))).toBe('running')
    expect(trayStatusFor(session({ id: 1, status: 'idle' }))).toBe('idle')
    expect(trayStatusFor(session({ id: 1, status: 'needs-input' }))).toBe('needsInput')
  })

  it('treats a running pane with no hook signal as running, never idle', () => {
    expect(trayStatusFor(session({ id: 1, status: null }))).toBe('running')
  })

  it('separates a pane that finished from one the daemon restarted under', () => {
    expect(trayStatusFor(session({ id: 1, state: 'exited' }))).toBe('done')
    expect(trayStatusFor(session({ id: 1, state: 'killed' }))).toBe('done')
    expect(trayStatusFor(session({ id: 1, state: 'interrupted' }))).toBe('error')
  })

  it('ignores the hook status once the process is gone', () => {
    expect(trayStatusFor(session({ id: 1, state: 'exited', status: 'working' }))).toBe('done')
  })
})

describe('ordering', () => {
  it('stamps a new session and re-stamps only the ones whose status moved', () => {
    const first = updateTrayActivity(new Map(), [session({ id: 1, status: 'working' })], 100)
    expect(first.get(1)).toEqual({ status: 'running', at: 100 })

    const unchanged = updateTrayActivity(first, [session({ id: 1, status: 'working' })], 200)
    expect(unchanged.get(1)?.at).toBe(100)

    const moved = updateTrayActivity(first, [session({ id: 1, status: 'needs-input' })], 300)
    expect(moved.get(1)).toEqual({ status: 'needsInput', at: 300 })
  })

  it('drops sessions that left the roster so the map cannot grow forever', () => {
    const seen = updateTrayActivity(
      new Map(),
      [session({ id: 1 }), session({ id: 2 })],
      100
    )
    expect(updateTrayActivity(seen, [session({ id: 2 })], 200).has(1)).toBe(false)
  })

  it('puts the most recently active first and breaks ties by newest session', () => {
    const activity = new Map<number, TrayActivity>([
      [1, { status: 'running', at: 100 }],
      [2, { status: 'running', at: 300 }],
      [3, { status: 'running', at: 300 }]
    ])
    const ordered = orderForTray(
      [session({ id: 1 }), session({ id: 2 }), session({ id: 3 })],
      activity
    )
    expect(ordered.map((s) => s.id)).toEqual([3, 2, 1])
  })
})

const workspaceName = (projectDir: string): string => (projectDir === '/repo' ? 'repo' : projectDir)

describe('buildTrayPayload', () => {
  it('carries the connection and one row per session, ordered', () => {
    const activity = new Map<number, TrayActivity>([
      [1, { status: 'running', at: 100 }],
      [2, { status: 'needsInput', at: 500 }]
    ])
    const payload = buildTrayPayload(
      'ready',
      [session({ id: 1, status: 'working' }), session({ id: 2, status: 'needs-input' })],
      activity,
      workspaceName
    )
    expect(payload).toEqual({
      connection: 'ready',
      sessions: [
        {
          id: 2,
          agent: 'claude',
          title: 'pane',
          status: 'needsInput',
          needsInput: true,
          workspace: 'repo'
        },
        {
          id: 1,
          agent: 'claude',
          title: 'pane',
          status: 'running',
          needsInput: false,
          workspace: 'repo'
        }
      ]
    })
  })

  it('names the agent the pane actually announced, not the one it launched as', () => {
    const payload = buildTrayPayload(
      'ready',
      [session({ id: 1, agent: 'shell', detected_agent: 'codex' })],
      new Map(),
      workspaceName
    )
    expect(payload.sessions[0].agent).toBe('codex')
  })

  it('names the workspace the way the caller resolves it, not the raw project_dir', () => {
    const payload = buildTrayPayload(
      'ready',
      [session({ id: 1, project_dir: '/tmp/other-repo', cwd: '/tmp/other-repo' })],
      new Map(),
      (dir) => (dir === '/tmp/other-repo' ? 'other-repo' : dir)
    )
    expect(payload.sessions[0].workspace).toBe('other-repo')
  })
})

describe('createTraySync', () => {
  function harness(): {
    sent: Array<string>
    sync: ReturnType<typeof createTraySync>
    advance: (ms: number) => void
  } {
    let clock = 1000
    const timers: Array<{ at: number; fn: () => void; handle: number }> = []
    let nextHandle = 1
    const sent: string[] = []
    const sync = createTraySync((payload) => sent.push(payload.connection), {
      minIntervalMs: 250,
      now: () => clock,
      setTimer: (fn, ms) => {
        const handle = nextHandle++
        timers.push({ at: clock + ms, fn, handle })
        return handle
      },
      clearTimer: (handle) => {
        const i = timers.findIndex((t) => t.handle === handle)
        if (i >= 0) timers.splice(i, 1)
      }
    })
    const advance = (ms: number): void => {
      clock += ms
      for (const timer of timers.splice(0, timers.length)) {
        if (timer.at <= clock) timer.fn()
        else timers.push(timer)
      }
    }
    return { sent, sync, advance }
  }

  const payload = (connection: 'ready' | 'failed' | 'connecting'): Parameters<
    ReturnType<typeof createTraySync>['sync']
  >[0] => ({ connection, sessions: [] })

  it('sends the first payload immediately', () => {
    const { sent, sync } = harness()
    sync.sync(payload('ready'))
    expect(sent).toEqual(['ready'])
  })

  it('collapses a burst into one trailing send carrying the newest payload', () => {
    const { sent, sync, advance } = harness()
    sync.sync(payload('ready'))
    sync.sync(payload('connecting'))
    sync.sync(payload('failed'))
    expect(sent).toEqual(['ready'])
    advance(250)
    expect(sent).toEqual(['ready', 'failed'])
  })

  it('sends immediately again once the window has passed with nothing pending', () => {
    const { sent, sync, advance } = harness()
    sync.sync(payload('ready'))
    advance(300)
    sync.sync(payload('failed'))
    expect(sent).toEqual(['ready', 'failed'])
  })

  it('dispose cancels a pending trailing send', () => {
    const { sent, sync, advance } = harness()
    sync.sync(payload('ready'))
    sync.sync(payload('failed'))
    sync.dispose()
    advance(1000)
    expect(sent).toEqual(['ready'])
  })

  it('never sends more than once per interval under a sustained storm', () => {
    const { sent, sync, advance } = harness()
    for (let tick = 0; tick < 100; tick++) {
      sync.sync(payload('ready'))
      advance(10)
    }
    expect(sent.length).toBeLessThanOrEqual(5)
    expect(sent.length).toBeGreaterThan(0)
  })
})

describe('the host bridge', () => {
  it('is inert outside Tauri so the Electron shell needs no tray branch', async () => {
    const win = window as unknown as { __TAURI_INTERNALS__?: unknown }
    delete win.__TAURI_INTERNALS__
    const { appQuit, syncTray, trayState, setKeepInTray, onTrayEvent } = await import('./tray')
    await expect(syncTray({ connection: 'ready', sessions: [] })).resolves.toBeUndefined()
    await expect(trayState()).resolves.toBeNull()
    await expect(setKeepInTray(true)).resolves.toBeNull()
    await expect(appQuit()).resolves.toBeUndefined()
    const off = await onTrayEvent('tray://focus-pane', vi.fn())
    expect(() => off()).not.toThrow()
  })
})
