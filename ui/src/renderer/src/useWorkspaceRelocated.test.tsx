// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Conn } from './App'
import type { HoustonClient } from './houston/client'
import type { RelocateState } from './workspaceRelocate'
import { useWorkspaceRelocated } from './useWorkspaceRelocated'

afterEach(cleanup)

function Harness({ conn, pushNotice }: { conn: Conn; pushNotice: (n: unknown) => void }): null {
  useWorkspaceRelocated(conn, { current: null as RelocateState | null }, pushNotice)
  return null
}

describe('useWorkspaceRelocated', () => {
  it('names the new path once the daemon reports a relocation, and only while connected', async () => {
    const handlers = new Map<string, (msg: unknown) => void>()
    const client = {
      subscribe: (type: string, fn: (msg: unknown) => void) => {
        handlers.set(type, fn)
        return () => handlers.delete(type)
      }
    } as unknown as HoustonClient
    const pushNotice = vi.fn()
    const view = render(<Harness conn={{ kind: 'connecting' }} pushNotice={pushNotice} />)
    expect(handlers.has('workspace_relocated')).toBe(false)

    view.rerender(<Harness conn={{ kind: 'ready', client }} pushNotice={pushNotice} />)
    await act(async () => {
      handlers.get('workspace_relocated')!({
        type: 'workspace_relocated',
        from: '/a/p',
        to: '/b/p',
        moved: { worktrees: 0, sessions: 1, repaired: 0, notes: [] }
      })
      await vi.dynamicImportSettled()
    })
    expect(pushNotice).toHaveBeenCalledWith(expect.objectContaining({ title: 'Workspace now at /b/p' }))
    view.unmount()
    expect(handlers.has('workspace_relocated')).toBe(false)
  })
})
