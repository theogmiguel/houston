// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type AppHarness,
  deliverControl,
  deliverHelloOk,
  makeWorkspace,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function selectedName(harness: AppHarness): string | null {
  const row = Array.from(harness.container.querySelectorAll('.witem[role="button"]')).find(
    (b) => b.getAttribute('aria-current') === 'true'
  )
  return row ? (row.textContent ?? '').trim() : null
}

let harness: AppHarness | null = null

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})
afterEach(() => {
  harness?.unmount()
  harness = null
})

describe('houston . inside WSL', () => {
  it('selects the focused workspace', async () => {
    harness = await renderReadyApp()
    deliverHelloOk({
      sessions: [],
      workspaces: [
        makeWorkspace({ path: 'C:\\work', name: 'windows-work' }),
        makeWorkspace({ path: '/home/u/proj', name: 'linux-proj' })
      ]
    })
    await flush()
    expect(selectedName(harness)).toContain('windows-work')

    act(() => deliverControl({ type: 'workspace_focus', path: '/home/u/proj' }))
    await flush()

    expect(selectedName(harness)).toContain('linux-proj')
  })
})
