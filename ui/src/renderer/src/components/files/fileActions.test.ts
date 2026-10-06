import { describe, expect, it } from 'vitest'
import { fileActionDirectory, fileReference, gitTreeStatus, relativeFilePath } from './fileActions'
import type { GitFileStatus } from '../../houston/client'
const file = (path: string, status: GitFileStatus['status']): GitFileStatus => ({ path, status, staged: false, added: 0, deleted: 0, is_sensitive: false })
describe('file references', () => {
  it('quotes whitespace and preserves a directory slash', () => {
    expect(fileReference('/work/my folder', true)).toBe('@"/work/my folder/" ')
    expect(fileReference('/work/file.ts', false)).toBe('@/work/file.ts ')
  })
  it.each(['a/../b', 'a\nline', 'a\0b', 'x'.repeat(4097), ''])('rejects invalid references with their value and limit', (path) => {
    expect(() => fileReference(path, false)).toThrow(JSON.stringify(path))
    expect(() => fileReference(path, false)).toThrow('4096')
  })
  it('accepts the boundary and a filename containing two dots', () => {
    expect(fileReference('x'.repeat(4096), false)).toHaveLength(4098)
    expect(fileReference('/work/a..b', false)).toBe('@/work/a..b ')
  })
  it('returns workspace-relative paths and preserves paths outside the workspace', () => {
    expect(relativeFilePath('/work/project/', '/work/project/src/main.ts')).toBe('src/main.ts')
    expect(relativeFilePath('/work/project', '/work/project')).toBe('.')
    expect(relativeFilePath('/work/project', '/work/project-other/file.ts')).toBe('/work/project-other/file.ts')
  })
  it('chooses the selected directory or a file parent for creation and reveal actions', () => {
    expect(fileActionDirectory('/work/src', true)).toBe('/work/src')
    expect(fileActionDirectory('/work/src/main.ts', false)).toBe('/work/src')
    expect(fileActionDirectory('/main.ts', false)).toBe('/')
  })
})
describe('git tree status', () => {
  it('rolls folders up in severity order and handles renamed files', () => {
    const files = [file('src/a', 'added'), file('src/b', 'modified'), file('src/c', 'deleted'), file('src/d', 'conflicted')]
    expect(gitTreeStatus('/work', '/work/src', true, files)).toBe('conflicted')
    expect(gitTreeStatus('/work', '/work/src', true, files.slice(0, 3))).toBe('deleted')
    expect(gitTreeStatus('/work', '/work/src', true, [file('src/a', 'renamed'), file('src/b', 'untracked')])).toBe('renamed')
  })
  it('matches complete path segments and leaves clean files undecorated', () => {
    expect(gitTreeStatus('/work', '/work/src', true, [file('src-other/a', 'modified')])).toBeNull()
    expect(gitTreeStatus('/work', '/work/a', false, [file('a', 'added')])).toBe('added')
  })
})
