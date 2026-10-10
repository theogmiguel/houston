// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WslList } from '../../houston/wslDistros'
import { WslSection } from './WslSection'

const { invokeMock, listeners } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listeners: new Map<string, () => void>()
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: () => void) => {
    listeners.set(event, handler)
    return () => listeners.delete(event)
  })
}))

const TWO_DISTROS: WslList = {
  available: true,
  distros: [
    { name: 'Ubuntu', state: 'Running', version: 2, default: true, enabled: true, slot: 1, status: 'ready' },
    { name: 'Debian', state: 'Stopped', version: 2, default: false, enabled: false, status: 'disabled' }
  ]
}

function answer(list: WslList, extra: Record<string, (args: unknown) => unknown> = {}): void {
  invokeMock.mockImplementation(async (cmd: string, args: unknown) => {
    if (cmd === 'wsl_list') return list
    if (cmd === 'env_list') return [{ id: 'local', kind: 'local', slot: 0, port: 1, token: 't', state: 'ready' }]
    const handler = extra[cmd]
    if (handler) return handler(args)
    throw new Error(`unexpected ${cmd}`)
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

describe('WslSection', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    invokeMock.mockReset()
    listeners.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function render(): Promise<void> {
    act(() => root.render(<WslSection />))
    await flush()
  }

  function byTestId(id: string): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`))
  }

  it('shows the reason WSL is unavailable', async () => {
    answer({ available: false, reason: 'wsl.exe could not be started: program not found', distros: [] })
    await render()

    expect(byTestId('wsl-section-unavailable')[0]?.textContent).toBe('wsl.exe could not be started: program not found')
  })

  it('shows the experimental label', async () => {
    answer(TWO_DISTROS)
    await render()

    expect(container.textContent).toContain('Experimental')
  })

  it('lists each distro with its state, version, default flag and per-distro logins', async () => {
    answer(TWO_DISTROS)
    await render()

    expect(byTestId('wsl-distro-facts').map((el) => el.textContent)).toEqual(['Running · WSL 2 · default', 'Stopped · WSL 2'])
    expect(container.textContent).toContain('Houston is running in Ubuntu.')
    expect(container.textContent).toContain('Agent CLIs and their logins come from inside Debian, not from Windows.')
    expect(byTestId('wsl-distro-enable')).toHaveLength(1)
    expect(byTestId('wsl-distro-disable')).toHaveLength(1)
  })

  it('enables a distro and shows a refusal that names the reason', async () => {
    answer(TWO_DISTROS, {
      wsl_enable: () => {
        throw 'Debian reports glibc 2.31; Houston needs 2.35 or newer'
      }
    })
    await render()

    act(() => byTestId('wsl-distro-enable')[0].click())
    await flush()

    expect(invokeMock).toHaveBeenCalledWith('wsl_enable', { name: 'Debian' })
    expect(byTestId('wsl-distro-error')[0]?.textContent).toBe('Debian reports glibc 2.31; Houston needs 2.35 or newer')
  })

  it('disables a distro only after the confirmation', async () => {
    answer(TWO_DISTROS, { wsl_disable: () => ({ name: 'Ubuntu' }) })
    await render()

    act(() => byTestId('wsl-distro-disable')[0].click())
    await flush()
    expect(invokeMock).not.toHaveBeenCalledWith('wsl_disable', expect.anything())
    expect(document.body.textContent).toContain("Disabling Ubuntu stops Houston's daemon inside it")

    const confirm = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Disable' && !b.dataset.testid)
    act(() => confirm!.click())
    await flush()

    expect(invokeMock).toHaveBeenCalledWith('wsl_disable', { name: 'Ubuntu' })
  })

  it('reloads the list when the environments change', async () => {
    answer(TWO_DISTROS)
    await render()
    const before = invokeMock.mock.calls.filter(([cmd]) => cmd === 'wsl_list').length

    act(() => listeners.get('wsl://environments')?.())
    await flush()

    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'wsl_list').length).toBe(before + 1)
  })
})
