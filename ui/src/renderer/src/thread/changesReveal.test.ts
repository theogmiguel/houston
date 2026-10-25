// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { CHANGES_REVEAL_EVENT, repoRelativePath, revealInChanges, takeChangesReveal } from './changesReveal'

describe('changes reveal', () => {
  it('resolves a path against the session directory and the repository', () => {
    expect(repoRelativePath({ path: '/home/dev/repo/src/a.ts', cwd: '/home/dev/repo' }, '/home/dev/repo')).toBe('src/a.ts')
    expect(repoRelativePath({ path: 'src/a.ts', cwd: '/home/dev/repo/ui' }, '/home/dev/repo')).toBe('ui/src/a.ts')
    expect(repoRelativePath({ path: 'C:\\Dev\\Repo\\a.ts', cwd: 'C:\\Dev\\Repo' }, 'c:/dev/repo')).toBe('a.ts')
    expect(repoRelativePath({ path: '/home/dev/repo2/a.ts', cwd: '/home/dev' }, '/home/dev/repo')).toBeNull()
  })

  it('keeps a request until a Changes list shows the file, then consumes it', () => {
    let heard = 0
    const listener = (): void => { heard++ }
    window.addEventListener(CHANGES_REVEAL_EVENT, listener)
    revealInChanges({ path: '/repo/a.ts', cwd: '/repo' })
    window.removeEventListener(CHANGES_REVEAL_EVENT, listener)
    expect(heard).toBe(1)
    expect(takeChangesReveal('/repo', ['b.ts'])).toBeNull()
    expect(takeChangesReveal('/repo', ['a.ts', 'b.ts'])).toBe('a.ts')
    expect(takeChangesReveal('/repo', ['a.ts'])).toBeNull()
  })
})
