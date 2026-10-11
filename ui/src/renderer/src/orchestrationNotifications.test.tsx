// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useOrchestrationNotifications, type OrchestrationNotificationOptions } from './orchestrationNotifications'
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

  it('clears a child input notice on resolution and suppresses a historic user-owned snapshot', async () => {
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
    view.rerender(<Notifications options={configuration(withInputOwner(child, 'user', 'Historic prompt', 'historic-1'), 1)} />)
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
})
