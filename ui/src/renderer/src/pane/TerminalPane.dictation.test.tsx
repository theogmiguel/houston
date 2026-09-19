// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { ExpandedContext } from '../layout/expandedContext'
import { KeymapOverridesContext } from '../layout/keymapOverridesContext'

vi.mock('../ghostty/surface', () => ghosttySurfaceMockModule())

const pasted = (): string[] => ghosttyMock.pasteSpy.mock.calls.map(([text]) => text)

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

import { configureDictation, resetDictationForTests } from '../voice/dictation'
import { insertVoiceText, resetVoiceStoreForTests } from './../voice/store'
import {
  flushGhosttyAttach,
  ghosttyMock,
  ghosttySurfaceMockModule
} from '../test/ghosttySurfaceMock'

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

describe('TerminalPane × dictation (v55)', () => {
  let container: HTMLDivElement
  let root: Root
  let fakeClient: HoustonClient

  async function render(): Promise<void> {
    act(() => {
      root.render(
        <ExpandedContext.Provider value={null}>
          <KeymapOverridesContext.Provider value={{ bindings: {}, shortcuts_enabled: true }}>
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
      )
    })
    await act(async () => {
      await flushGhosttyAttach()
    })
  }

  const chordDown = (): KeyboardEvent =>
    new KeyboardEvent('keydown', {
      code: 'Space',
      key: ' ',
      ctrlKey: true,
      shiftKey: true,
      cancelable: true
    })
  const chordUp = (): KeyboardEvent =>
    new KeyboardEvent('keyup', { code: 'Space', key: ' ', ctrlKey: true, shiftKey: true })

  beforeEach(() => {
    ghosttyMock.reset()
    resetDictationForTests()
    resetVoiceStoreForTests()
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
    resetDictationForTests()
    resetVoiceStoreForTests()
  })

  it('leaves the chord to xterm while dictation is off', async () => {
    await render()
    expect(ghosttyMock.emitKey(chordDown())).toBe(true)
    expect(ghosttyMock.emitKey(chordUp())).toBe(true)
  })

  it('claims the chord and brackets one capture once dictation is on', async () => {
    const calls: string[] = []
    configureDictation({
      enabled: true,
      captureMode: 'hold',
      start: (s) => calls.push(`start:${s}`),
      stop: (s) => calls.push(`stop:${s}`)
    })
    await render()
    const down = chordDown()
    expect(ghosttyMock.emitKey(down)).toBe(false)
    expect(down.defaultPrevented).toBe(true)
    expect(ghosttyMock.emitKey(chordUp())).toBe(true)
    expect(calls).toEqual(['start:1', 'stop:1'])
  })

  it('ends the hold when a modifier comes up before Space does', async () => {
    const calls: string[] = []
    configureDictation({
      enabled: true,
      captureMode: 'hold',
      start: (s) => calls.push(`start:${s}`),
      stop: (s) => calls.push(`stop:${s}`)
    })
    await render()
    ghosttyMock.emitKey(chordDown())
    ghosttyMock.emitKey(new KeyboardEvent('keyup', { key: 'Control', code: 'ControlLeft' }))
    expect(calls).toEqual(['start:1', 'stop:1'])
  })

  it('inserts through term.paste, never the direct-to-PTY branch', async () => {
    await render()
    expect(insertVoiceText(1, 'rode os testes ')).toBe(true)
    expect(pasted()).toEqual(['rode os testes '])
    expect(fakeClient.sendStdin).not.toHaveBeenCalled()
  })

  it('refuses to insert while the daemon connection is down', async () => {
    act(() => {
      root.render(
        <ExpandedContext.Provider value={null}>
          <KeymapOverridesContext.Provider value={{ bindings: {}, shortcuts_enabled: true }}>
            <TerminalPane
              client={fakeClient}
              info={makeSession()}
              theme="warm-espresso"
              active={false}
              connected={false}
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
      )
    })
    expect(insertVoiceText(1, 'dropped ')).toBe(false)
    expect(pasted()).toEqual([])
  })

  it('unmounting unregisters the pane, so a disposed xterm is never reached', async () => {
    await render()
    expect(insertVoiceText(1, 'a ')).toBe(true)
    act(() => root.unmount())
    expect(insertVoiceText(1, 'b ')).toBe(false)
    root = createRoot(container)
  })
})
