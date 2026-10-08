// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AppHarness, renderReadyApp, resetHarness } from './test/appTestHarness'
import { DEFAULT_GRID_ID, gridStorageKey } from './layout/tree'

const WS = '/tmp/project'
const LAYOUT_KEY = gridStorageKey(WS, DEFAULT_GRID_ID)

beforeEach(() => {
  resetHarness()
  localStorage.clear()
  localStorage.setItem(
    `tr-layout:${WS}`,
    JSON.stringify({
      customized: true,
      cols: 2,
      tree: {
        kind: 'split',
        dir: 'row',
        weights: [50, 50],
        children: [
          { kind: 'leaf', session: 1, id: 'p1' },
          { kind: 'browser', id: 'b-cleanup', url: 'https://example.test/' }
        ]
      }
    })
  )
})

describe('saved browser leaves migrate to the side panel', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('removes the browser from the grid and preserves its URL in workspace side state', async () => {
    harness = await renderReadyApp()

    const layout = JSON.parse(localStorage.getItem(`tr-layout:${LAYOUT_KEY}`) ?? 'null')
    expect(layout.tree).toEqual({ kind: 'leaf', session: 1, id: 'p1' })
    expect(localStorage.getItem(`tr-side:${WS}`)).toContain('https://example.test/')
    expect(harness.container.querySelector('.pane.browser')).toBeNull()
  })
})
