// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { doingNow } from './doingNow'
import { makeSession } from '../../test/appTestHarness'

describe('doing-now text', () => {
  it('shows a pending question only while the reported status needs input', () => {
    const session = makeSession({ title: 'Stable title', status: 'needs-input', activity: { prompt: 'Latest prompt', last_message: 'Latest reply', question: 'Continue?' } })
    expect(doingNow(session)).toBe('Continue?')
    expect(doingNow({ ...session, status: 'idle' })).toBe('Latest reply')
    expect(session.title).toBe('Stable title')
    expect(session.status).toBe('needs-input')
  })
  it('falls back to a prompt and hides absent hook text', () => {
    expect(doingNow(makeSession({ activity: { prompt: 'Fix parser' } }))).toBe('Fix parser')
    expect(doingNow(makeSession())).toBeNull()
  })
})
