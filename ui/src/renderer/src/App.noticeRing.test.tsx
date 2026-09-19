// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type AppHarness,
  deliverControl,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function paneRing(harness: AppHarness, session: number): Element | null {
  return harness.container.querySelector(`[data-panekey="${session}"] .pane-notice-ring`)
}

function witemRow(harness: AppHarness, label: string): HTMLButtonElement {
  const btn = Array.from(harness.container.querySelectorAll('.witem[role="button"]')).find((b) =>
    (b.textContent ?? '').includes(label)
  ) as HTMLButtonElement | undefined
  if (!btn) throw new Error(`witem with label "${label}" not found`)
  return btn
}

function openBell(harness: AppHarness): void {
  const bellBtn = Array.from(harness.container.querySelectorAll('button')).find((b) =>
    b.className.includes('bell-btn')
  ) as HTMLButtonElement | undefined
  if (!bellBtn) throw new Error('bell button not found')
  act(() => {
    bellBtn.click()
  })
}

function clickMarkAllRead(harness: AppHarness): void {
  openBell(harness)
  const btn = Array.from(harness.container.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes('Mark all read')
  ) as HTMLButtonElement | undefined
  if (!btn) throw new Error('"Mark all read" button not found')
  act(() => {
    btn.click()
  })
}

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

describe('Q3: per-pane completion/error/needs-input ring', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('a "finished" notice rings the pane, completed-toned', async () => {
    harness = await renderReadyApp()

    deliverControl({ type: 'agent_notice', session: 1, kind: 'finished' })
    await flush()

    const ring = paneRing(harness, 1)
    expect(ring).not.toBeNull()
    expect(ring?.className).toContain('completed')
  })

  it('an "error" notice rings it error-toned instead', async () => {
    harness = await renderReadyApp()

    deliverControl({ type: 'agent_notice', session: 1, kind: 'error' })
    await flush()

    expect(paneRing(harness, 1)?.className).toContain('error')
  })

  it('a "needs-input" notice rings the pane too, needs-input toned', async () => {
    harness = await renderReadyApp()

    deliverControl({ type: 'agent_notice', session: 1, kind: 'needs-input' })
    await flush()

    const ring = paneRing(harness, 1)
    expect(ring).not.toBeNull()
    expect(ring?.className).toContain('needs-input')
  })

  it('focusing the pane clears a needs-input ring as well', async () => {
    harness = await renderReadyApp()

    deliverControl({ type: 'agent_notice', session: 1, kind: 'needs-input' })
    await flush()
    expect(paneRing(harness, 1)).not.toBeNull()

    const pane = harness.container.querySelector('[data-panekey="1"]')
    if (!(pane instanceof HTMLElement)) throw new Error('no pane rendered for session 1')
    act(() => {
      pane.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
    })

    expect(paneRing(harness, 1)).toBeNull()
  })

  it('focusing the pane clears its ring', async () => {
    harness = await renderReadyApp()

    deliverControl({ type: 'agent_notice', session: 1, kind: 'finished' })
    await flush()
    expect(paneRing(harness, 1)).not.toBeNull()

    const pane = harness.container.querySelector('[data-panekey="1"]')
    if (!(pane instanceof HTMLElement)) throw new Error('no pane rendered for session 1')
    act(() => {
      pane.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
    })

    expect(paneRing(harness, 1)).toBeNull()
  })

  it('"Mark all read" clears the pane ring', async () => {
    harness = await renderReadyApp()

    deliverControl({ type: 'agent_notice', session: 1, kind: 'finished' })
    await flush()
    expect(paneRing(harness, 1)).not.toBeNull()

    clickMarkAllRead(harness)

    expect(paneRing(harness, 1)).toBeNull()
  })

  it('dismissing the notice that set a ring clears the pane ring', async () => {
    harness = await renderReadyApp()

    deliverControl({ type: 'agent_notice', session: 1, kind: 'finished' })
    await flush()
    expect(paneRing(harness, 1)).not.toBeNull()

    openBell(harness)
    const dismissBtn = harness.container.querySelector(
      'button[aria-label="Dismiss"]'
    ) as HTMLButtonElement | null
    if (!dismissBtn) throw new Error('dismiss button not found')
    act(() => {
      dismissBtn.click()
    })

    expect(paneRing(harness, 1)).toBeNull()
  })

  it('the workspace row never rings — the sidebar half of T5 is cut (2026-08-26)', async () => {
    harness = await renderReadyApp()

    deliverControl({ type: 'agent_notice', session: 1, kind: 'finished' })
    await flush()
    expect(paneRing(harness, 1)).not.toBeNull()

    expect(witemRow(harness, 'project').querySelector('.notice-ring')).toBeNull()
    expect(harness.container.querySelector('.sidebar-notice-ring')).toBeNull()
  })
})
