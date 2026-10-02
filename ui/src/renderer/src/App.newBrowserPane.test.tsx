// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type AppHarness,
  deliverControl,
  renderReadyApp,
  resetHarness,
  settleLazySurface
} from './test/appTestHarness'
import { DEFAULT_GRID_ID, gridStorageKey } from './layout/tree'

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

function pressB(): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true, cancelable: true }))
  })
}

function savedTree(): Record<string, unknown> | null {
  const raw = localStorage.getItem(`tr-layout:${gridStorageKey('/tmp/project', DEFAULT_GRID_ID)}`)
  return raw ? (JSON.parse(raw).tree as Record<string, unknown>) : null
}

function sideBrowsers(): Record<string, unknown>[] {
  return (JSON.parse(localStorage.getItem('tr-side:/tmp/project') ?? 'null')?.tabs ?? []).filter((tab: { kind: string }) => tab.kind === 'browser')
}

function browserLeaves(node: unknown): Record<string, unknown>[] {
  if (!node || typeof node !== 'object') return []
  const n = node as Record<string, unknown>
  if (n.kind === 'browser') return [n]
  if (n.kind !== 'split') return []
  return (n.children as unknown[]).flatMap(browserLeaves)
}

describe('the new browser side-panel shortcut', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('opens a browser side tab without changing the workspace grid', async () => {
    harness = await renderReadyApp()
    expect(browserLeaves(savedTree())).toHaveLength(0)

    pressB()

    const leaves = sideBrowsers()
    expect(leaves).toHaveLength(1)
    expect(leaves[0].url).toBe('')
    expect(typeof leaves[0].id).toBe('string')
    const addressBar = (): HTMLInputElement | undefined =>
      Array.from(harness!.container.querySelectorAll('input')).find(
        (i) => i.placeholder === 'enter a url to open a new tab'
      )
    await settleLazySurface(() => addressBar() !== undefined, 'BrowserPane')
    expect(addressBar()).toBeDefined()
  })

  it('gives every pane its own id, so two panes never share a tab store', async () => {
    harness = await renderReadyApp()
    pressB()
    pressB()

    const ids = sideBrowsers().map((l) => l.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
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

  it('clicking into a browser pane releases the selected terminal', async () => {
    harness = await renderReadyApp()
    pressB()
    expect(sideBrowsers()).toHaveLength(1)

    await settleLazySurface(() => harness!.container.querySelector('.pane.browser') !== null, 'BrowserPane')
    const terminal = harness.container.querySelector('.pane:not(.browser)')
    const browser = harness.container.querySelector('.pane.browser')
    if (!(terminal instanceof HTMLElement) || !(browser instanceof HTMLElement)) {
      throw new Error('expected a terminal and a side-panel browser')
    }
    act(() => {
      terminal.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
      terminal.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    act(() => {
      browser.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
      browser.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    pressB()
    expect(sideBrowsers()).toHaveLength(2)
  })

  it('a clicked browser pane takes the focus ring, and gives it back', async () => {
    harness = await renderReadyApp()
    pressB()

    await settleLazySurface(() => harness!.container.querySelector('.pane.browser') !== null, 'BrowserPane')
    const terminal = (): HTMLElement => {
      const el = harness!.container.querySelector('.pane:not(.browser)')
      if (!(el instanceof HTMLElement)) throw new Error('no terminal pane rendered')
      return el
    }
    const browser = (): HTMLElement => {
      const el = harness!.container.querySelector('.pane.browser')
      if (!(el instanceof HTMLElement)) throw new Error('no browser pane rendered')
      return el
    }
    const click = (el: HTMLElement): void => {
      act(() => {
        el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })
    }

    click(browser())
    expect(browser().classList.contains('focus')).toBe(true)
    expect(terminal().classList.contains('focus')).toBe(false)

    click(terminal())
    expect(terminal().classList.contains('focus')).toBe(true)
    expect(browser().classList.contains('focus')).toBe(false)
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
