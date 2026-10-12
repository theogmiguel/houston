// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import type { OutputSink, RegisterOutput } from './TerminalPane'
import { flushGhosttyAttach, ghosttyMock, ghosttySurfaceMockModule } from '../test/ghosttySurfaceMock'

const readOnly = vi.hoisted(() => vi.fn())
vi.mock('../ghostty/surface', () => {
  const mock = ghosttySurfaceMockModule()
  return {
    GhosttyTerminalSurface: {
      create: async (host: HTMLElement, options: Record<string, unknown>) => ({
        ...await mock.GhosttyTerminalSurface.create(host, options) as object,
        setReadOnly: readOnly
      })
    }
  }
})

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver

const { TerminalPane } = await import('./TerminalPane')
const encoder = new TextEncoder()

function client(): HoustonClient {
  return {
    resizeSession: vi.fn(),
    attachSession: vi.fn(),
    sessionVisibility: vi.fn(),
    sendStdin: vi.fn()
  } as unknown as HoustonClient
}

function session(state: SessionInfo['state']): SessionInfo {
  return {
    id: 7,
    agent: 'claude',
    project_dir: '/tmp/project',
    cwd: '/tmp/project',
    title: 'retained pane',
    title_source: 'user',
    hidden: false,
    codename: 'test',
    live_children: 0,
    children_waiting: 0,
    inbox_unread: 0,
    tags: [],
    resumable: true,
    state,
    status: state === 'running' ? 'working' : null,
    restore_deferred: state === 'interrupted' ? 'safe-mode' : null
  }
}

describe('retained output for ended panes', () => {
  let container: HTMLDivElement
  let root: Root
  let sink: OutputSink
  const registerOutput: RegisterOutput = (_id, output) => {
    sink = output
    return () => {}
  }

  beforeEach(() => {
    ghosttyMock.reset()
    readOnly.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function render(c: HoustonClient, state: SessionInfo['state'], connected = true): Promise<void> {
    await act(async () => {
      root.render(
        <TerminalPane
          client={c} info={session(state)} active connected={connected}
          theme="warm-espresso" fontSize={13} copyOnSelect={false} stripBoxGlyphs={false}
          registerOutput={registerOutput} onActivate={() => {}} onZoom={() => {}}
          onShellZoom={() => {}} onOpenFile={() => {}} onOpenDir={() => {}}
        />
      )
      await flushGhosttyAttach()
    })
  }

  async function replay(text: string): Promise<void> {
    const bytes = encoder.encode(text)
    await act(async () => {
      sink.replay(bytes, bytes.length)
      await flushGhosttyAttach()
    })
    expect(ghosttyMock.writeSpy).toHaveBeenCalledWith(bytes)
  }

  function expectReadOnly(c: HoustonClient): void {
    expect(container.querySelector('[data-typeable]')).toBeNull()
    expect(readOnly).toHaveBeenLastCalledWith(true)
    act(() => {
      ghosttyMock.emitData('must not reach the PTY')
      ghosttyMock.emitResize(120, 40)
      window.dispatchEvent(new Event('focus'))
    })
    expect(c.sendStdin).not.toHaveBeenCalled()
    expect(c.resizeSession).not.toHaveBeenCalled()
  }

  it.each(['exited', 'interrupted'] as const)('attaches an initially %s pane for retained output without input or PTY resize', async (state) => {
    const c = client()
    await render(c, state)
    expect(c.attachSession).toHaveBeenCalledOnce()
    await replay('final output retained before mount\r\n')
    expectReadOnly(c)
  })

  it.each(['exited', 'interrupted'] as const)('reattaches the same ID when a new client reports %s after disconnect', async (state) => {
    const previous = client()
    await render(previous, 'running')
    await replay('before disconnect\r\n')
    await render(previous, 'running', false)

    const replacement = client()
    await render(replacement, state)
    expect(ghosttyMock.createCount).toBe(1)
    expect(ghosttyMock.resetSpy).toHaveBeenCalledOnce()
    expect(replacement.attachSession).toHaveBeenCalledWith(7, expect.any(Number), undefined, undefined)
    await replay('before disconnect\r\nfinal output while disconnected\r\n')
    expectReadOnly(replacement)
    expect(previous.attachSession).toHaveBeenCalledOnce()
  })
})
