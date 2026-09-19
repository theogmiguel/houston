import { describe, expect, it } from 'vitest'
import type { DirEntry } from '../../env'
import { flattenTree, sortEntries, treeKeyAction, visibleEntries, type TreeRow } from './filesTree'

function e(name: string, dir = false, ignored = false, parent = '/ws'): DirEntry {
  return { name, path: `${parent}/${name}`, dir, ignored }
}

describe('Files tree — listing order and visibility', () => {
  it('puts directories first, then names in locale order, not code-unit order', () => {
    const sorted = sortEntries([
      e('zeta.ts'),
      e('ábaco.ts'),
      e('README.md'),
      e('src', true),
      e('Cargo.toml'),
      e('assets', true)
    ])
    expect(sorted.map((x) => x.name)).toEqual([
      'assets',
      'src',
      'ábaco.ts',
      'Cargo.toml',
      'README.md',
      'zeta.ts'
    ])
  })

  it('numbers sort as numbers, so `10` follows `9`', () => {
    const sorted = sortEntries([e('step10.md'), e('step9.md'), e('step1.md')])
    expect(sorted.map((x) => x.name)).toEqual(['step1.md', 'step9.md', 'step10.md'])
  })

  it('hides the entries the Rust side ANNOTATED as ignored, and nothing else', () => {
    const rows = visibleEntries([
      e('node_modules', true, true),
      e('src', true),
      e('.git', true, true),
      e('main.rs')
    ])
    expect(rows.map((x) => x.name)).toEqual(['src', 'main.rs'])
  })
})

describe('Files tree — flattening', () => {
  const children = new Map<string, DirEntry[]>([
    ['/ws', [e('src', true), e('main.rs')]],
    ['/ws/src', [e('lib.rs', false, false, '/ws/src'), e('inner', true, false, '/ws/src')]],
    ['/ws/src/inner', [e('deep.rs', false, false, '/ws/src/inner')]]
  ])

  it('emits only the root listing while nothing is expanded', () => {
    const rows = flattenTree('/ws', children, new Set())
    expect(rows.map((r) => r.path)).toEqual(['/ws/src', '/ws/main.rs'])
    expect(rows.every((r) => r.depth === 0)).toBe(true)
  })

  it('emits an expanded directory’s children immediately after it, one level deeper', () => {
    const rows = flattenTree('/ws', children, new Set(['/ws/src']))
    expect(rows.map((r) => r.path)).toEqual([
      '/ws/src',
      '/ws/src/lib.rs',
      '/ws/src/inner',
      '/ws/main.rs'
    ])
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1, 0])
  })

  it('an expanded directory whose listing has not arrived contributes its own row only', () => {
    const rows = flattenTree('/ws', children, new Set(['/ws/src', '/ws/src/nope']))
    expect(rows.map((r) => r.path)).toContain('/ws/src/inner')
    expect(rows.find((r) => r.path === '/ws/src/inner')!.expanded).toBe(false)
  })

  it('a root that has not been read yet flattens to nothing', () => {
    expect(flattenTree('/unread', children, new Set())).toEqual([])
  })
})

describe('Files tree — keyboard', () => {
  const rows: TreeRow[] = [
    { path: '/ws/src', name: 'src', dir: true, depth: 0, expanded: true },
    { path: '/ws/src/lib.rs', name: 'lib.rs', dir: false, depth: 1, expanded: false },
    { path: '/ws/main.rs', name: 'main.rs', dir: false, depth: 0, expanded: false }
  ]

  it('down and up move, and stop at the ends rather than wrapping', () => {
    expect(treeKeyAction(rows, 0, 'ArrowDown')).toEqual({ kind: 'focus', index: 1 })
    expect(treeKeyAction(rows, 1, 'ArrowUp')).toEqual({ kind: 'focus', index: 0 })
    expect(treeKeyAction(rows, 0, 'ArrowUp')).toEqual({ kind: 'none' })
    expect(treeKeyAction(rows, 2, 'ArrowDown')).toEqual({ kind: 'none' })
  })

  it('right opens a closed directory, then steps into the open one', () => {
    const closed: TreeRow[] = [{ ...rows[0], expanded: false }]
    expect(treeKeyAction(closed, 0, 'ArrowRight')).toEqual({ kind: 'expand', path: '/ws/src' })
    expect(treeKeyAction(rows, 0, 'ArrowRight')).toEqual({ kind: 'focus', index: 1 })
  })

  it('right does nothing on a file — there is nothing to open', () => {
    expect(treeKeyAction(rows, 2, 'ArrowRight')).toEqual({ kind: 'none' })
  })

  it('left closes an open directory, and otherwise steps out to the parent', () => {
    expect(treeKeyAction(rows, 0, 'ArrowLeft')).toEqual({ kind: 'collapse', path: '/ws/src' })
    expect(treeKeyAction(rows, 1, 'ArrowLeft')).toEqual({ kind: 'focus', index: 0 })
    expect(treeKeyAction(rows, 2, 'ArrowLeft')).toEqual({ kind: 'none' })
  })

  it('Enter opens a file and toggles a directory', () => {
    expect(treeKeyAction(rows, 2, 'Enter')).toEqual({ kind: 'open', path: '/ws/main.rs' })
    expect(treeKeyAction(rows, 0, 'Enter')).toEqual({ kind: 'collapse', path: '/ws/src' })
    const closed: TreeRow[] = [{ ...rows[0], expanded: false }]
    expect(treeKeyAction(closed, 0, 'Enter')).toEqual({ kind: 'expand', path: '/ws/src' })
  })

  it('an unhandled key, or a row that is not there, is a no-op', () => {
    expect(treeKeyAction(rows, 0, 'a')).toEqual({ kind: 'none' })
    expect(treeKeyAction(rows, 99, 'ArrowDown')).toEqual({ kind: 'none' })
  })
})
