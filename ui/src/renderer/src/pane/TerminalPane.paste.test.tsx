// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { ExpandedContext } from '../layout/expandedContext'
import {
  flushGhosttyAttach,
  ghosttyMock,
  ghosttySurfaceMockModule
} from '../test/ghosttySurfaceMock'

vi.mock('../ghostty/surface', () => ghosttySurfaceMockModule())

const pasted = (): string[] => ghosttyMock.pasteSpy.mock.calls.map(([text]) => text)

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 400 })
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 300 })

let readClipboardImagePath = vi.fn<() => Promise<string | null>>()
let readClipboardText = vi.fn<() => Promise<string>>()
vi.mock('../houston/bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../houston/bridge')>()),
  readClipboardImagePath: () => readClipboardImagePath(),
  readClipboardText: () => readClipboardText()
}))

window.houston = {
  pathKind: vi.fn().mockResolvedValue(null),
  openExternal: vi.fn()
} as unknown as Window['houston']

const { TerminalPane } = await import('./TerminalPane')

function makeSession(): SessionInfo {
  return {
    id: 1,
    agent: 'shell',
    project_dir: '/tmp/project',
    cwd: '/tmp/project',
    state: 'running',
    title: 'session-1',
    hidden: false
  } as SessionInfo
}

function keydown(init: KeyboardEventInit & { code: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', { cancelable: true, ...init })
}

const CTRL_V = { code: 'KeyV', key: 'v', ctrlKey: true }

describe('TerminalPane paste chord (item 11c)', () => {
  let container: HTMLDivElement
  let root: Root
  let fakeClient: HoustonClient

  function render(): void {
    act(() => {
      root.render(
        <StrictMode>
          <ExpandedContext.Provider value={null}>
            <TerminalPane
              client={fakeClient}
              info={makeSession()}
              theme="warm-espresso"
              active={true}
              connected={true}
              fontSize={13}
              copyOnSelect={false}
              stripBoxGlyphs={false}
              registerOutput={() => () => {}}
              onActivate={() => {}}
              onZoom={() => {}}
              onShellZoom={() => {}}
              onOpenFile={() => {}}
              onOpenDir={() => {}}
            />
          </ExpandedContext.Provider>
        </StrictMode>
      )
    })
  }

  async function press(e: KeyboardEvent): Promise<boolean> {
    let claimed = true
    await act(async () => {
      claimed = ghosttyMock.emitKey(e)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    return claimed
  }

  beforeEach(async () => {
    ghosttyMock.reset()
    readClipboardImagePath = vi.fn<() => Promise<string | null>>().mockResolvedValue(null)
    readClipboardText = vi.fn<() => Promise<string>>().mockResolvedValue('')
    fakeClient = {
      resizeSession: vi.fn(),
      attachSession: vi.fn(),
      sessionVisibility: vi.fn(),
      sendStdin: vi.fn()
    } as unknown as HoustonClient
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    render()
    await act(async () => {
      await flushGhosttyAttach()
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('claims plain Ctrl+V so the keystroke never reaches the PTY', async () => {
    const e = keydown(CTRL_V)
    const claimed = await press(e)
    expect(claimed).toBe(false)
    expect(e.defaultPrevented).toBe(true)
  })

  it('pastes a clipboard image as a shell-quoted path, not as bytes', async () => {
    readClipboardImagePath.mockResolvedValue('/home/dev/.houston-dev/pastes/17.png')
    await press(keydown(CTRL_V))
    expect(pasted()).toEqual(["'/home/dev/.houston-dev/pastes/17.png' "])
    expect(readClipboardText).not.toHaveBeenCalled()
  })

  it('falls through to text when the clipboard holds no image', async () => {
    readClipboardText.mockResolvedValue('echo hi')
    await press(keydown(CTRL_V))
    expect(readClipboardImagePath).toHaveBeenCalledOnce()
    expect(pasted()).toEqual(['echo hi'])
  })

  it('pastes nothing for an empty clipboard', async () => {
    await press(keydown(CTRL_V))
    expect(pasted()).toEqual([])
  })

  it('still tries text when the image read itself fails, and says so', async () => {
    readClipboardImagePath.mockRejectedValue(new Error('cannot open the system clipboard'))
    readClipboardText.mockResolvedValue('fallback')
    await press(keydown(CTRL_V))
    expect(pasted()).toEqual(['fallback'])
    const toast = container.querySelector('[data-notice]')
    expect(toast?.textContent).toContain('Paste failed')
    expect(toast?.textContent).toContain('cannot open the system clipboard')
  })

  it('claims Ctrl+Shift+V and Shift+Insert too', async () => {
    readClipboardText.mockResolvedValue('x')
    expect(await press(keydown({ ...CTRL_V, key: 'V', shiftKey: true }))).toBe(false)
    expect(await press(keydown({ code: 'Insert', key: 'Insert', shiftKey: true }))).toBe(false)
    expect(pasted()).toEqual(['x', 'x'])
  })

  it('leaves Ctrl+Alt+V and a bare V to the terminal', async () => {
    expect(await press(keydown({ ...CTRL_V, altKey: true }))).toBe(true)
    expect(await press(keydown({ code: 'KeyV', key: 'v' }))).toBe(true)
    expect(readClipboardImagePath).not.toHaveBeenCalled()
    expect(pasted()).toEqual([])
  })
})
