// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type AppHarness,
  makeSession,
  makeWorkspace,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'

const WS = '/tmp/project'
const SEED_KEY = `tr-layout:${WS}`
const FOCUSED_PANE_KEY = 'tr-focused-pane'

function seedTwoPaneLayout(): void {
  localStorage.setItem(
    SEED_KEY,
    JSON.stringify({
      customized: true,
      cols: 2,
      tree: {
        kind: 'split',
        dir: 'row',
        weights: [50, 50],
        children: [
          { kind: 'leaf', session: 1, id: 'pane-one' },
          { kind: 'leaf', session: 2, id: 'pane-two' }
        ]
      }
    })
  )
}

const TWO_SESSIONS = {
  sessions: [makeSession({ id: 1 }), makeSession({ id: 2, title: 'session-2' })],
  workspaces: [makeWorkspace()]
}

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

describe('a restored grid comes back with the keyboard in a pane', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  function focusedSession(h: AppHarness): number | null {
    const el = h.container.querySelector('section.pane.focus[data-panekey]')
    const key = el?.getAttribute('data-panekey')
    return key !== null && key !== undefined && /^\d+$/.test(key) ? Number(key) : null
  }

  it('focuses the remembered pane at boot, with no click and no session_created', async () => {
    seedTwoPaneLayout()
    localStorage.setItem(FOCUSED_PANE_KEY, JSON.stringify({ [WS]: 'pane-one' }))
    harness = await renderReadyApp(TWO_SESSIONS)
    expect(focusedSession(harness)).toBe(1)
  })

  it('the restored pane can actually take keys', async () => {
    seedTwoPaneLayout()
    localStorage.setItem(FOCUSED_PANE_KEY, JSON.stringify({ [WS]: 'pane-one' }))
    harness = await renderReadyApp(TWO_SESSIONS)
    expect(harness.container.querySelector('[data-typeable]')).not.toBeNull()
  })

  it('hands the keyboard back to the pane that had it, not just the first', async () => {
    seedTwoPaneLayout()
    localStorage.setItem(FOCUSED_PANE_KEY, JSON.stringify({ [WS]: 'pane-two' }))
    harness = await renderReadyApp(TWO_SESSIONS)
    expect(focusedSession(harness)).toBe(2)
  })

  it('focuses NOTHING when this workspace has no remembered pane', async () => {
    seedTwoPaneLayout()
    harness = await renderReadyApp(TWO_SESSIONS)
    expect(focusedSession(harness)).toBeNull()
  })

  it('falls back to the first live pane when the remembered one is gone', async () => {
    seedTwoPaneLayout()
    localStorage.setItem(FOCUSED_PANE_KEY, JSON.stringify({ [WS]: 'pane-long-since-closed' }))
    harness = await renderReadyApp(TWO_SESSIONS)
    expect(focusedSession(harness)).toBe(1)
  })

  it('remembers the pane by its durable id, which survives a respawn', async () => {
    seedTwoPaneLayout()
    harness = await renderReadyApp(TWO_SESSIONS)
    const pane = harness.container.querySelector('section.pane[data-panekey="2"]')
    act(() => {
      pane?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
    })
    expect(focusedSession(harness)).toBe(2)
    expect(JSON.parse(localStorage.getItem(FOCUSED_PANE_KEY) ?? '{}')).toEqual({
      [WS]: 'pane-two'
    })
  })

  it('does not re-focus after a deliberate click away onto bare grid', async () => {
    seedTwoPaneLayout()
    localStorage.setItem(FOCUSED_PANE_KEY, JSON.stringify({ [WS]: 'pane-one' }))
    harness = await renderReadyApp(TWO_SESSIONS)
    expect(focusedSession(harness)).toBe(1)
    act(() => {
      document.body.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
      )
    })
    expect(focusedSession(harness)).toBeNull()
  })

  it('leaves an empty workspace alone — there is nothing to focus', async () => {
    harness = await renderReadyApp({ sessions: [], workspaces: [makeWorkspace()] })
    expect(focusedSession(harness)).toBeNull()
  })

  it('never focuses a dead pane', async () => {
    seedTwoPaneLayout()
    localStorage.setItem(FOCUSED_PANE_KEY, JSON.stringify({ [WS]: 'pane-one' }))
    harness = await renderReadyApp({
      sessions: [
        makeSession({ id: 1, state: 'exited' }),
        makeSession({ id: 2, title: 'session-2' })
      ],
      workspaces: [makeWorkspace()]
    })
    expect(focusedSession(harness)).toBe(2)
  })
})
