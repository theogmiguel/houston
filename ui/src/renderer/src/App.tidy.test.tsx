// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AppHarness, renderReadyApp, resetHarness } from './test/appTestHarness'

const WS = '/tmp/project'
const LAYOUT_KEY = `tr-layout:${WS}::g-default`
const SEEDED = {
  customized: true,
  cols: 2,
  tree: {
    kind: 'split',
    dir: 'row',
    weights: [34, 33, 33],
    children: [
      { kind: 'leaf', session: 1 },
      { kind: 'browser', id: 'b-keep', url: 'https://example.test/' },
      { kind: 'editor', id: 'e-keep', path: '/tmp/project/a.ts' }
    ]
  }
}

beforeEach(() => {
  resetHarness()
  localStorage.clear()
  localStorage.setItem(`tr-layout:${WS}`, JSON.stringify(SEEDED))
})

function savedPanes(): { browsers: string[]; editors: string[]; sessions: number[] } {
  const tree = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null')?.tree
  const out = { browsers: [] as string[], editors: [] as string[], sessions: [] as number[] }
  const walk = (n: Record<string, unknown> | null): void => {
    if (!n) return
    if (n.kind === 'split') return void (n.children as Record<string, unknown>[]).forEach(walk)
    if (n.kind === 'browser') out.browsers.push(n.id as string)
    else if (n.kind === 'editor') out.editors.push(n.id as string)
    else out.sessions.push(n.session as number)
  }
  walk(tree)
  return out
}

describe('tidying the grid (inherits M9/D37)', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  function tidyButton(): HTMLButtonElement {
    const btn = Array.from(harness!.container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Tidy panes'
    )
    if (!btn) throw new Error('no "Tidy panes" button rendered')
    return btn as HTMLButtonElement
  }

  function clickTidy(): void {
    const btn = tidyButton()
    act(() => btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
  }

  it('keeps the browser and editor panes, by id', async () => {
    harness = await renderReadyApp()
    expect(savedPanes()).toEqual({ browsers: ['b-keep'], editors: ['e-keep'], sessions: [1] })

    clickTidy()

    const after = savedPanes()
    expect(after.browsers).toEqual(['b-keep'])
    expect(after.editors).toEqual(['e-keep'])
    expect(after.sessions).toEqual([1])
    expect(harness.container.querySelector('.pane.browser')).not.toBeNull()
  })

  it('keeps them across the syncs that follow, not just the click', async () => {
    harness = await renderReadyApp()
    clickTidy()
    clickTidy()

    const after = savedPanes()
    expect(after.browsers).toEqual(['b-keep'])
    expect(after.editors).toEqual(['e-keep'])
  })

  it('rebalances three panes into a 2-column grid and evens every ratio', async () => {
    harness = await renderReadyApp()
    clickTidy()

    const tree = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null')?.tree
    expect(tree.kind).toBe('split')
    expect(tree.dir).toBe('col')
    expect(tree.weights).toEqual([50, 50])
    expect(tree.children[0].dir).toBe('row')
    expect(tree.children[0].weights).toEqual([50, 50])
    expect(tree.children[1].kind).toBe('editor')
  })

  it('is disabled, with a reason, when the grid holds one pane', async () => {
    localStorage.setItem(
      `tr-layout:${WS}`,
      JSON.stringify({ cols: 2, tree: { kind: 'leaf', session: 1 } })
    )
    harness = await renderReadyApp()
    expect(tidyButton().disabled).toBe(true)
    expect(tidyButton().closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe(
      'Open a second pane to tidy the grid'
    )
  })
})
