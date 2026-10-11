// @vitest-environment jsdom
import { act } from 'react'
import { waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type AppHarness, currentClient, renderReadyApp, resetHarness } from './test/appTestHarness'
import type { EnvironmentEntry } from './houston/environments'

const picked = vi.hoisted(() => ({ value: null as string[] | null }))
const environments = vi.hoisted(() => ({ value: [] as EnvironmentEntry[] }))

vi.mock('./houston/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./houston/bridge')>()
  return { ...actual, pickDirectories: vi.fn(async () => picked.value) }
})
vi.mock('./houston/environments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./houston/environments')>()
  return { ...actual, listEnvironments: vi.fn(async () => environments.value) }
})

const UBUNTU: EnvironmentEntry = { id: 'wsl:Ubuntu', kind: 'wsl', distro: 'Ubuntu', slot: 1, port: 5001, token: 't', state: 'ready' }

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

async function pickFolder(harness: AppHarness): Promise<void> {
  const add = Array.from(harness.container.querySelectorAll('button')).find((el) =>
    (el.getAttribute('aria-label') ?? '').startsWith('Add workspace')
  )
  if (!add) throw new Error('no "Add workspace" button in the rail')
  act(() => add.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  await flush()
  const localFolder = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
    (item) => item.textContent === 'Local folder…'
  )
  act(() => localFolder!.click())
  await flush()
}

let harness: AppHarness | null = null

beforeEach(() => {
  resetHarness()
  localStorage.clear()
  environments.value = [{ id: 'local', kind: 'local', slot: 0, port: 1, token: 't', state: 'ready' }, UBUNTU]
})
afterEach(() => {
  harness?.unmount()
  harness = null
  vi.clearAllMocks()
})

describe('Add workspace from a WSL distro', () => {
  it('refuses a pick from a distro that is not enabled', async () => {
    harness = await renderReadyApp()
    picked.value = [String.raw`\\wsl.localhost\Debian\home\u\p`]

    await pickFolder(harness)

    await waitFor(() =>
      expect(harness!.container.textContent).toContain('Enable Debian in Settings → WSL to open folders from it')
    )
    expect(currentClient().addWorkspace).not.toHaveBeenCalled()
  })

  it('adds a pick from an enabled distro through its wsl.localhost path', async () => {
    harness = await renderReadyApp()
    picked.value = [String.raw`\\wsl.localhost\Ubuntu\home\u\p`]

    await pickFolder(harness)

    await waitFor(() => expect(currentClient().addWorkspace).toHaveBeenCalledTimes(1))
    expect(currentClient().addWorkspace).toHaveBeenCalledWith(String.raw`\\wsl.localhost\Ubuntu\home\u\p`)
  })
})
