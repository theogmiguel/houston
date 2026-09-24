// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AppHarness,
  currentClient,
  deliverControl,
  makeWorkspace,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'
import { WORKSPACE_REFUSAL_RULE } from './components/workspaceEligibility'

const picked = vi.hoisted(() => ({ value: null as string[] | null, throws: null as Error | null }))
vi.mock('./houston/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./houston/bridge')>()
  return {
    ...actual,
    pickDirectories: vi.fn(async () => {
      if (picked.throws) throw picked.throws
      return picked.value
    })
  }
})

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function addButton(harness: AppHarness): HTMLButtonElement {
  const b = Array.from(harness.container.querySelectorAll('button')).find((el) =>
    [el.getAttribute('aria-label'), el.getAttribute('title')].some((n) =>
      (n ?? '').startsWith('Add workspace')
    )
  )
  if (!b) throw new Error('no "Add workspace" button in the rail')
  return b as HTMLButtonElement
}

async function clickAdd(harness: AppHarness): Promise<void> {
  act(() => addButton(harness).dispatchEvent(new MouseEvent('click', { bubbles: true })))
  await flush()
}

let harness: AppHarness | null = null

beforeEach(() => {
  resetHarness()
  localStorage.clear()
  picked.value = null
  picked.throws = null
})
afterEach(() => {
  harness?.unmount()
  harness = null
  vi.clearAllMocks()
})

describe('step 1 — "Add Workspace" is the folder picker, no screen in between', () => {
  it('Cancel — nothing is added, nothing is said', async () => {
    harness = await renderReadyApp()
    const client = currentClient()
    picked.value = null

    await clickAdd(harness)

    expect(client.addWorkspace).not.toHaveBeenCalled()
    expect(harness.container.textContent).not.toContain(WORKSPACE_REFUSAL_RULE)
    expect(harness.container.querySelector('[data-testid="new-session-composer"]')).toBeNull()
  })

  it('Success — the picked folders are added, deduped by path, and the last one selected', async () => {
    harness = await renderReadyApp()
    const client = currentClient()
    picked.value = ['/home/test/alpha', '/home/test/beta', '/home/test/alpha']

    await clickAdd(harness)

    expect((client.addWorkspace as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ['/home/test/alpha'],
      ['/home/test/beta']
    ])
  })

  it('Success — the picked folder opens straight onto step 3’s composer', async () => {
    harness = await renderReadyApp()
    picked.value = ['/home/test/beta']

    await clickAdd(harness)
    act(() => {
      deliverControl({
        type: 'workspace_list',
        workspaces: [makeWorkspace({ path: '/home/test/beta', name: 'beta' })]
      })
    })
    await flush()

    const composer = harness.container.querySelector('[data-testid="new-session-composer"]')
    expect(composer, 'the folder picker’s success opens the composer').not.toBeNull()
    expect(composer?.textContent).toContain('beta')
  })

  it('Success — closing the composer leaves the ZERO-pane workspace behind it', async () => {
    harness = await renderReadyApp()
    picked.value = ['/home/test/beta']

    await clickAdd(harness)
    act(() => {
      deliverControl({
        type: 'workspace_list',
        workspaces: [makeWorkspace({ path: '/home/test/beta', name: 'beta' })]
      })
    })
    await flush()
    act(() => {
      harness!.container
        .querySelector<HTMLButtonElement>('[data-testid="new-session-close"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    const empty = harness.container.querySelector('[data-testid="workspace-empty"]')
    expect(empty, 'a freshly added workspace shows step 2 behind the composer').not.toBeNull()
    expect(empty?.textContent).toContain('Nothing running here yet')
  })

  it('Refused — root and a secret dir are turned away while home and a good pick land', async () => {
    harness = await renderReadyApp()
    const client = currentClient()
    picked.value = ['/', '/home/test', '/home/test/.ssh', '/home/test/ok']

    await clickAdd(harness)

    expect((client.addWorkspace as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ['/home/test'],
      ['/home/test/ok']
    ])
  })

  it('Failed — a thrown picker surfaces, rather than looking like a cancel', async () => {
    harness = await renderReadyApp()
    const client = currentClient()
    picked.throws = new Error('EACCES')

    await clickAdd(harness)

    expect(client.addWorkspace).not.toHaveBeenCalled()
  })
})
