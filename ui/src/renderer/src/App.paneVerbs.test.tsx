// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AppHarness, renderReadyApp, resetHarness } from './test/appTestHarness'

const WS = '/tmp/project'
const LAYOUT_KEY = `tr-layout:${WS}::g-default`

const SEEDED = {
  cols: 2,
  tree: {
    kind: 'split',
    dir: 'row',
    weights: [60, 25, 15],
    children: [
      { kind: 'leaf', session: 1 },
      { kind: 'browser', id: 'b1', url: 'https://one.test/' },
      { kind: 'browser', id: 'b2', url: 'https://two.test/' }
    ]
  }
}

beforeEach(() => {
  resetHarness()
  localStorage.clear()
  localStorage.setItem(`tr-layout:${WS}`, JSON.stringify(SEEDED))
})

function press(key: string): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

function savedTree(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null')?.tree
}

function order(): (string | number)[] {
  const out: (string | number)[] = []
  const walk = (n: Record<string, unknown> | null): void => {
    if (!n) return
    if (n.kind === 'split' || n.kind === 'stack')
      return void (n.children as Record<string, unknown>[]).forEach(walk)
    out.push(n.kind === 'leaf' ? (n.session as number) : (n.id as string))
  }
  walk(savedTree())
  return out
}

function focusedPaneKey(harness: AppHarness): string | null {
  return harness.container.querySelector('.pane.focus')?.getAttribute('data-panekey') ?? null
}

describe('keyboard pane verbs', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('] and [ walk focus forward and back through the panes', async () => {
    harness = await renderReadyApp()
    press(']')
    expect(focusedPaneKey(harness)).toBe('b1')
    press(']')
    expect(focusedPaneKey(harness)).toBe('b2')
    press('[')
    expect(focusedPaneKey(harness)).toBe('b1')
  })

  it('} carries the focused pane one step along, wrapping', async () => {
    harness = await renderReadyApp()
    expect(order()).toEqual([1, 'b1', 'b2'])
    press(']')
    press('}')
    expect(order()).toEqual([1, 'b2', 'b1'])
  })

  it('= evens every split without moving a pane', async () => {
    harness = await renderReadyApp()
    expect(savedTree().weights).toEqual([60, 25, 15])
    press('=')
    expect(savedTree().weights).toEqual([100 / 3, 100 / 3, 100 / 3])
    expect(order()).toEqual([1, 'b1', 'b2'])
  })

  it('y tidies the grid into rows', async () => {
    harness = await renderReadyApp()
    press('y')
    const tree = savedTree()
    expect(tree.dir).toBe('col')
    expect(order()).toEqual([1, 'b1', 'b2'])
  })
})
