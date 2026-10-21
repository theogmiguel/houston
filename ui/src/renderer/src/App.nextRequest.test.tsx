import { withInputOwner } from './test/inputFixtures'
// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InboxRow } from './houston/generated/InboxRow'
import type { SessionInfo } from './houston/client'
import { prefixLayer } from './prefixLayer'
import { type AppHarness, deliverClientMsg, makeSession, makeWorkspace, renderReadyApp, resetHarness } from './test/appTestHarness'

const A = '/tmp/ws-a'
const B = '/tmp/ws-b'
const WORKSPACES = [makeWorkspace({ path: A, name: 'ws-a' }), makeWorkspace({ path: B, name: 'ws-b' })]

let h: AppHarness | null = null
beforeEach(() => { resetHarness(); localStorage.clear(); prefixLayer.disarm() })
afterEach(() => { prefixLayer.disarm(); h?.unmount(); h = null; vi.clearAllMocks() })

function paneVisible(id: number): boolean {
  const pane = h!.container.querySelector(`section.pane[data-panekey="${id}"]`)
  if (!pane) return false
  const host = pane.closest('[data-workspace]')
  return host === null || !host.classList.contains('hidden')
}

function focused(): number | null {
  const key = h!.container.querySelector('section.pane.focus')?.getAttribute('data-panekey')
  return key == null ? null : Number(key)
}

function pointAt(id: number): void {
  const pane = h!.container.querySelector(`section.pane[data-panekey="${id}"]`)
  act(() => { pane!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })) })
}

async function afterPrefix(init: KeyboardEventInit): Promise<void> {
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', ctrlKey: true, cancelable: true })) })
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { cancelable: true, ...init })) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

const nextRequest = (): Promise<void> => afterPrefix({ code: 'Digit1', key: '!', shiftKey: true })
const back = (): Promise<void> => afterPrefix({ code: 'Backspace', key: 'Backspace' })

function waiting(id: number, project: string, since: number): SessionInfo {
  return makeSession({ id, project_dir: project, cwd: project, title: `pane-${id}`, status: 'needs-input', status_since_ms: since })
}

async function boot(sessions: SessionInfo[], start: number): Promise<void> {
  h = await renderReadyApp({ workspaces: WORKSPACES, sessions })
  if (!paneVisible(start)) await afterPrefix({ code: 'KeyN', key: 'n' })
  expect(paneVisible(start)).toBe(true)
  pointAt(start)
  expect(focused()).toBe(start)
}

describe('Next request', () => {
  it('focuses the older request in another workspace, then the newer one, then wraps', async () => {
    await boot([makeSession({ id: 3, project_dir: A, cwd: A }), waiting(1, A, 2000), waiting(2, B, 1000)], 3)
    await nextRequest()
    expect(paneVisible(2)).toBe(true)
    expect(focused()).toBe(2)
    await nextRequest()
    expect(paneVisible(1)).toBe(true)
    expect(focused()).toBe(1)
    await nextRequest()
    expect(focused()).toBe(2)
  })

  it('opens an escalated child in its orchestrator roster with Answer applied', async () => {
    const child = withInputOwner(makeSession({ id: 2, spawned_by: 1, project_dir: A, cwd: A, title: 'worker', status_since_ms: 500 }), 'user', 'Choose the target branch')
    await boot([makeSession({ id: 1, project_dir: A, cwd: A, children_waiting: 1 }), child, makeSession({ id: 3, project_dir: B, cwd: B })], 3)
    await nextRequest()
    expect(paneVisible(1)).toBe(true)
    expect(focused()).toBe(1)
    expect(h!.container.querySelector('[data-peek-session="2"]')?.getAttribute('aria-hidden')).toBe('false')
    expect(h!.container.querySelector('[data-peek-session="2"] [data-tone="warn"]')?.textContent).toContain('Choose the target branch')
  })

  it('Back returns to the pane focused before the first jump after several jumps', async () => {
    await boot([makeSession({ id: 3, project_dir: A, cwd: A }), waiting(1, A, 2000), waiting(2, B, 1000)], 3)
    await nextRequest()
    await nextRequest()
    await nextRequest()
    expect(focused()).toBe(2)
    await back()
    expect(paneVisible(3)).toBe(true)
    expect(focused()).toBe(3)
    await back()
    expect(focused()).toBe(3)
  })

  it('reaches an Addressed to you row through its orchestrator', async () => {
    await boot([makeSession({ id: 3, project_dir: A, cwd: A }), makeSession({ id: 5, project_dir: B, cwd: B, spawned_by: null }), waiting(1, A, 9000)], 3)
    const row = { id: 7n, to_session: 0, original_to: null, from_session: 5, workspace: B, kind: 'result', urgent: false, superseded: 0, provisional: false, attempts: 0, summary: 'Merge?', body: 'Merge?', artifacts: [], created_at: 1000n, resolved_at: null } as InboxRow
    deliverClientMsg('inbox_rows', { workspace: B, rows: [row] })
    await nextRequest()
    expect(paneVisible(5)).toBe(true)
    expect(focused()).toBe(5)
    deliverClientMsg('inbox_changed', { workspace: B, row: { ...row, resolved_at: 2000 } })
    await nextRequest()
    expect(focused()).toBe(1)
    await nextRequest()
    expect(focused()).toBe(1)
  })

  it('says nothing is waiting and stays put when no request is assigned to you', async () => {
    const asked = withInputOwner(makeSession({ id: 2, spawned_by: 1, project_dir: A, cwd: A }), 'orchestrator')
    await boot([makeSession({ id: 1, project_dir: A, cwd: A }), asked, makeSession({ id: 3, project_dir: B, cwd: B })], 3)
    await nextRequest()
    expect(focused()).toBe(3)
    expect(document.querySelector('[data-notice]')?.textContent).toContain('Nothing is waiting on you')
  })
})
