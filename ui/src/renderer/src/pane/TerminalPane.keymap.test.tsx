// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import type { KeymapOverrides } from '../houston/generated/KeymapOverrides'
import { ExpandedContext } from '../layout/expandedContext'
import { KeymapOverridesContext } from '../layout/keymapOverridesContext'
import { setPaneCapsForTests } from '../paneCaps'
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
