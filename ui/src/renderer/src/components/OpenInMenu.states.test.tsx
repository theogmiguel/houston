// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorTarget } from '../houston/bridge'

const invokeMock = vi.fn()

const { OpenInMenu, orderEditors, LAST_EDITOR_KEY } = await import('./OpenInMenu')

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CODE: EditorTarget = { id: 'code', label: 'VS Code' }
const ZED: EditorTarget = { id: 'zed', label: 'Zed' }
const CURSOR: EditorTarget = { id: 'cursor', label: 'Cursor' }

describe('orderEditors', () => {
  it('leaves the list alone with no remembered choice', () => {
    expect(orderEditors([CODE, ZED], null)).toEqual([CODE, ZED])
  })

  it('hoists the last-used editor to the front, keeping the rest in order', () => {
    expect(orderEditors([CODE, ZED, CURSOR], 'cursor')).toEqual([CURSOR, CODE, ZED])
  })

  it('is a no-op when the remembered editor is already first, or is gone', () => {
    expect(orderEditors([CODE, ZED], 'code')).toEqual([CODE, ZED])
    expect(orderEditors([CODE, ZED], 'emacs')).toEqual([CODE, ZED])
  })
})

describe('OpenInMenu', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: invokeMock }
    invokeMock.mockReset()
    localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function mount(
    editors: EditorTarget[],
    onError: (m: string) => void = () => {},
    onDone: () => void = () => {}
  ): Promise<void> {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'shell_list_editors') return editors
      if (cmd === 'shell_open_in_editor') return undefined
      throw new Error(`unexpected invoke: ${cmd}`)
    })
    await act(async () => {
      root.render(
        <OpenInMenu path="/ws/main.rs" itemClass="ctx-item" onDone={onDone} onError={onError} />
      )
    })
    await act(async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve()
    })
  }

  const openSubmenu = async (): Promise<void> => {
    await act(async () => {
      container.querySelector('button')!.click()
    })
  }

  it('lists every installed editor by its display name', async () => {
    await mount([CODE, ZED])
    await openSubmenu()
    const labels = [...container.querySelectorAll('[data-testid="open-in-submenu"] button')].map(
      (b) => b.textContent
    )
    expect(labels).toEqual(['VS Code', 'Zed'])
  })

  it('with none installed, shows ONE disabled row naming the commands looked for', async () => {
    await mount([])
    await openSubmenu()
    const rows = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="open-in-submenu"] button')]
    expect(rows).toHaveLength(1)
    expect(rows[0].disabled).toBe(true)
    expect(rows[0].textContent).toContain('No editor found on PATH')
    for (const id of ['code', 'cursor', 'zed', 'windsurf']) {
      expect(rows[0].textContent).toContain(id)
    }
  })

  it('launching remembers the choice, so the next menu lists it first', async () => {
    await mount([CODE, ZED])
    await openSubmenu()
    const zed = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="open-in-submenu"] button')].find(
      (b) => b.textContent === 'Zed'
    )!
    await act(async () => {
      zed.click()
    })
    expect(localStorage.getItem(LAST_EDITOR_KEY)).toBe('zed')
    const launch = invokeMock.mock.calls.find((c) => c[0] === 'shell_open_in_editor')!
    expect(launch[1]).toEqual({
      editor: 'zed',
      path: '/ws/main.rs',
      line: undefined,
      col: undefined
    })
  })

  it('a refused launch reaches the host’s error surface — it is never swallowed', async () => {
    const onError = vi.fn()
    await mount([CODE], onError)
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'shell_open_in_editor') throw new Error('no "code" binary on PATH')
      return []
    })
    await openSubmenu()
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="open-in-submenu"] button')!.click()
    })
    await act(async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve()
    })
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toContain('no "code" binary on PATH')
  })

  it('closes the host menu as soon as a launch is dispatched, not when it resolves', async () => {
    const onDone = vi.fn()
    await mount([CODE], () => {}, onDone)
    await openSubmenu()
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="open-in-submenu"] button')!.click()
    })
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})
