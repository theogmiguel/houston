import { describe, expect, it, vi } from 'vitest'
import {
  detachPaneToNewWorkspace,
  isDetachable,
  isWorkspaceEmptyOfSessionsAndSwarms,
  resolveDetachRoot,
  type DetachOps,
  type DetachPayload
} from './paneDetach'

const terminalPayload: DetachPayload = {
  paneId: 1,
  sourceWorkspaceId: '/tmp/source',
  paneType: 'terminal',
  sessionId: 1
}

function fakeOps(overrides: Partial<DetachOps> = {}): DetachOps {
  return {
    resolveRoot: vi.fn().mockResolvedValue('/tmp/target'),
    addWorkspace: vi.fn(),
    reparentSession: vi.fn().mockResolvedValue(undefined),
    removePaneFromSource: vi.fn(),
    isSourceEmptyAfterDetach: vi.fn().mockReturnValue(true),
    removeSourceWorkspace: vi.fn(),
    selectWorkspace: vi.fn(),
    ...overrides
  }
}

describe('isDetachable', () => {
  it('excludes editor (no root of its own in this tree — see paneDetach.ts)', () => {
    expect(isDetachable('editor')).toBe(false)
  })
  it('excludes browser (no cwd to detach with)', () => {
    expect(isDetachable('browser')).toBe(false)
  })
  it('includes only terminal', () => {
    expect(isDetachable('terminal')).toBe(true)
  })
})

describe('resolveDetachRoot', () => {
  it('resolves to the session live cwd', async () => {
    const liveCwd = vi.fn().mockResolvedValue('/live/cwd')
    await expect(resolveDetachRoot(terminalPayload, liveCwd)).resolves.toBe('/live/cwd')
    expect(liveCwd).toHaveBeenCalledWith(1)
  })

  it('falls back to the source workspace when the cwd query rejects (dead session, timeout)', async () => {
    const liveCwd = vi.fn().mockRejectedValue(new Error('session_cwd timed out'))
    await expect(resolveDetachRoot(terminalPayload, liveCwd)).resolves.toBe('/tmp/source')
  })
})

describe('isWorkspaceEmptyOfSessionsAndSwarms (the 4-arm step-5 guard)', () => {
  it('true when no sessions, no swarms, and no panes remain', () => {
    expect(isWorkspaceEmptyOfSessionsAndSwarms('/tmp/source', null, [], [], 0)).toBe(true)
  })

  it('arm 1: false with a LIVE session still in the workspace', () => {
    const sessions = [{ id: 5, project_dir: '/tmp/source' }]
    expect(isWorkspaceEmptyOfSessionsAndSwarms('/tmp/source', null, sessions, [], 0)).toBe(false)
  })

  it('arm 2: false with a DEAD HUSK still in the workspace (state carries no bearing — only project_dir matters)', () => {
    const husk = [{ id: 9, project_dir: '/tmp/source' }]
    expect(isWorkspaceEmptyOfSessionsAndSwarms('/tmp/source', null, husk, [], 0)).toBe(false)
  })

  it('arm 3: a workspace with ZERO panes and one husk-only swarm survives the detach — the pane moves, the workspace stays', () => {
    const noSessions: Array<{ id: number; project_dir: string }> = []
    const husklessSwarm = [{ root_dir: '/tmp/source' }]
    expect(
      isWorkspaceEmptyOfSessionsAndSwarms('/tmp/source', null, noSessions, husklessSwarm, 0)
    ).toBe(false)
  })

  it('arm 4: a workspace with zero sessions, zero swarms, but ONE remaining pane (e.g. an editor with unsaved edits) is NOT deleted', () => {
    expect(isWorkspaceEmptyOfSessionsAndSwarms('/tmp/source', null, [], [], 1)).toBe(false)
  })

  it('excludes the session being moved — its project_dir has not caught up to the reparent yet', () => {
    const sessions = [{ id: 1, project_dir: '/tmp/source' }]
    expect(isWorkspaceEmptyOfSessionsAndSwarms('/tmp/source', 1, sessions, [], 0)).toBe(true)
  })

  it('a different workspace path is untouched by any arm', () => {
    const sessions = [{ id: 5, project_dir: '/tmp/other' }]
    const swarms = [{ root_dir: '/tmp/other' }]
    expect(isWorkspaceEmptyOfSessionsAndSwarms('/tmp/source', null, sessions, swarms, 0)).toBe(
      true
    )
  })
})

describe('detachPaneToNewWorkspace: step ordering', () => {
  it('CONFIRMS the reparent (awaits it) BEFORE addWorkspace and removePaneFromSource run (fix round F1: verified `Daemon::reparent_session` requires only `is_dir()`, not a registered workspace — see paneDetach.ts)', async () => {
    const calls: string[] = []
    const ops = fakeOps({
      reparentSession: vi.fn(async () => {
        calls.push('reparentSession')
      }),
      addWorkspace: vi.fn(() => calls.push('addWorkspace')),
      removePaneFromSource: vi.fn(() => calls.push('removePaneFromSource'))
    })
    await detachPaneToNewWorkspace(terminalPayload, ops)
    expect(calls).toEqual(['reparentSession', 'addWorkspace', 'removePaneFromSource'])
  })

  it('deletes the source workspace only when it targets a different root AND is empty, then selects the new workspace', async () => {
    const ops = fakeOps({ isSourceEmptyAfterDetach: vi.fn().mockReturnValue(true) })
    await detachPaneToNewWorkspace(terminalPayload, ops)
    expect(ops.removeSourceWorkspace).toHaveBeenCalledTimes(1)
    expect(ops.selectWorkspace).toHaveBeenCalledWith('/tmp/target')
  })

  it('does NOT delete the source workspace when isSourceEmptyAfterDetach is false, but still selects the new one', async () => {
    const ops = fakeOps({ isSourceEmptyAfterDetach: vi.fn().mockReturnValue(false) })
    await detachPaneToNewWorkspace(terminalPayload, ops)
    expect(ops.removeSourceWorkspace).not.toHaveBeenCalled()
    expect(ops.selectWorkspace).toHaveBeenCalledWith('/tmp/target')
  })

  it('does NOT delete the source workspace when the resolved root falls back to the source itself (nothing actually moved), even if "empty"', async () => {
    const ops = fakeOps({
      resolveRoot: vi.fn().mockResolvedValue('/tmp/source'),
      isSourceEmptyAfterDetach: vi.fn().mockReturnValue(true)
    })
    await detachPaneToNewWorkspace(terminalPayload, ops)
    expect(ops.removeSourceWorkspace).not.toHaveBeenCalled()
    expect(ops.selectWorkspace).toHaveBeenCalledWith('/tmp/source')
  })
})

describe('detachPaneToNewWorkspace: F1 — a daemon refusal (or a confirmation timeout) can never reach step 5', () => {
  it('reparentSession rejecting (the refusal/timeout path — see confirmReparentSession) aborts before addWorkspace, removePaneFromSource, or removeSourceWorkspace run, and the pane stays where it is', async () => {
    const onError = vi.fn()
    const ops = fakeOps({
      reparentSession: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'session_reparent confirmation timed out after 2000ms for session 1 -> /tmp/target'
          )
        ),
      onError
    })
    await detachPaneToNewWorkspace(terminalPayload, ops)
    expect(ops.addWorkspace).not.toHaveBeenCalled()
    expect(ops.removePaneFromSource).not.toHaveBeenCalled()
    expect(ops.removeSourceWorkspace).not.toHaveBeenCalled()
    expect(ops.selectWorkspace).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0][0] as Error).message).toContain('session 1')
  })

  it('removePaneFromSource throwing (after a CONFIRMED reparent) aborts before removeSourceWorkspace or selectWorkspace run', async () => {
    const onError = vi.fn()
    const ops = fakeOps({
      removePaneFromSource: vi.fn(() => {
        throw new Error('boom')
      }),
      onError
    })
    await detachPaneToNewWorkspace(terminalPayload, ops)
    expect(ops.removeSourceWorkspace).not.toHaveBeenCalled()
    expect(ops.selectWorkspace).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('addWorkspace throwing (after a CONFIRMED reparent) aborts before removePaneFromSource or removeSourceWorkspace run', async () => {
    const onError = vi.fn()
    const ops = fakeOps({
      addWorkspace: vi.fn(() => {
        throw new Error('boom')
      }),
      onError
    })
    await detachPaneToNewWorkspace(terminalPayload, ops)
    expect(ops.removePaneFromSource).not.toHaveBeenCalled()
    expect(ops.removeSourceWorkspace).not.toHaveBeenCalled()
    expect(ops.selectWorkspace).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
  })
})
