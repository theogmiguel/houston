import { describe, expect, it } from 'vitest'
import { parseFileDiffLines } from './fileDiffLines'

describe('parseFileDiffLines', () => {
  it('marks added lines', () => {
    expect(parseFileDiffLines('@@ -1,2 +1,3 @@\n first\n+added\n second')).toEqual({
      added: new Set([2]), modified: new Set(), deleted: new Set()
    })
  })

  it('marks replaced lines as modified', () => {
    expect(parseFileDiffLines('@@ -5,2 +5,2 @@\n-old a\n-old b\n+new a\n+new b')).toEqual({
      added: new Set(), modified: new Set([5, 6]), deleted: new Set()
    })
  })

  it('marks removed lines at the following current line', () => {
    expect(parseFileDiffLines('@@ -3,2 +3 @@\n before\n-removed\n after')).toEqual({
      added: new Set(), modified: new Set(), deleted: new Set([4])
    })
  })

  it('parses independent hunks', () => {
    expect(parseFileDiffLines('@@ -1 +1,2 @@\n-old\n+first\n+second\n@@ -10 +11 @@\n-swap\n+replacement')).toEqual({
      added: new Set([2]), modified: new Set([1, 11]), deleted: new Set()
    })
  })
})
