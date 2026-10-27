// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, file, mount, teardown } from './ChangesPane.harness'
import { changesListStamp, revealInChanges, takeChangesReveal } from '../thread/changesReveal'

afterEach(() => {
  teardown()
  takeChangesReveal('/', [], changesListStamp())
})

describe('Changes pane — Open diff from a thread', () => {
  it('an open panel waits for the list that shows the new file, then selects it', () => {
    const h = mount({})
    h.status([file({ path: 'src/old.ts' })])
    act(() => revealInChanges({ path: '/repo/src/new.ts', cwd: '/repo' }))
    expect(h.client.gitDiffCalls.at(-1)?.path).toBe('src/old.ts')

    h.status([file({ path: 'src/old.ts' }), file({ path: 'src/new.ts' })])
    expect(h.client.gitDiffCalls.at(-1)?.path).toBe('src/new.ts')
  })

  it('a newer list without the file drops the request', () => {
    const h = mount({})
    h.status([file({ path: 'src/old.ts' })])
    act(() => revealInChanges({ path: '/repo/src/gone.ts', cwd: '/repo' }))
    h.status([file({ path: 'src/old.ts' }), file({ path: 'src/other.ts' })])
    h.status([file({ path: 'src/old.ts' }), file({ path: 'src/gone.ts' })])
    expect(h.client.gitDiffCalls.at(-1)?.path).toBe('src/old.ts')
  })
})
