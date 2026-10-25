// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHANGES_REVEAL_EVENT, CHANGES_REVEAL_TTL_MS, repoRelativePath, revealInChanges, takeChangesReveal } from './changesReveal'

describe('changes reveal', () => {
  afterEach(() => {
    vi.useRealTimers()
    takeChangesReveal('/', [])
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
    expect(takeChangesReveal('/repo', null)).toBeNull()
    expect(takeChangesReveal('/other', ['a.ts'])).toBeNull()
    expect(takeChangesReveal('/repo', ['a.ts', 'b.ts'])).toBe('a.ts')
    expect(takeChangesReveal('/repo', ['a.ts'])).toBeNull()
  })

  it('drops a request for a file its repository does not list, so a later list never moves the selection', () => {
    revealInChanges({ path: '/repo/a.ts', cwd: '/repo' })
    expect(takeChangesReveal('/repo', ['b.ts'])).toBeNull()
    expect(takeChangesReveal('/repo', ['a.ts', 'b.ts'])).toBeNull()
  })

  it('drops a request nobody took within its lifetime', () => {
    vi.useFakeTimers()
    revealInChanges({ path: '/elsewhere/a.ts', cwd: '/elsewhere' })
    vi.advanceTimersByTime(CHANGES_REVEAL_TTL_MS + 1)
    expect(takeChangesReveal('/elsewhere', ['a.ts'])).toBeNull()
  })
})
