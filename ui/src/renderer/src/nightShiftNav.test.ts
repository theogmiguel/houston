import { describe, expect, it } from 'vitest'
import { nightNoticeWorkspace } from './nightShiftNav'

describe('nightNoticeWorkspace', () => {
  it('names the workspace instead of showing its path', () => {
    const workspaces = [{ path: 'C:\\scratch\\ns-demo', name: 'Demo' }]
    expect(nightNoticeWorkspace('C:\\scratch\\ns-demo', workspaces)).toBe('Demo')
    expect(nightNoticeWorkspace('C:\\scratch\\gone', workspaces)).toBe('gone')
    expect(nightNoticeWorkspace('/home/u/project/', [])).toBe('project')
  })
})
