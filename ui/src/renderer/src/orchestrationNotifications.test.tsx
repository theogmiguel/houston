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
  it('does not notify for blocked children or rolled-up child counts', async () => {
    const view = render(<Notifications sessions={new Map([[1, parent], [2, child(2, false)]])} />)
    view.rerender(<Notifications sessions={new Map([[1, { ...parent, children_waiting: 1 }], [2, child(2, true)]])} />)
    expect(notifyNative).not.toHaveBeenCalled()
    await act(async () => { await Promise.resolve() })
  })
  it('notifies when a top-level pane itself needs input, once per transition', async () => {
    const blocked = { ...parent, status: 'needs-input' as const }
    const view = render(<Notifications sessions={new Map([[1, parent]])} />)
    view.rerender(<Notifications sessions={new Map([[1, blocked]])} />)
    view.rerender(<Notifications sessions={new Map([[1, blocked]])} />)
    expect(notifyNative).toHaveBeenCalledExactlyOnceWith('Orchestrator needs you', 'Waiting for your input')
    view.rerender(<Notifications sessions={new Map([[1, parent]])} />)
    view.rerender(<Notifications sessions={new Map([[1, blocked]])} />)
    expect(notifyNative).toHaveBeenCalledTimes(2)
    await act(async () => { await Promise.resolve() })
  })
})
