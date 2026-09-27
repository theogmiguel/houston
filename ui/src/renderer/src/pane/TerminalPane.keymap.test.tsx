// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import type { KeymapOverrides } from '../houston/generated/KeymapOverrides'
import { ExpandedContext } from '../layout/expandedContext'
import { KeymapOverridesContext } from '../layout/keymapOverridesContext'
import { setPaneCapsForTests } from '../paneCaps'
import { prefixLayer } from '../prefixLayer'
import {
  flushGhosttyAttach,
  ghosttyMock,
  ghosttySurfaceMockModule
} from '../test/ghosttySurfaceMock'

vi.mock('../ghostty/surface', () => ghosttySurfaceMockModule())

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get: () => 400
})
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get: () => 300
})

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

describe('TerminalPane zoom/font chord seam (P4 #16)', () => {
  let container: HTMLDivElement
  let root: Root
  let fakeClient: HoustonClient
  let onShellZoom: ReturnType<typeof vi.fn<(dir: 1 | -1 | 0) => void>>
  let onZoom: ReturnType<typeof vi.fn<(dir: 1 | -1 | 0) => void>>

  async function render(overrides: KeymapOverrides): Promise<void> {
    act(() => {
      root.render(
        <StrictMode>
          <ExpandedContext.Provider value={null}>
            <KeymapOverridesContext.Provider value={overrides}>
              <TerminalPane
                client={fakeClient}
                info={makeSession()}
                theme="warm-espresso"
                active={false}
                connected={true}
                fontSize={13}
                copyOnSelect={false}
                stripBoxGlyphs={true}
                registerOutput={() => () => {}}
                onActivate={() => {}}
                onZoom={onZoom}
                onShellZoom={onShellZoom}
                onOpenFile={() => {}}
                onOpenDir={() => {}}
              />
            </KeymapOverridesContext.Provider>
          </ExpandedContext.Provider>
        </StrictMode>
      )
    })
    await act(async () => {
      await flushGhosttyAttach()
    })
  }

  beforeEach(() => {
    ghosttyMock.reset()
    onShellZoom = vi.fn()
    onZoom = vi.fn()
    fakeClient = {
      resizeSession: vi.fn(),
      attachSession: vi.fn(),
      sessionVisibility: vi.fn(),
      sendStdin: vi.fn()
    } as unknown as HoustonClient
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('honors the built-in Ctrl+= chord when no override is set', async () => {
    await render({ bindings: {}, shortcuts_enabled: true })
    const handled = ghosttyMock.emitKey(
      new KeyboardEvent('keydown', { code: 'Equal', ctrlKey: true })
    )
    expect(handled).toBe(false)
    expect(onShellZoom).toHaveBeenCalledWith(1)
  })

  it('stops responding to the built-in chord and responds to the remapped one instead', async () => {
    await render({
      bindings: {
        'zoom-in': { code: 'KeyJ', ctrl: true, alt: false, shift: true, meta: false }
      },
      shortcuts_enabled: true
    })

    const oldResult = ghosttyMock.emitKey(
      new KeyboardEvent('keydown', { code: 'Equal', ctrlKey: true })
    )
    expect(oldResult).toBe(true)
    expect(onShellZoom).not.toHaveBeenCalled()

    const newResult = ghosttyMock.emitKey(
      new KeyboardEvent('keydown', { code: 'KeyJ', ctrlKey: true, shiftKey: true })
    )
    expect(newResult).toBe(false)
    expect(onShellZoom).toHaveBeenCalledWith(1)
  })

  it('leaves the fixed terminal chords (Ctrl+F) alone regardless of overrides', async () => {
    await render({ bindings: {}, shortcuts_enabled: true })
    const handled = ghosttyMock.emitKey(
      new KeyboardEvent('keydown', { code: 'KeyF', key: 'f', ctrlKey: true })
    )
    expect(handled).toBe(false)
    expect(onShellZoom).not.toHaveBeenCalled()
    expect(onZoom).not.toHaveBeenCalled()
  })

  describe('master kill-switch (P4 #17)', () => {
    it('does not consume the built-in zoom chord while shortcuts are disabled — it reaches the PTY', async () => {
      await render({ bindings: {}, shortcuts_enabled: false })
      const handled = ghosttyMock.emitKey(
        new KeyboardEvent('keydown', { code: 'Equal', ctrlKey: true })
      )
      expect(handled).toBe(true)
      expect(onShellZoom).not.toHaveBeenCalled()
    })

    it('resumes consuming the chord the instant shortcuts are re-enabled', async () => {
      await render({ bindings: {}, shortcuts_enabled: true })
      const handled = ghosttyMock.emitKey(
        new KeyboardEvent('keydown', { code: 'Equal', ctrlKey: true })
      )
      expect(handled).toBe(false)
      expect(onShellZoom).toHaveBeenCalledWith(1)
    })

    it('does not consume a remapped chord either while shortcuts are disabled', async () => {
      await render({
        bindings: {
          'font-zoom-in': { code: 'KeyJ', ctrl: true, alt: true, shift: false, meta: false }
        },
        shortcuts_enabled: false
      })
      const handled = ghosttyMock.emitKey(
        new KeyboardEvent('keydown', { code: 'KeyJ', ctrlKey: true, altKey: true })
      )
      expect(handled).toBe(true)
      expect(onZoom).not.toHaveBeenCalled()
    })

    it('leaves the fixed terminal chords (Ctrl+F) consumed even while shortcuts are disabled', async () => {
      await render({ bindings: {}, shortcuts_enabled: false })
      const handled = ghosttyMock.emitKey(
        new KeyboardEvent('keydown', { code: 'KeyF', key: 'f', ctrlKey: true })
      )
      expect(handled).toBe(false)
    })
  })

  describe('pass keys through to the terminal (settings-20)', () => {
    beforeEach(() => setPaneCapsForTests({ passThrough: false }))
    afterEach(() => setPaneCapsForTests({ passThrough: false }))

    it('OFF (the default): a governed chord keeps its chrome meaning', async () => {
      await render({ bindings: {}, shortcuts_enabled: true })
      const handled = ghosttyMock.emitKey(
        new KeyboardEvent('keydown', { code: 'Equal', ctrlKey: true })
      )
      expect(handled).toBe(false)
      expect(onShellZoom).toHaveBeenCalledWith(1)
    })

    it('ON: the same governed chord reaches the terminal instead', async () => {
      setPaneCapsForTests({ passThrough: true })
      await render({ bindings: {}, shortcuts_enabled: true })
      const handled = ghosttyMock.emitKey(
        new KeyboardEvent('keydown', { code: 'Equal', ctrlKey: true })
      )
      expect(handled).toBe(true)
      expect(onShellZoom).not.toHaveBeenCalled()
    })

    it('ON: a REMAPPED governed chord passes through too — the pref is not chord-shaped', async () => {
      setPaneCapsForTests({ passThrough: true })
      await render({
        bindings: {
          'font-zoom-in': { code: 'KeyJ', ctrl: true, alt: true, shift: false, meta: false }
        },
        shortcuts_enabled: true
      })
      const handled = ghosttyMock.emitKey(
        new KeyboardEvent('keydown', { code: 'KeyJ', ctrlKey: true, altKey: true })
      )
      expect(handled).toBe(true)
      expect(onZoom).not.toHaveBeenCalled()
    })

    it('ON: Houston\'s reserved terminal chords still win — Ctrl+F still opens Find', async () => {
      setPaneCapsForTests({ passThrough: true })
      await render({ bindings: {}, shortcuts_enabled: true })
      const handled = ghosttyMock.emitKey(
        new KeyboardEvent('keydown', { code: 'KeyF', key: 'f', ctrlKey: true })
      )
      expect(handled).toBe(false)
    })

    it('turning it back OFF restores the chord without a remount', async () => {
      setPaneCapsForTests({ passThrough: true })
      await render({ bindings: {}, shortcuts_enabled: true })
      expect(
        ghosttyMock.emitKey(new KeyboardEvent('keydown', { code: 'Equal', ctrlKey: true }))
      ).toBe(true)
      setPaneCapsForTests({ passThrough: false })
      expect(
        ghosttyMock.emitKey(new KeyboardEvent('keydown', { code: 'Equal', ctrlKey: true }))
      ).toBe(false)
      expect(onShellZoom).toHaveBeenCalledWith(1)
    })
  })
})

describe('TerminalPane prefix layer', () => {
  let container: HTMLDivElement
  let root: Root
  let fakeClient: HoustonClient

  async function render(
    overrides: KeymapOverrides = { bindings: {}, shortcuts_enabled: true }
  ): Promise<void> {
    act(() => {
      root.render(
        <StrictMode>
          <ExpandedContext.Provider value={null}>
            <KeymapOverridesContext.Provider value={overrides}>
              <TerminalPane
                client={fakeClient}
                info={makeSession()}
                theme="warm-espresso"
                active={false}
                connected={true}
                fontSize={13}
                copyOnSelect={false}
                stripBoxGlyphs={true}
                registerOutput={() => () => {}}
                onActivate={() => {}}
                onZoom={() => {}}
                onShellZoom={() => {}}
                onOpenFile={() => {}}
                onOpenDir={() => {}}
              />
            </KeymapOverridesContext.Provider>
          </ExpandedContext.Provider>
        </StrictMode>
      )
    })
    await act(async () => {
      await flushGhosttyAttach()
    })
  }

  beforeEach(() => {
    ghosttyMock.reset()
    prefixLayer.disarm()
    fakeClient = {
      resizeSession: vi.fn(),
      attachSession: vi.fn(),
      sessionVisibility: vi.fn(),
      sendStdin: vi.fn()
    } as unknown as HoustonClient
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    prefixLayer.disarm()
    act(() => root.unmount())
    container.remove()
  })

  it('Ctrl+Space arms the layer and is not sent to the terminal', async () => {
    await render()
    const handled = ghosttyMock.emitKey(
      new KeyboardEvent('keydown', { code: 'Space', key: ' ', ctrlKey: true })
    )
    expect(handled).toBe(false)
    expect(prefixLayer.isArmed()).toBe(true)
  })

  it('the key after the prefix is consumed and re-emitted on window for the app', async () => {
    await render()
    ghosttyMock.emitKey(new KeyboardEvent('keydown', { code: 'Space', key: ' ', ctrlKey: true }))
    const got: KeyboardEvent[] = []
    const on = (e: Event): void => {
      got.push(e as KeyboardEvent)
    }
    window.addEventListener('keydown', on)
    const handled = ghosttyMock.emitKey(new KeyboardEvent('keydown', { code: 'KeyN', key: 'n' }))
    window.removeEventListener('keydown', on)
    expect(handled).toBe(false)
    expect(got.map((e) => e.key)).toEqual(['n'])
  })

  it('a second Ctrl+Space disarms and lets the chord reach the terminal', async () => {
    await render()
    ghosttyMock.emitKey(new KeyboardEvent('keydown', { code: 'Space', key: ' ', ctrlKey: true }))
    const handled = ghosttyMock.emitKey(
      new KeyboardEvent('keydown', { code: 'Space', key: ' ', ctrlKey: true })
    )
    expect(handled).toBe(true)
    expect(prefixLayer.isArmed()).toBe(false)
  })

  it('agent keys reach the terminal: the prefix is the only chord the layer reserves', async () => {
    await render()
    const agentKeys: KeyboardEventInit[] = [
      { code: 'Escape', key: 'Escape' },
      { code: 'KeyC', key: 'c', ctrlKey: true },
      { code: 'Tab', key: 'Tab', shiftKey: true },
      { code: 'KeyB', key: 'b', ctrlKey: true },
      { code: 'KeyK', key: 'k', ctrlKey: true },
      { code: 'KeyL', key: 'l', ctrlKey: true },
      { code: 'KeyR', key: 'r', ctrlKey: true }
    ]
    for (const init of agentKeys) {
      const handled = ghosttyMock.emitKey(new KeyboardEvent('keydown', { cancelable: true, ...init }))
      expect({ key: init.code, handled }).toEqual({ key: init.code, handled: true })
      expect(prefixLayer.isArmed()).toBe(false)
    }
  })

  it('a rebound prefix arms the layer and Ctrl+Space goes back to the terminal', async () => {
    await render({
      bindings: { prefix: { code: 'KeyA', ctrl: true, alt: true, shift: false, meta: false } },
      shortcuts_enabled: true
    })
    expect(
      ghosttyMock.emitKey(new KeyboardEvent('keydown', { code: 'Space', key: ' ', ctrlKey: true }))
    ).toBe(true)
    expect(prefixLayer.isArmed()).toBe(false)
    expect(
      ghosttyMock.emitKey(
        new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', ctrlKey: true, altKey: true })
      )
    ).toBe(false)
    expect(prefixLayer.isArmed()).toBe(true)
  })

  it('pass-through keeps the prefix: it still arms while other governed chords reach the terminal', async () => {
    setPaneCapsForTests({ passThrough: true })
    try {
      await render()
      expect(
        ghosttyMock.emitKey(new KeyboardEvent('keydown', { code: 'Equal', ctrlKey: true }))
      ).toBe(true)
      expect(
        ghosttyMock.emitKey(new KeyboardEvent('keydown', { code: 'Space', key: ' ', ctrlKey: true }))
      ).toBe(false)
      expect(prefixLayer.isArmed()).toBe(true)
    } finally {
      setPaneCapsForTests({ passThrough: false })
    }
  })

  it('a bare modifier while armed keeps the layer armed', async () => {
    await render()
    ghosttyMock.emitKey(new KeyboardEvent('keydown', { code: 'Space', key: ' ', ctrlKey: true }))
    ghosttyMock.emitKey(new KeyboardEvent('keydown', { code: 'ShiftLeft', key: 'Shift', shiftKey: true }))
    expect(prefixLayer.isArmed()).toBe(true)
  })
})
