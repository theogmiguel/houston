// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AppHarness,
  deliverControl,
  makeSession,
  makeWorkspace,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'

interface FakeNotificationInstance {
  title: string
  body: string
  onclick: (() => void) | null
}

function installFakeNotification(
  permission: NotificationPermission
): {
  instances: FakeNotificationInstance[]
  requestPermission: ReturnType<typeof vi.fn>
  setPermission: (p: NotificationPermission) => void
} {
  const instances: FakeNotificationInstance[] = []
  const requestPermission = vi.fn(() => Promise.resolve('default' as NotificationPermission))
  class FakeNotification {
    static permission: NotificationPermission = permission
    static requestPermission = requestPermission
    title: string
    body: string
    onclick: (() => void) | null = null
    constructor(title: string, opts?: { body?: string }) {
      this.title = title
      this.body = opts?.body ?? ''
      instances.push(this)
    }
  }
  ;(globalThis as unknown as { Notification: unknown }).Notification = FakeNotification
  return {
    instances,
    requestPermission,
    setPermission: (p) => {
      FakeNotification.permission = p
    }
  }
}

function removeFakeNotification(): void {
  delete (globalThis as { Notification?: unknown }).Notification
}

function installIsFocusedQueue(): { resolveNext: (v: boolean) => void; pendingCount: () => number } {
  const resolvers: ((v: boolean) => void)[] = []
  ;(window.houston as unknown as { isFocused: () => Promise<boolean> }).isFocused = vi.fn(
    () => new Promise<boolean>((resolve) => resolvers.push(resolve))
  )
  return {
    resolveNext: (v: boolean) => {
      const r = resolvers.shift()
      if (!r) throw new Error('installIsFocusedQueue: no pending isFocused() call to resolve')
      r(v)
    },
    pendingCount: () => resolvers.length
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
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

function bellItemTexts(harness: AppHarness): string[] {
  return Array.from(harness.container.querySelectorAll('.bell-item')).map((el) => el.textContent ?? '')
}

function witemOnLabel(harness: AppHarness, label: string): boolean {
  const btn = Array.from(harness.container.querySelectorAll('.witem[role="button"]')).find((b) =>
    (b.textContent ?? '').includes(label)
  )
  if (!btn) throw new Error(`witem with label "${label}" not found`)
  return btn.getAttribute('aria-current') === 'true'
}

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

describe('App agent-notice desktop notifications (P4 #18)', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
    removeFakeNotification()
  })

  it('toggle off (default): the inbox still records the notice, but no notification fires', async () => {
    const { instances } = installFakeNotification('granted')
    harness = await renderReadyApp()

    deliverControl({ type: 'agent_notice', session: 1, kind: 'finished' })
    await flush()

    expect(instances).toHaveLength(0)
    openBell(harness)
    expect(bellItemTexts(harness).some((t) => t.includes('session-1') && t.includes('finished'))).toBe(
      true
    )
  })

  it('the bell dropdown is marked no-drag, so pressing a notice body cannot drag the window', async () => {
    harness = await renderReadyApp()
    deliverControl({ type: 'agent_notice', session: 1, kind: 'finished' })
    await flush()
    openBell(harness)

    const panel = harness.container.querySelector('.bell-menu')
    if (!panel) throw new Error('bell dropdown not found after opening it')
    const item = harness.container.querySelector('.bell-item')
    if (!item) throw new Error('bell item not found')

    expect(panel.className).toContain('[-webkit-app-region:no-drag]')
    expect(item.closest('.\\[-webkit-app-region\\:no-drag\\]')).not.toBeNull()
  })

  it('the bell dropdown opts back into text selection the titlebar turns off', async () => {
    harness = await renderReadyApp()
    deliverControl({ type: 'agent_notice', session: 1, kind: 'finished' })
    await flush()
    openBell(harness)

    const header = harness.container.querySelector('header')
    if (!header) throw new Error('titlebar header not found')
    const panel = harness.container.querySelector('.bell-menu')
    if (!panel) throw new Error('bell dropdown not found after opening it')

    expect(header.className).toContain('select-none')
    expect(panel.className).toContain('select-text')
    expect(panel.closest('header')).toBe(header)
  })

  it('permission granted + window unfocused: fires exactly once, titled/bodied from the session and kind', async () => {
    const { instances } = installFakeNotification('granted')
    localStorage.setItem('tr-notify-desktop', '1')
    harness = await renderReadyApp()

    const isFocused = window.houston.isFocused as unknown as ReturnType<typeof vi.fn>
    isFocused.mockResolvedValue(false)

    deliverControl({ type: 'agent_notice', session: 1, kind: 'finished' })
    await flush()

    expect(instances).toHaveLength(1)
    expect(instances[0].title).toBe('session-1')
    expect(instances[0].body).toBe('finished — awaiting you')
  })

  it('permission granted + window focused + same workspace already selected: suppressed', async () => {
    const { instances } = installFakeNotification('granted')
    localStorage.setItem('tr-notify-desktop', '1')
    harness = await renderReadyApp()

    const isFocused = window.houston.isFocused as unknown as ReturnType<typeof vi.fn>
    isFocused.mockResolvedValue(true)

    deliverControl({ type: 'agent_notice', session: 1, kind: 'needs-input' })
    await flush()

    expect(instances).toHaveLength(0)
    openBell(harness)
    expect(bellItemTexts(harness).some((t) => t.includes('needs your input'))).toBe(true)
  })

  it('permission default: requests once, fires only after requestPermission resolves granted — the notice survives the pending gap', async () => {
    const { instances, requestPermission } = installFakeNotification('default')
    let resolveGrant: (p: NotificationPermission) => void = () => {}
    requestPermission.mockImplementation(
      () =>
        new Promise<NotificationPermission>((resolve) => {
          resolveGrant = resolve
        })
    )
    localStorage.setItem('tr-notify-desktop', '1')
    harness = await renderReadyApp()

    const isFocused = window.houston.isFocused as unknown as ReturnType<typeof vi.fn>
    isFocused.mockResolvedValue(false)

    deliverControl({ type: 'agent_notice', session: 1, kind: 'error' })
    await flush()

    openBell(harness)
    expect(bellItemTexts(harness).some((t) => t.includes('hit an error'))).toBe(true)
    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(instances).toHaveLength(0)

    deliverControl({ type: 'agent_notice', session: 1, kind: 'finished' })
    await flush()
    expect(requestPermission).toHaveBeenCalledTimes(1)

    act(() => {
      resolveGrant('granted')
    })
    await flush()

    expect(instances).toHaveLength(2)
    expect(instances.map((i) => i.body).sort()).toEqual([
      'finished — awaiting you',
      'hit an error'
    ])
  })

  it('permission denied: never fires, and never re-prompts', async () => {
    const { instances, requestPermission } = installFakeNotification('denied')
    localStorage.setItem('tr-notify-desktop', '1')
    harness = await renderReadyApp()

    const isFocused = window.houston.isFocused as unknown as ReturnType<typeof vi.fn>
    isFocused.mockResolvedValue(false)

    deliverControl({ type: 'agent_notice', session: 1, kind: 'finished' })
    await flush()
    deliverControl({ type: 'agent_notice', session: 1, kind: 'error' })
    await flush()

    expect(instances).toHaveLength(0)
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('two notices racing one pending isFocused(): each is judged independently against its OWN resolution, resolution order does not matter', async () => {
    const { instances } = installFakeNotification('granted')
    localStorage.setItem('tr-notify-desktop', '1')
    harness = await renderReadyApp()

    deliverControl({
      type: 'session_list',
      sessions: [
        makeSession({ id: 1, project_dir: '/tmp/project', title: 'session-1' }),
        makeSession({ id: 2, project_dir: '/tmp/other', title: 'session-2' })
      ]
    })
    deliverControl({ type: 'workspace_list', workspaces: [makeWorkspace({ path: '/tmp/project' })] })

    const { resolveNext, pendingCount } = installIsFocusedQueue()

    deliverControl({ type: 'agent_notice', session: 1, kind: 'finished' })
    deliverControl({ type: 'agent_notice', session: 2, kind: 'finished' })
    await flush()
    expect(pendingCount()).toBe(2)

    act(() => resolveNext(true))
    await flush()
    expect(instances).toHaveLength(0)

    act(() => resolveNext(true))
    await flush()
    expect(instances).toHaveLength(1)
    expect(instances[0].title).toBe('session-2')
  })

  it('notification onClick, plain workspace session: selects that workspace', async () => {
    const { instances } = installFakeNotification('granted')
    localStorage.setItem('tr-notify-desktop', '1')
    harness = await renderReadyApp()

    deliverControl({
      type: 'workspace_list',
      workspaces: [makeWorkspace({ path: '/tmp/project', name: 'project' }), makeWorkspace({ path: '/tmp/other', name: 'other' })]
    })
    await flush()

    const otherBtn = Array.from(harness.container.querySelectorAll('.witem[role="button"]')).find((b) =>
      (b.textContent ?? '').includes('other')
    ) as HTMLButtonElement | undefined
    if (!otherBtn) throw new Error('workspace row "other" not found')
    act(() => otherBtn.click())
    expect(witemOnLabel(harness, 'other')).toBe(true)
    expect(witemOnLabel(harness, 'project')).toBe(false)

    const isFocused = window.houston.isFocused as unknown as ReturnType<typeof vi.fn>
    isFocused.mockResolvedValue(true)

    deliverControl({ type: 'agent_notice', session: 1, kind: 'finished' })
    await flush()

    expect(instances).toHaveLength(1)
    act(() => instances[0].onclick?.())

    expect(witemOnLabel(harness, 'project')).toBe(true)
    expect(witemOnLabel(harness, 'other')).toBe(false)
  })

  it('the OS notification global is genuinely absent: no throw, inbox entry still recorded', async () => {
    removeFakeNotification()
    localStorage.setItem('tr-notify-desktop', '1')
    harness = await renderReadyApp()

    const isFocused = window.houston.isFocused as unknown as ReturnType<typeof vi.fn>
    isFocused.mockResolvedValue(false)

    expect(() => deliverControl({ type: 'agent_notice', session: 1, kind: 'finished' })).not.toThrow()
    await flush()

    openBell(harness)
    expect(bellItemTexts(harness).some((t) => t.includes('session-1') && t.includes('finished'))).toBe(
      true
    )
  })

  it('the same agent-notice content twice within the cooldown fires both sinks once, not twice', async () => {
    const { instances } = installFakeNotification('granted')
    localStorage.setItem('tr-notify-desktop', '1')
    harness = await renderReadyApp()

    const isFocused = window.houston.isFocused as unknown as ReturnType<typeof vi.fn>
    isFocused.mockResolvedValue(false)

    deliverControl({ type: 'agent_notice', session: 1, kind: 'finished' })
    await flush()
    deliverControl({ type: 'agent_notice', session: 1, kind: 'finished' })
    await flush()

    expect(instances).toHaveLength(1)
    openBell(harness)
    expect(bellItemTexts(harness).filter((t) => t.includes('session-1') && t.includes('finished'))).toHaveLength(
      1
    )
  })
})
