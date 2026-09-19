// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { PrDetail, PrStack } from '../../houston/client'
import {
  actionDisabledReason,
  draftKey,
  draftLabel,
  hasReacted,
  parsePrDiff,
  reactionCount,
  reviewerKey,
  reviewerName,
  stackMergeHeads,
  stackMergeRefusal,
  verdictsFor
} from './prDetailUi'

const PATCH = [
  'diff --git a/src/a.rs b/src/a.rs',
  'index 111..222 100644',
  '--- a/src/a.rs',
  '+++ b/src/a.rs',
  '@@ -10,4 +10,5 @@ fn main() {',
  ' context one',
  '-old line',
  '+new line',
  '+added line',
  ' context two',
  'diff --git a/old/name.rs b/new/name.rs',
  'similarity index 90%',
  'rename from old/name.rs',
  'rename to new/name.rs',
  '--- a/old/name.rs',
  '+++ b/new/name.rs',
  '@@ -1 +1 @@',
  '-before',
  '+after',
  '\\ No newline at end of file'
].join('\n')

function detail(o: Partial<PrDetail> = {}): PrDetail {
  return {
    body: null,
    author: 'theo',
    base_ref: 'main',
    head_ref: 'feat/x',
    head_sha: 'abc',
    commit_count: 1,
    created_at: 1,
    updated_at: 2,
    mergeable: 'mergeable',
    merge_state: 'clean',
    checks: [],
    comments: [],
    reviews: [],
    comments_total: 0,
    reviews_total: 0,
    merge_disabled_reason: null,
    viewer: {
      can_write: true,
      can_triage: true,
      can_update: true,
      did_author: false,
      can_update_branch: false
    },
    viewer_message: null,
    behind_by: null,
    labels: [],
    reviewers: [],
    reactions: [],
    threads: [],
    threads_truncated: false,
    threads_message: null,
    auto_merge_enabled: null,
    auto_merge_method: null,
    cross_repository: false,
    ...o
  }
}

describe('parsePrDiff', () => {
  it('numbers both sides and anchors each line to the side a draft names', () => {
    const files = parsePrDiff(PATCH)
    expect(files).toHaveLength(2)
    const first = files[0]
    expect(first.path).toBe('src/a.rs')
    expect(first.previousPath).toBeNull()
    expect(first.additions).toBe(2)
    expect(first.deletions).toBe(1)
    const hunk = first.lines.find((l) => l.kind === 'hunk')!
    expect(hunk.text).toContain('@@ -10,4 +10,5 @@')
    const context = first.lines.find((l) => l.kind === 'ctx' && l.text === ' context one')!
    expect(context.oldLine).toBe(10)
    expect(context.newLine).toBe(10)
    expect(context.side).toBe('right')
    expect(context.line).toBe(10)
    const deleted = first.lines.find((l) => l.kind === 'del')!
    expect(deleted.oldLine).toBe(11)
    expect(deleted.newLine).toBeNull()
    expect(deleted.side).toBe('left')
    expect(deleted.line).toBe(11)
    const added = first.lines.find((l) => l.kind === 'add')!
    expect(added.newLine).toBe(11)
    expect(added.side).toBe('right')
    const second = first.lines.filter((l) => l.kind === 'add')[1]
    expect(second.newLine).toBe(12)
    const tail = first.lines.find((l) => l.kind === 'ctx' && l.text === ' context two')!
    expect(tail.oldLine).toBe(12)
    expect(tail.newLine).toBe(13)
  })

  it('keeps a rename and its no-newline marker out of the numbered lines', () => {
    const files = parsePrDiff(PATCH)
    const renamed = files[1]
    expect(renamed.path).toBe('new/name.rs')
    expect(renamed.previousPath).toBe('old/name.rs')
    const marker = renamed.lines.find((l) => l.text.startsWith('\\ No newline'))!
    expect(marker.kind).toBe('meta')
    expect(marker.side).toBeNull()
    expect(marker.line).toBeNull()
  })

  it('treats a new file header as a path, not a deletion', () => {
    const files = parsePrDiff(
      ['diff --git a/new.rs b/new.rs', 'new file mode 100644', '--- /dev/null', '+++ b/new.rs', '@@ -0,0 +1,1 @@', '+hello'].join(
        '\n'
      )
    )
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe('new.rs')
    expect(files[0].previousPath).toBeNull()
    expect(files[0].deletions).toBe(0)
    expect(files[0].additions).toBe(1)
    expect(files[0].lines.find((l) => l.kind === 'add')!.newLine).toBe(1)
  })

  it('parses a patch with no diff header as one unnamed file', () => {
    const files = parsePrDiff('@@ -1 +1 @@\n-a\n+b')
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe('')
  })

  it('parses nothing out of nothing', () => {
    expect(parsePrDiff('')).toEqual([])
  })
})

describe('draft addressing', () => {
  it('keys a draft by path, side and line, and names it the same way', () => {
    const draft = { path: 'src/a.rs', side: 'right' as const, line: 12, body: 'x' }
    expect(draftKey(draft)).toBe('src/a.rs:right:12')
    expect(draftLabel(draft)).toBe('src/a.rs · new line 12')
    expect(draftLabel({ ...draft, side: 'left' })).toBe('src/a.rs · old line 12')
  })
})

describe('reactions', () => {
  it('counts a content and says whether the viewer reacted', () => {
    const counts = [
      { content: 'thumbs_up' as const, count: 3, reacted: true },
      { content: 'heart' as const, count: 1, reacted: false }
    ]
    expect(reactionCount(counts, 'thumbs_up')).toBe(3)
    expect(reactionCount(counts, 'rocket')).toBe(0)
    expect(hasReacted(counts, 'thumbs_up')).toBe(true)
    expect(hasReacted(counts, 'heart')).toBe(false)
  })
})

describe('stack merges', () => {
  const stack: PrStack = {
    id: 'ST_1',
    number: 5,
    url: 'https://github.com/o/r/stacks/5',
    base: 'main',
    layers: [
      { number: 60, head_ref: 'feat/a', state: 'merged', is_draft: false, title: null, head_sha: 'a' },
      { number: 61, head_ref: 'feat/x', state: 'open', is_draft: false, title: null, head_sha: 'b' },
      { number: 62, head_ref: 'feat/y', state: 'open', is_draft: false, title: null, head_sha: 'c' }
    ]
  }

  it('pins every open layer up to and including the target', () => {
    expect(stackMergeHeads(stack, 61)).toEqual([{ number: 61, head_sha: 'b' }])
    expect(stackMergeHeads(stack, 62)).toEqual([
      { number: 61, head_sha: 'b' },
      { number: 62, head_sha: 'c' }
    ])
    expect(stackMergeHeads(stack, 60)).toEqual([])
    expect(stackMergeHeads(stack, 99)).toEqual([])
  })

  it('refuses a stack with a draft, a closed layer or no head', () => {
    const drafted = {
      ...stack,
      layers: stack.layers.map((l) => (l.number === 62 ? { ...l, is_draft: true } : l))
    }
    expect(stackMergeRefusal(drafted, 62)).toContain('draft')
    expect(stackMergeRefusal(drafted, 61)).toBeNull()
    const closed = {
      ...stack,
      layers: stack.layers.map((l) => (l.number === 61 ? { ...l, state: 'closed' as const } : l))
    }
    expect(stackMergeRefusal(closed, 62)).toContain('closed')
    const headless = {
      ...stack,
      layers: stack.layers.map((l) => (l.number === 61 ? { ...l, head_sha: null } : l))
    }
    expect(stackMergeRefusal(headless, 61)).toContain('no head revision')
    expect(stackMergeRefusal(stack, 99)).toContain('not a layer')
  })
})

describe('permission-shaped reasons', () => {
  it('refuses every write when the permission read failed', () => {
    const noViewer = detail({ viewer: null, viewer_message: 'boom' })
    for (const action of ['ready', 'close', 'update_branch', 'revert'] as const) {
      expect(actionDisabledReason(noViewer, action)).toContain('permissions could not be read')
    }
  })

  it('separates write from update and update-branch', () => {
    const triager = detail({
      viewer: {
        can_write: false,
        can_triage: true,
        can_update: true,
        did_author: false,
        can_update_branch: false
      }
    })
    expect(actionDisabledReason(triager, 'ready')).toBeNull()
    expect(actionDisabledReason(triager, 'revert')).toContain('write access')
    const current = detail()
    expect(actionDisabledReason(current, 'update_branch')).toContain('nothing to update')
    const stale = detail({
      viewer: {
        can_write: true,
        can_triage: true,
        can_update: true,
        did_author: false,
        can_update_branch: true
      }
    })
    expect(actionDisabledReason(stale, 'update_branch')).toBeNull()
  })

  it('takes only comments from the author', () => {
    expect(verdictsFor(detail())).toEqual(['comment', 'approve', 'request_changes'])
    expect(
      verdictsFor(
        detail({
          viewer: {
            can_write: true,
            can_triage: true,
            can_update: true,
            did_author: true,
            can_update_branch: false
          }
        })
      )
    ).toEqual(['comment'])
  })

  it('names a team apart from a user', () => {
    expect(reviewerKey({ id: 'core', kind: 'team' })).toBe('team:core')
    expect(reviewerName({ id: 'core', kind: 'team' })).toBe('core (team)')
    expect(reviewerName({ id: 'core', kind: 'user' })).toBe('core')
  })
})
