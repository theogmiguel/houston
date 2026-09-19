// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type AppHarness,
  deliverControl,
  makeSession,
  makeWorkspace,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function topbarLeft(harness: AppHarness): Element {
  const el = harness.container.querySelector('header .flex.items-center.min-w-0')
  if (!el) throw new Error('topbar-left cell not found')
  return el
}

function railToggle(harness: AppHarness): HTMLButtonElement {
  const btn = topbarLeft(harness).querySelector('button')
  if (!btn) throw new Error('rail toggle not found')
  return btn as HTMLButtonElement
}

function railHide(harness: AppHarness): HTMLButtonElement {
  const btn = harness.container.querySelector('aside > div button[aria-label="Hide sidebar"]')
  if (!btn) throw new Error('rail hide button not found in the rail head')
  return btn as HTMLButtonElement
}

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

describe('rail hide (option A) — hide in the rail head, show in the topbar-left cell', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('open: the rail head carries the "Hide sidebar" control and the topbar-left cell carries none', async () => {
    harness = await renderReadyApp()

    expect(harness.container.querySelector('aside')).not.toBeNull()
    expect(topbarLeft(harness).querySelectorAll('button')).toHaveLength(0)
    expect(railHide(harness).getAttribute('aria-label')).toBe('Hide sidebar')
  })

  it('hiding moves the glyph: the rail goes, "Show sidebar" appears in the topbar-left cell, and showing brings the head button back', async () => {
    harness = await renderReadyApp()

    act(() => railHide(harness!).click())
    expect(harness.container.querySelector('aside')).toBeNull()
    const btn = railToggle(harness)
    expect(btn.getAttribute('aria-label')).toBe('Show sidebar')
    expect(topbarLeft(harness).querySelector('[data-testid="brand-mark"]')).toBeNull()

    act(() => railToggle(harness!).click())
    expect(harness.container.querySelector('aside')).not.toBeNull()
    expect(topbarLeft(harness).querySelectorAll('button')).toHaveLength(0)
    expect(railHide(harness).getAttribute('aria-label')).toBe('Hide sidebar')
  })

  it('the railfoot no longer carries a hide control', async () => {
    harness = await renderReadyApp()
    const foot = harness.container.querySelector('.railfoot')
    expect(foot?.querySelector('button[aria-label="Hide sidebar"]')).toBeNull()
  })

  it('Ctrl+B toggles the same way as the click', async () => {
    harness = await renderReadyApp()

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true })
      )
    })
    expect(harness.container.querySelector('aside')).toBeNull()

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true })
      )
    })
    expect(harness.container.querySelector('aside')).not.toBeNull()
  })

  it('the attention dot only ever shows while the rail is hidden', async () => {
    const { App } = await import('./App')
    const { createRoot } = await import('react-dom/client')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(<App />)
    })
    const { deliverHelloOk } = await import('./test/appTestHarness')
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    deliverHelloOk({
      sessions: [
        makeSession({ id: 1, project_dir: '/tmp/project', title: 'session-1' }),
        makeSession({ id: 2, project_dir: '/tmp/other', title: 'session-2' })
      ],
      workspaces: [makeWorkspace(), makeWorkspace({ path: '/tmp/other', name: 'other' })]
    })
    await flush()

    harness = { container, root, unmount: () => { act(() => root.unmount()); container.remove() } }

    expect(topbarLeft(harness).querySelector('[data-testid="rail-toggle-attention"]')).toBeNull()

    act(() => railHide(harness!).click())
    expect(harness.container.querySelector('aside')).toBeNull()
    expect(topbarLeft(harness).querySelector('[data-testid="rail-toggle-attention"]')).toBeNull()

    deliverControl({ type: 'agent_notice', session: 2, kind: 'finished' })
    await flush()

    const dot = topbarLeft(harness).querySelector('[data-testid="rail-toggle-attention"]')
    expect(dot).not.toBeNull()
    const btn = railToggle(harness)
    expect(btn.getAttribute('aria-label')).toContain('1 workspace')

    act(() => railToggle(harness!).click())
    expect(harness.container.querySelector('aside')).not.toBeNull()
    expect(topbarLeft(harness).querySelector('[data-testid="rail-toggle-attention"]')).toBeNull()
  })

  it('the hidden state survives a remount (localStorage)', async () => {
    harness = await renderReadyApp()
    act(() => railHide(harness!).click())
    expect(harness.container.querySelector('aside')).toBeNull()
    harness.unmount()

    harness = await renderReadyApp()
    expect(harness.container.querySelector('aside')).toBeNull()
    expect(railToggle(harness).getAttribute('aria-label')).toBe('Show sidebar')
  })
})
