// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type AppHarness,
  deliverHelloOk,
  makeWorkspace,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'

const KEY = 'tr-selected-workspace'
const FIRST = '/tmp/first-workspace'
const MINE = '/tmp/the-one-i-was-in'

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function selectedName(harness: AppHarness): string | null {
  const btn = Array.from(harness.container.querySelectorAll('.witem[role="button"]')).find(
    (b) => b.getAttribute('aria-current') === 'true'
  )
  return btn ? (btn.textContent ?? '').trim() : null
}

function rowByLabel(harness: AppHarness, label: string): HTMLElement {
  const btn = Array.from(harness.container.querySelectorAll('.witem[role="button"]')).find((b) =>
    (b.textContent ?? '').includes(label)
  )
  if (!(btn instanceof HTMLElement)) throw new Error(`no sidebar row labelled "${label}"`)
  return btn
}

describe('the window comes back to the workspace it was showing', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('restores the remembered workspace instead of the daemon\'s first', async () => {
    harness = await renderReadyApp()
    localStorage.setItem(KEY, MINE)
    deliverHelloOk({
      sessions: [],
      workspaces: [makeWorkspace({ path: FIRST, name: 'first' }), makeWorkspace({ path: MINE, name: 'mine' })]
    })
    await flush()

    expect(selectedName(harness)).toContain('mine')
  })

  it('falls back to the first workspace when the remembered one is gone', async () => {
    harness = await renderReadyApp()
    localStorage.setItem(KEY, '/tmp/deleted-since')
    deliverHelloOk({
      sessions: [],
      workspaces: [makeWorkspace({ path: FIRST, name: 'first' }), makeWorkspace({ path: MINE, name: 'mine' })]
    })
    await flush()

    expect(selectedName(harness)).toContain('first')
  })

  it('remembers a switch, and never remembers the pre-hello aggregate', async () => {
    harness = await renderReadyApp()
    deliverHelloOk({
      sessions: [],
      workspaces: [makeWorkspace({ path: FIRST, name: 'first' }), makeWorkspace({ path: MINE, name: 'mine' })]
    })
    await flush()
    expect(localStorage.getItem(KEY)).not.toBe('all')

    await act(async () => {
      rowByLabel(harness!, 'mine').click()
      await Promise.resolve()
    })
    await flush()

    expect(localStorage.getItem(KEY)).toBe(MINE)
  })

  it('a reconnect does not yank the user out of the workspace they are in', async () => {
    harness = await renderReadyApp()
    localStorage.setItem(KEY, FIRST)
    deliverHelloOk({
      sessions: [],
      workspaces: [makeWorkspace({ path: FIRST, name: 'first' }), makeWorkspace({ path: MINE, name: 'mine' })]
    })
    await flush()

    await act(async () => {
      rowByLabel(harness!, 'mine').click()
      await Promise.resolve()
    })
    await flush()

    deliverHelloOk({
      sessions: [],
      workspaces: [makeWorkspace({ path: FIRST, name: 'first' }), makeWorkspace({ path: MINE, name: 'mine' })]
    })
    await flush()

    expect(selectedName(harness)).toContain('mine')
  })
})
