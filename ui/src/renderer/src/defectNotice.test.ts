import { describe, expect, it, vi } from 'vitest'
import { handleDefectNotice } from './defectNotice'

const workspaces = [{ path: '/home/dev/proj', name: 'proj' }]

describe('defect notice', () => {
  it('raises one dismissible workspace-top notice with the count and newest title', () => {
    const push = vi.fn()
    const review = vi.fn()

    handleDefectNotice({ type: 'defect_notice', workspace: '/home/dev/proj', count: 3, title: 'A refused pane_reply' }, push, workspaces, review)

    expect(push).toHaveBeenCalledWith({
      code: 'defect:/home/dev/proj',
      kind: 'warning',
      title: '3 suspected defects',
      body: 'proj · A refused pane_reply',
      durationMs: null,
      action: { label: 'Review', onClick: expect.any(Function) }
    })
  })

  it('names the title when a single defect is waiting, and routes Review to its workspace', () => {
    const push = vi.fn()
    const review = vi.fn()
    handleDefectNotice({ type: 'defect_notice', workspace: '/home/dev/proj', count: 1, title: 'A refused pane_reply' }, push, workspaces, review)

    expect(push.mock.calls[0]![0]).toMatchObject({ title: 'Suspected defect: A refused pane_reply', body: 'proj' })
    push.mock.calls[0]![0].action.onClick()
    expect(review).toHaveBeenCalledWith('/home/dev/proj')
  })

  it('ignores every other message', () => {
    const push = vi.fn()
    handleDefectNotice({ type: 'harness_changed', workspace: '/home/dev/proj' }, push, workspaces, vi.fn())
    expect(push).not.toHaveBeenCalled()
  })
})
