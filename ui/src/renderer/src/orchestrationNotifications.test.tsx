// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useOrchestrationNotifications } from './orchestrationNotifications'
import type { SessionInfo } from './houston/client'
import { notifyNative } from './houston/bridge'
vi.mock('./houston/bridge', () => ({ notifyNative: vi.fn().mockRejectedValue(new Error('native_notify is only supported on Linux')) }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
function Notifications({ sessions }: { sessions: ReadonlyMap<number, SessionInfo> }): null { useOrchestrationNotifications(sessions); return null }
const parent = { id: 1, title: 'Orchestrator', spawned_by: null, state: 'running' } as SessionInfo
const child = (id: number, blocked: boolean): SessionInfo => ({ id, spawned_by: 1, state: 'running', status: blocked ? 'needs-input' : 'working' } as SessionInfo)
describe('orchestration notifications', () => {
  it('groups newly blocked children per orchestrator even when no roster is mounted', async () => {
    const view = render(<Notifications sessions={new Map([[1, parent], [2, child(2, false)], [3, child(3, false)]])} />)
    view.rerender(<Notifications sessions={new Map([[1, parent], [2, child(2, true)], [3, child(3, true)]])} />)
    expect(notifyNative).toHaveBeenCalledExactlyOnceWith('Orchestrator needs you', '2 children need input')
    view.rerender(<Notifications sessions={new Map([[1, parent], [2, child(2, true)], [3, child(3, true)]])} />)
    expect(notifyNative).toHaveBeenCalledTimes(1)
    await act(async () => { await Promise.resolve() })
  })
  it('notifies again when a child returns to working and later needs input', async () => {
    const view = render(<Notifications sessions={new Map([[1, parent], [2, child(2, true)]])} />)
    view.rerender(<Notifications sessions={new Map([[1, parent], [2, child(2, false)]])} />)
    view.rerender(<Notifications sessions={new Map([[1, parent], [2, child(2, true)]])} />)
    expect(notifyNative).toHaveBeenCalledTimes(2)
    await act(async () => { await Promise.resolve() })
  })
})
