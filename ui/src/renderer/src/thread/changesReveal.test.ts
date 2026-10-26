// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHANGES_REVEAL_EVENT, CHANGES_REVEAL_TTL_MS, changesListStamp, repoRelativePath, revealInChanges, takeChangesReveal } from './changesReveal'

describe('changes reveal', () => {
  afterEach(() => {
    vi.useRealTimers()
    takeChangesReveal('/', [], changesListStamp())
  })

  it('resolves a path against the session directory and the repository', () => {
    expect(repoRelativePath({ path: '/home/dev/repo/src/a.ts', cwd: '/home/dev/repo' }, '/home/dev/repo')).toBe('src/a.ts')
    expect(repoRelativePath({ path: 'src/a.ts', cwd: '/home/dev/repo/ui' }, '/home/dev/repo')).toBe('ui/src/a.ts')
    expect(repoRelativePath({ path: 'C:\\Dev\\Repo\\a.ts', cwd: 'C:\\Dev\\Repo' }, 'c:/dev/repo')).toBe('a.ts')
    expect(repoRelativePath({ path: '/home/dev/repo2/a.ts', cwd: '/home/dev' }, '/home/dev/repo')).toBeNull()
  })

  it('keeps a request while the list loads or shows another repository, then consumes it', () => {
    let heard = 0
    const listener = (): void => { heard++ }
    window.addEventListener(CHANGES_REVEAL_EVENT, listener)
    revealInChanges({ path: '/repo/a.ts', cwd: '/repo' })
    window.removeEventListener(CHANGES_REVEAL_EVENT, listener)
    expect(heard).toBe(1)
    expect(takeChangesReveal('/repo', null, changesListStamp())).toBeNull()
    expect(takeChangesReveal('/other', ['a.ts'], changesListStamp())).toBeNull()
    expect(takeChangesReveal('/repo', ['a.ts', 'b.ts'], changesListStamp())).toBe('a.ts')
    expect(takeChangesReveal('/repo', ['a.ts'], changesListStamp())).toBeNull()
  })

  it('drops a request for a file its repository does not list, so a later list never moves the selection', () => {
    revealInChanges({ path: '/repo/a.ts', cwd: '/repo' })
    expect(takeChangesReveal('/repo', ['b.ts'], changesListStamp())).toBeNull()
    expect(takeChangesReveal('/repo', ['a.ts', 'b.ts'], changesListStamp())).toBeNull()
  })

  it('keeps a request that a list received before it does not show, until a newer list does', () => {
    const stale = changesListStamp()
    revealInChanges({ path: '/repo/new.ts', cwd: '/repo' })
    expect(takeChangesReveal('/repo', ['old.ts'], stale)).toBeNull()
    expect(takeChangesReveal('/repo', ['old.ts', 'new.ts'], changesListStamp())).toBe('new.ts')
  })

  it('takes a file a list received before the request already shows', () => {
    const earlier = changesListStamp()
    revealInChanges({ path: '/repo/a.ts', cwd: '/repo' })
    expect(takeChangesReveal('/repo', ['a.ts'], earlier)).toBe('a.ts')
  })

  it('drops a request nobody took within its lifetime', () => {
    vi.useFakeTimers()
    revealInChanges({ path: '/elsewhere/a.ts', cwd: '/elsewhere' })
    vi.advanceTimersByTime(CHANGES_REVEAL_TTL_MS + 1)
    expect(takeChangesReveal('/elsewhere', ['a.ts'], changesListStamp())).toBeNull()
  })
})
