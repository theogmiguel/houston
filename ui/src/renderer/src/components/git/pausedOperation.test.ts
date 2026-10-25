import { describe, expect, it } from 'vitest'
import { buildResolveBrief, pausedOperationBanner } from './pausedOperation'

describe('paused operation brief', () => {
  it('names the operation, the checkout and each conflicted file', () => {
    const brief = buildResolveBrief({ operation: 'cherry_pick', dir: '/w/app', branch: null, conflicted: ['a.ts', 'b.ts'] })
    expect(brief).toContain('A git cherry-pick is paused in /w/app. Finish it.')
    expect(brief).toContain('Conflicted files (2):\n- a.ts\n- b.ts')
    expect(brief).toContain('`git -c core.editor=true cherry-pick --continue`')
    expect(brief).toContain('`git cherry-pick --skip`')
    expect(brief).toContain('Never run `git reset --hard`, `git checkout -- <path>`, `git restore`, `git clean`, `git stash` or `git cherry-pick --abort`')
    expect(brief).toContain('Run `git diff --check`')
    expect(brief).toContain('never delete the lock')
  })

  it('a merge has no skip, and a pause without conflicts says to look at git status', () => {
    const brief = buildResolveBrief({ operation: 'merge', dir: '/w', branch: 'main', conflicted: [] })
    expect(brief).not.toContain('--skip')
    expect(brief).toContain('Git reports no conflicted file')
    expect(brief).toContain('`git -c core.editor=true merge --continue`')
  })

  it('caps the listed paths and points at the rest', () => {
    const paths = Array.from({ length: 53 }, (_, i) => `f${i}.ts`)
    const brief = buildResolveBrief({ operation: 'rebase', dir: '/w', branch: 'x', conflicted: paths })
    expect(brief).toContain('- f49.ts')
    expect(brief).not.toContain('- f50.ts')
    expect(brief).toContain('- and 3 more; see git status')
  })

  it('the banner counts conflicts', () => {
    expect(pausedOperationBanner('merge', 2)).toBe('A merge is paused here with 2 conflicted files.')
    expect(pausedOperationBanner('rebase', 0)).toBe('A rebase is paused here.')
  })
})
