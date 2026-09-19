import { describe, expect, it } from 'vitest'
import {
  adjacentPaneKey,
  equalize,
  leaf,
  preorderLeaves,
  preorderSlots,
  tidy,
  tidyColumns,
  type BrowserNode,
  type LayoutNode,
  type SplitNode,
  type StackNode
} from './tree'

const browser = (id: string): BrowserNode => ({ kind: 'browser', id, url: '' })
const row = (...children: LayoutNode[]): SplitNode => ({
  kind: 'split',
  dir: 'row',
  children,
  weights: children.map(() => 100 / children.length)
})

describe('tidyColumns', () => {
  it('hand-sets the small counts and derives the rest, capped at four', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 20].map(tidyColumns)).toEqual([
      1, 2, 2, 2, 3, 3, 4, 4, 4, 4
    ])
  })
})

describe('tidy', () => {
  it('rebuilds N panes as rows of tidyColumns(N), every ratio even', () => {
    const t = tidy(row(leaf(1), leaf(2), leaf(3), leaf(4), leaf(5))) as SplitNode
    expect(t.dir).toBe('col')
    expect(t.weights).toEqual([100 / 2, 100 / 2])
    expect(t.children.map((c) => (c as SplitNode).children.length)).toEqual([3, 2])
    for (const c of t.children) expect((c as SplitNode).weights.every((w) => w > 0)).toBe(true)
  })

  it('keeps visual order', () => {
    expect(preorderLeaves(tidy(row(leaf(3), leaf(1), leaf(2))))).toEqual([3, 1, 2])
  })

  it('moves slots rather than re-creating them (D37: identity is the pane)', () => {
    const b = browser('b-keep')
    const before = row(leaf(1), b, leaf(2))
    const after = tidy(before)!
    expect(preorderSlots(after).find((s) => s.kind === 'browser')).toBe(b)
  })

  it('keeps a stack whole — it is one slot, not its tabs', () => {
    const stack: StackNode = {
      kind: 'stack',
      id: 's1',
      children: [browser('b1'), browser('b2')],
      activeIndex: 1
    }
    const after = tidy(row(leaf(1), stack, leaf(2)))!
    expect(preorderSlots(after)).toContain(stack)
    expect(preorderSlots(after)).toHaveLength(3)
  })

  it('collapses to the bare pane when only one slot is left, and null on nothing', () => {
    const only = leaf(7)
    expect(tidy(row(only))).toBe(only)
    expect(tidy(null)).toBeNull()
  })
})

describe('equalize', () => {
  it('resets every split at every depth without moving a pane', () => {
    const before: SplitNode = {
      kind: 'split',
      dir: 'col',
      children: [{ ...row(leaf(1), leaf(2)), weights: [90, 10] }, leaf(3)],
      weights: [80, 20]
    }
    const after = equalize(before) as SplitNode
    expect(after.weights).toEqual([50, 50])
    expect((after.children[0] as SplitNode).weights).toEqual([50, 50])
    expect(preorderLeaves(after)).toEqual(preorderLeaves(before))
  })

  it('passes a bare pane through untouched', () => {
    const bare = leaf(1)
    expect(equalize(bare)).toBe(bare)
  })
})

describe('adjacentPaneKey', () => {
  const tree = row(leaf(1), browser('b1'), leaf(2))

  it('walks forward and back in visual order', () => {
    expect(adjacentPaneKey(tree, 1, 1)).toBe('b1')
    expect(adjacentPaneKey(tree, 'b1', -1)).toBe(1)
  })

  it('wraps at both ends rather than dying at the edge', () => {
    expect(adjacentPaneKey(tree, 2, 1)).toBe(1)
    expect(adjacentPaneKey(tree, 1, -1)).toBe(2)
  })

  it('reaches a pane a stack is hiding', () => {
    const stacked = row(leaf(1), {
      kind: 'stack',
      id: 's1',
      children: [browser('b1'), browser('b2')],
      activeIndex: 0
    })
    expect(adjacentPaneKey(stacked, 'b1', 1)).toBe('b2')
  })

  it('is null with nothing to move to, or for a key the tree does not hold', () => {
    expect(adjacentPaneKey(leaf(1), 1, 1)).toBeNull()
    expect(adjacentPaneKey(tree, 99, 1)).toBeNull()
  })
})
