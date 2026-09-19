// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import type { RegisterOutput } from './TerminalPane'
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

describe('a pane says when a keystroke would actually reach the PTY', () => {
  let container: HTMLDivElement
  let root: Root
  let fakeClient: HoustonClient

  beforeEach(() => {
    ghosttyMock.reset()
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

  function render(props: { active: boolean; connected: boolean }): void {
    const registerOutput: RegisterOutput = () => () => {}
    act(() => {
      root.render(
        <TerminalPane
          client={fakeClient}
          info={makeSession()}
          theme="warm-espresso"
          active={props.active}
          connected={props.connected}
          fontSize={13}
          copyOnSelect={false}
          stripBoxGlyphs={true}
          registerOutput={registerOutput}
          onActivate={() => {}}
          onZoom={() => {}}
          onShellZoom={() => {}}
          onOpenFile={() => {}}
          onOpenDir={() => {}}
        />
      )
    })
  }

  async function mount(props: { active: boolean; connected: boolean }): Promise<void> {
    render(props)
    await act(async () => {
      await flushGhosttyAttach()
    })
  }

  const typeable = (): boolean => container.querySelector('[data-typeable]') !== null

  it('is not typeable while the engine is still loading, however focused it looks', async () => {
    let releaseSurface: (() => void) | null = null
    ghosttyMock.gate = () => {}
    render({ active: true, connected: true })
    await act(async () => {
      await flushGhosttyAttach()
    })
    expect(typeable()).toBe(false)

    releaseSurface = ghosttyMock.gate
    await act(async () => {
      releaseSurface?.()
      await flushGhosttyAttach()
    })
    expect(typeable()).toBe(true)
  })

  it('is typeable once the engine is live, this pane is focused and the daemon is up', async () => {
    await mount({ active: true, connected: true })
    expect(typeable()).toBe(true)
  })

  it('an unfocused pane is never typeable, engine or no engine', async () => {
    await mount({ active: false, connected: true })
    expect(typeable()).toBe(false)
  })

  it('a focused pane with no daemon link is not typeable', async () => {
    await mount({ active: true, connected: false })
    expect(typeable()).toBe(false)
  })

  it('losing focus takes it back', async () => {
    await mount({ active: true, connected: true })
    expect(typeable()).toBe(true)
    render({ active: false, connected: true })
    expect(typeable()).toBe(false)
  })

  it('a reconnect brings it back without remounting the engine', async () => {
    await mount({ active: true, connected: false })
    expect(typeable()).toBe(false)
    render({ active: true, connected: true })
    expect(typeable()).toBe(true)
    expect(ghosttyMock.createCount).toBe(1)
  })
})
