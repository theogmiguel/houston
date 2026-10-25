// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NOTIFICATION_FLAP_WINDOW_MS,
  SOUND_BURST_WINDOW_MS,
  claimSoundSlot,
  useOrchestrationNotifications,
  type EventKind,
  type OrchestrationNotificationOptions
} from './orchestrationNotifications'
import type { SessionInfo } from './houston/client'
import { isFocused, notifyNative } from './houston/bridge'
import type { NoticeInput } from './notices'
import { withInputOwner, withPermissionOwner } from './test/inputFixtures'

vi.mock('./houston/bridge', () => ({
  isFocused: vi.fn().mockResolvedValue(false),
  notifyNative: vi.fn().mockResolvedValue(undefined)
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

const pane = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  id: 1,
  title: 'Orchestrator',
  agent: 'claude',
  detected_agent: null,
  project_dir: '/work/project_eagle',
  spawned_by: null,
  hidden: false,
  state: 'running',
  status: 'working',
  status_since_ms: 0,
  live_children: 0,
  children_waiting: 0,
  inbox_unread: 0,
  tags: [],
  cwd: '/work/project_eagle',
  codename: 'eagle-api',
  ...overrides
} as SessionInfo)

const pushNotice = vi.fn<(notice: NoticeInput) => void>()
const focusPane = vi.fn()
const delivery = vi.fn()

function Notifications({ options }: { options: OrchestrationNotificationOptions }): null {
  useOrchestrationNotifications(options)
  return null
}

function options(sessions: ReadonlyMap<number, SessionInfo>, overrides: Partial<OrchestrationNotificationOptions> = {}): OrchestrationNotificationOptions {
  return {
    sessions,
    rosterRevision: 0,
    desktopMode: 'notifications',
    inAppEnabled: false,
    visiblePaneIds: new Set([1]),
    getContext: () => ({ agent: 'Claude Code', workspace: 'project_eagle', grid: 'Main' }),
    onFocusPane: focusPane,
    pushNotice,
    onDesktopDelivery: delivery,
    ...overrides
  }
}

describe('orchestration notifications', () => {
  beforeEach(() => vi.mocked(isFocused).mockResolvedValue(false))

  it('alerts once when child ownership changes without a raw status change and keeps replays silent', async () => {
    const parent = pane()
    const child = pane({ id: 2, spawned_by: 1, title: 'Child', status: 'needs-input' })
    const sessions = (worker: SessionInfo) => new Map([[1, parent], [2, worker]])
    const asked = withInputOwner(child, 'orchestrator', 'Choose a branch')
    const escalated = withInputOwner(child, 'user', 'Choose a branch')
    const view = render(<Notifications options={options(sessions(asked))} />)
    view.rerender(<Notifications options={options(sessions(child))} />)
    await act(async () => { await Promise.resolve() })
    expect(notifyNative).not.toHaveBeenCalled()
    view.rerender(<Notifications options={options(sessions(escalated))} />)
    view.rerender(<Notifications options={options(sessions(escalated))} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(notifyNative).toHaveBeenCalledExactlyOnceWith('Child needs your input', 'Claude Code · project_eagle · Choose a branch', 2)
    view.rerender(<Notifications options={options(sessions(escalated), { rosterRevision: 1 })} />)
    view.rerender(<Notifications options={options(sessions(asked), { rosterRevision: 1 })} />)
    view.rerender(<Notifications options={options(sessions(escalated), { rosterRevision: 1 })} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(notifyNative).toHaveBeenCalledTimes(1)
  })

  it('clears a child input notice on resolution and keeps an already-delivered episode silent across a reconciliation', async () => {
    vi.mocked(isFocused).mockResolvedValue(true)
    const dismissNotice = vi.fn()
    const child = pane({ id: 2, spawned_by: 1, title: 'Child' })
    const configuration = (worker: SessionInfo, rosterRevision = 0) => options(new Map([[2, worker]]), { inAppEnabled: true, dismissNotice, rosterRevision })
    const view = render(<Notifications options={configuration(child)} />)
    view.rerender(<Notifications options={configuration(withInputOwner(child, 'user', 'Allow the command?'))} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(pushNotice).toHaveBeenCalledTimes(1)
    view.rerender(<Notifications options={configuration(child)} />)
    expect(dismissNotice).toHaveBeenCalledWith('orchestration-2')
    // A roster that replays the episode the live path already delivered must not re-notify.
    view.rerender(<Notifications options={configuration(withInputOwner(child, 'user', 'Allow the command?'), 1)} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(pushNotice).toHaveBeenCalledTimes(1)
  })

  it('keeps permission episodes silent until ownership moves to the operator and honours in-app settings', async () => {
    vi.mocked(isFocused).mockResolvedValue(true)
    const worker = pane({ id: 2, spawned_by: 1, title: 'Child' })
    const configuration = (session: SessionInfo, enabled = true) => options(new Map([[2, session]]), { inAppEnabled: enabled })
    const view = render(<Notifications options={configuration(worker)} />)
    view.rerender(<Notifications options={configuration(withPermissionOwner(worker, 'orchestrator'))} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(pushNotice).not.toHaveBeenCalled()
    expect(notifyNative).not.toHaveBeenCalled()
    view.rerender(<Notifications options={configuration(withPermissionOwner(worker, 'user'))} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(pushNotice).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'warning', title: 'Child needs your input', durationMs: null }))
    expect(notifyNative).not.toHaveBeenCalled()
    view.rerender(<Notifications options={configuration(worker, false)} />)
    view.rerender(<Notifications options={configuration(withInputOwner(worker, 'user', 'Another request', 'permission-2'), false)} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(pushNotice).toHaveBeenCalledTimes(1)
  })

  it('keeps the first snapshot and replacement roster silent', async () => {
    const blocked = pane({ status: 'needs-input' })
    const view = render(<Notifications options={options(new Map([[1, blocked]]))} />)
    view.rerender(<Notifications options={options(new Map([[1, pane({ status: 'needs-input' })]]), { rosterRevision: 1 })} />)
    expect(notifyNative).not.toHaveBeenCalled()
    await act(async () => { await Promise.resolve() })
  })

  it('notifies once for needs-input and finished transitions restored by a reconnect, and a second reconciliation replays nothing', async () => {
    const connected = (): ReadonlyMap<number, SessionInfo> => new Map([
      [1, pane()],
      [2, pane({ id: 2, title: 'Other pane' })],
    ])
    const view = render(<Notifications options={options(connected())} />)
    // Nothing reaches a disconnected renderer; the reconnect snapshot then carries
    // both transitions the live path never saw.
    const restored = (): ReadonlyMap<number, SessionInfo> => new Map([
      [1, pane({ status: 'needs-input' })],
      [2, pane({ id: 2, title: 'Other pane', status: 'idle' })],
    ])
    view.rerender(<Notifications options={options(restored(), { rosterRevision: 1 })} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(notifyNative).toHaveBeenCalledWith('Orchestrator needs your input', 'Claude Code · project_eagle', 1)
    expect(notifyNative).toHaveBeenCalledWith('Other pane finished', 'Claude Code · project_eagle', 2)
    expect(notifyNative).toHaveBeenCalledTimes(2)
    view.rerender(<Notifications options={options(restored(), { rosterRevision: 2 })} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(notifyNative).toHaveBeenCalledTimes(2)
  })

  it('keeps a pane already waiting for input silent when a handoff re-stamps its status time', async () => {
    vi.useFakeTimers()
    const view = render(<Notifications options={options(new Map([[1, pane()]]))} />)
    view.rerender(<Notifications options={options(new Map([[1, pane({ status: 'needs-input', status_since_ms: 100 })]]))} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(notifyNative).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(NOTIFICATION_FLAP_WINDOW_MS + 1)
    // The adopting daemon reports the same wait with its own adoption time.
    view.rerender(<Notifications options={options(new Map([[1, pane({ status: 'needs-input', status_since_ms: 900 })]]), { rosterRevision: 1 })} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(notifyNative).toHaveBeenCalledTimes(1)
  })

  it('catches up a child input request restored by a reconnect and keeps an owner replay on the same episode silent', async () => {
    const child = pane({ id: 2, spawned_by: 1, title: 'Child' })
    const sessions = (worker: SessionInfo): ReadonlyMap<number, SessionInfo> => new Map([[1, pane()], [2, worker]])
    const view = render(<Notifications options={options(sessions(child))} />)
    view.rerender(<Notifications options={options(sessions(withInputOwner(child, 'user', 'Choose a branch')), { rosterRevision: 1 })} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(notifyNative).toHaveBeenCalledExactlyOnceWith('Child needs your input', 'Claude Code · project_eagle · Choose a branch', 2)
    view.rerender(<Notifications options={options(sessions(withInputOwner(child, 'orchestrator', 'Choose a branch')), { rosterRevision: 1 })} />)
    view.rerender(<Notifications options={options(sessions(withInputOwner(child, 'user', 'Choose a branch')), { rosterRevision: 1 })} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(notifyNative).toHaveBeenCalledTimes(1)
  })

  it('fires one desktop notification for an unfocused top-level status transition', async () => {
    const view = render(<Notifications options={options(new Map([[1, pane()]]))} />)
    const waiting = pane({ status: 'needs-input' })
    view.rerender(<Notifications options={options(new Map([[1, waiting]]))} />)
    view.rerender(<Notifications options={options(new Map([[1, waiting]]))} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(notifyNative).toHaveBeenCalledExactlyOnceWith('Orchestrator needs your input', 'Claude Code · project_eagle', 1)
  })

  it('shows an in-app notice only for an off-screen pane while focused', async () => {
    vi.mocked(isFocused).mockResolvedValue(true)
    const onScreen = pane()
    const offScreen = pane({ id: 2, title: 'Other pane' })
    const view = render(<Notifications options={options(new Map([[1, onScreen], [2, offScreen]]), { inAppEnabled: true })} />)
    await act(async () => {
      view.rerender(<Notifications options={options(new Map([[1, pane({ status: 'idle' })], [2, pane({ ...offScreen, status: 'idle' })]]), { inAppEnabled: true })} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(pushNotice).toHaveBeenCalledTimes(1)
    expect(pushNotice).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Other pane finished',
      body: 'Claude Code · project_eagle › Main',
      durationMs: 5_000,
      presentation: 'orchestration'
    }))
    expect(notifyNative).not.toHaveBeenCalled()
  })

  it('excludes children and stays silent when desktop notifications are off', async () => {
    const parent = pane()
    const child = pane({ id: 2, title: 'Child', spawned_by: 1, status: 'working' })
    const view = render(<Notifications options={options(new Map([[1, parent], [2, child]]), { desktopMode: 'off' })} />)
    view.rerender(<Notifications options={options(new Map([[1, parent], [2, pane({ ...child, status: 'needs-input' })]]), { desktopMode: 'off' })} />)
    view.rerender(<Notifications options={options(new Map([[1, pane({ status: 'needs-input' })], [2, pane({ ...child, status: 'needs-input' })]]), { desktopMode: 'off' })} />)
    await act(async () => { await Promise.resolve() })
    expect(notifyNative).not.toHaveBeenCalled()
    expect(pushNotice).not.toHaveBeenCalled()
  })

  it('coalesces status flaps within the two-second window', async () => {
    vi.useFakeTimers()
    const view = render(<Notifications options={options(new Map([[1, pane()]]))} />)
    view.rerender(<Notifications options={options(new Map([[1, pane({ status: 'idle' })]]))} />)
    view.rerender(<Notifications options={options(new Map([[1, pane({ status: 'working' })]]))} />)
    vi.advanceTimersByTime(1_999)
    view.rerender(<Notifications options={options(new Map([[1, pane({ status: 'idle' })]]))} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(notifyNative).toHaveBeenCalledTimes(1)
  })

  it('plays a sound without an OS notification in Sound only mode', async () => {
    const play = vi.fn().mockResolvedValue(undefined)
    class FakeAudio { play = play }
    vi.stubGlobal('Audio', FakeAudio)
    const view = render(<Notifications options={options(new Map([[1, pane()]]), { desktopMode: 'sound' })} />)
    await act(async () => {
      view.rerender(<Notifications options={options(new Map([[1, pane({ status: 'needs-input' })]]), { desktopMode: 'sound' })} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(play).toHaveBeenCalledOnce()
    expect(notifyNative).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('plays one sound for a burst of finishes and still sounds a child input request', async () => {
    vi.useFakeTimers()
    const play = vi.fn().mockResolvedValue(undefined)
    class FakeAudio { play = play }
    vi.stubGlobal('Audio', FakeAudio)
    const child = pane({ id: 3, spawned_by: 1, title: 'Child' })
    const sessions = (first: SessionInfo, second: SessionInfo, worker: SessionInfo) =>
      options(new Map([[1, first], [2, second], [3, worker]]), { desktopMode: 'sound' })
    const idleSecond = () => pane({ id: 2, title: 'Second', status: 'idle' })
    const view = render(<Notifications options={sessions(pane(), pane({ id: 2, title: 'Second' }), child)} />)
    view.rerender(<Notifications options={sessions(pane({ status: 'idle' }), idleSecond(), child)} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(play).toHaveBeenCalledOnce()
    view.rerender(<Notifications options={sessions(pane({ status: 'idle' }), idleSecond(), withInputOwner(child, 'user', 'Approve the push?'))} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(play).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(NOTIFICATION_FLAP_WINDOW_MS + 1)
    view.rerender(<Notifications options={sessions(pane({ status: 'working' }), idleSecond(), child)} />)
    view.rerender(<Notifications options={sessions(pane({ status: 'idle' }), idleSecond(), child)} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(play).toHaveBeenCalledTimes(3)
    expect(notifyNative).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('sound burst gate', () => {
  it('grants one slot for a burst of same-kind events', () => {
    const slots = new Map<EventKind, number>()
    const first = claimSoundSlot(slots, 'finished', 1_000)
    expect(first).toEqual({ granted: true, busyUntil: 1_000 + SOUND_BURST_WINDOW_MS })
    slots.set('finished', first.busyUntil)
    expect(claimSoundSlot(slots, 'finished', 1_400).granted).toBe(false)
    expect(claimSoundSlot(slots, 'finished', 1_999).granted).toBe(false)
  })

  it('keeps the needs-input slot open while a finished burst is sounding', () => {
    const slots = new Map<EventKind, number>([['finished', 2_000]])
    expect(claimSoundSlot(slots, 'needs-input', 1_500).granted).toBe(true)
  })

  it('grants a new finished sound once the burst window has passed', () => {
    const slots = new Map<EventKind, number>([['finished', 2_000]])
    expect(claimSoundSlot(slots, 'finished', 2_000)).toEqual({ granted: true, busyUntil: 2_000 + SOUND_BURST_WINDOW_MS })
  })
})
