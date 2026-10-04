import { describe, expect, it } from 'vitest'
import { changedEntries } from './changedEntries'

describe('changedEntries', () => {
  it('returns only keys whose value reference changed', () => {
    const unchanged = { tree: null }
    const before = new Map([['/one', unchanged], ['/two', { tree: null }]])
    const after = new Map([['/one', unchanged], ['/two', { tree: null }], ['/three', { tree: null }]])

    expect(changedEntries(before, after)).toEqual([
      ['/two', after.get('/two')],
      ['/three', after.get('/three')],
    ])
  })
})
