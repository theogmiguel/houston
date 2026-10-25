// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type AppHarness,
  deliverControl,
  makeWorkspace,
  renderReadyApp,
  resetHarness,
  settleLazySurface
} from './test/appTestHarness'
import { openSideBrowser } from './sidePanel'
import { DEFAULT_GRID_ID, flushLayoutSaves, gridStorageKey } from './layout/tree'

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

function pressB(): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', ctrlKey: true, bubbles: true, cancelable: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true, cancelable: true }))
  })
}

function savedTree(): Record<string, unknown> | null {
  flushLayoutSaves()
  const raw = localStorage.getItem(`tr-layout:${gridStorageKey('/tmp/project', DEFAULT_GRID_ID)}`)
  return raw ? (JSON.parse(raw).tree as Record<string, unknown>) : null
}

function browserLeaves(node: unknown): Record<string, unknown>[] {
  if (!node || typeof node !== 'object') return []
  const n = node as Record<string, unknown>
  if (n.kind === 'browser') return [n]
  if (n.kind !== 'split' && n.kind !== 'stack') return []
  return (n.children as unknown[]).flatMap(browserLeaves)
}

describe('the browser pane shortcut', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('opens the Browser surface in the side panel', async () => {
    harness = await renderReadyApp()
    expect(browserLeaves(savedTree())).toHaveLength(0)

    pressB()

    expect(browserLeaves(savedTree())).toHaveLength(0)
    await settleLazySurface(
      () => harness!.container.querySelector('.browser-surface[data-active="true"] input[aria-label="Address"]') !== null,
      'BrowserSurface'
    )
    expect(harness!.container.querySelector('[data-testid="side-panel"]')).not.toBeNull()
  })

  it('opens a new Browser tab when the shortcut is used again', async () => {
    harness = await renderReadyApp()
    pressB()
    pressB()

    expect(browserLeaves(savedTree())).toHaveLength(0)
    await settleLazySurface(
      () => harness!.container.querySelector('.browser-surface') !== null,
      'BrowserSurface'
    )
    expect(harness.container.querySelectorAll('.browser-surface')).toHaveLength(2)
  })

  it('keeps another workspace browser surface mounted while selecting a new workspace', async () => {
    harness = await renderReadyApp({ workspaces: [makeWorkspace(), makeWorkspace({ path: '/tmp/other', name: 'other' })] })
    act(() => openSideBrowser('first-workspace', 'https://first.test/', '/tmp/project'))
    await settleLazySurface(() => harness!.container.querySelector('.browser-surface[data-active="true"]') !== null, 'first workspace browser')
    const first = harness.container.querySelector('.browser-surface')!
    act(() => openSideBrowser('second-workspace', 'https://second.test/', '/tmp/other'))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(first.isConnected).toBe(true)
    expect(harness.container.querySelectorAll('.browser-surface')).toHaveLength(2)
    expect(first.getAttribute('data-active')).not.toBe('true')
  })

  it('stays inert on step 1’s screen, which can sit over a live workspace', async () => {
    harness = await renderReadyApp()

    act(() => {
      deliverControl({ type: 'workspace_list', workspaces: [] })
    })
    expect(harness.container.querySelector('[data-testid="workspaces-empty"]')).not.toBeNull()

    pressB()

    expect(browserLeaves(savedTree())).toHaveLength(0)
  })

  it('does not create browser grid leaves when Browser is already open', async () => {
    harness = await renderReadyApp()
    pressB()
    pressB()
    expect(browserLeaves(savedTree())).toHaveLength(0)
  })

  it('stays inert while a pane is selected, so the key belongs to the agent', async () => {
    harness = await renderReadyApp()
    const pane = harness.container.querySelector('.pane')
    if (!(pane instanceof HTMLElement)) throw new Error('no .pane rendered')
    act(() => {
      pane.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
      pane.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    pressB()

    expect(browserLeaves(savedTree())).toHaveLength(0)
  })
})
