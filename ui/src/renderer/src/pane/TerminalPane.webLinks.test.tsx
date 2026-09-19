// @vitest-environment jsdom
import { act } from 'react'
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

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get: () => 400
})
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get: () => 300
})

const pathKind = vi.fn().mockResolvedValue('file')
window.houston = {
  pathKind,
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

async function hoverCell(row: string, column: number): Promise<{ text: string } | null> {
  ghosttyMock.gridRows = [row]
  await act(async () => {
    ghosttyMock.emitResolveLink(0, column)
    await flushGhosttyAttach()
  })
  return ghosttyMock.emitResolveLink(0, column)
}

describe('TerminalPane link providers (review finding 4)', () => {
  let container: HTMLDivElement
  let root: Root
  let fakeClient: HoustonClient

  beforeEach(() => {
    ghosttyMock.reset()
    pathKind.mockClear()
    vi.mocked(window.houston.openExternal).mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    fakeClient = {
      resizeSession: vi.fn(),
      attachSession: vi.fn(),
      sessionVisibility: vi.fn(),
      sendStdin: vi.fn()
    } as unknown as HoustonClient
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function render(
    row15: { openLinksInPane?: boolean; onOpenUrlInPane?: (url: string) => void } = {}
  ): Promise<void> {
    act(() => {
      root.render(
        <ExpandedContext.Provider value={null}>
          <TerminalPane
            openLinksInPane={row15.openLinksInPane}
            onOpenUrlInPane={row15.onOpenUrlInPane}
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
        </ExpandedContext.Provider>
      )
    })
    await act(async () => {
      await flushGhosttyAttach()
    })
  }

  it('has both link kinds live on the same row', async () => {
    await render()
    const line = 'see https://example.com/x and src/index.ts'
    expect(await hoverCell(line, line.indexOf('https://'))).toMatchObject({
      text: 'https://example.com/x'
    })
    expect(await hoverCell(line, line.indexOf('src/index.ts'))).toMatchObject({
      text: 'src/index.ts'
    })
  })

  it('resolves no links, and queries no paths, after unmount', async () => {
    await render()
    act(() => root.unmount())
    pathKind.mockClear()

    expect(await hoverCell('see src/index.ts for details', 4)).toBeNull()
    expect(pathKind).not.toHaveBeenCalled()

    root = createRoot(container)
  })

  it('declines a file-path candidate that overlaps a URL match on the same line', async () => {
    await render()
    const line = 'fetch https://example.com/foo.js now'

    const hovered = await hoverCell(line, line.indexOf('example.com'))
    expect(pathKind).not.toHaveBeenCalled()
    expect(hovered).toMatchObject({ text: 'https://example.com/foo.js' })
  })

  it('still offers a genuine file-path candidate with no URL on the line', async () => {
    await render()
    const line = 'see src/only-here.ts for details'
    expect(await hoverCell(line, line.indexOf('src/only-here.ts'))).toMatchObject({
      text: 'src/only-here.ts'
    })
    expect(pathKind).toHaveBeenCalled()
  })

  async function activateFirstUrl(): Promise<void> {
    const line = 'see https://example.com/x now'
    const link = await hoverCell(line, line.indexOf('https://'))
    expect(link).toMatchObject({ text: 'https://example.com/x' })
    ghosttyMock.emitLinkActivate('https://example.com/x')
  }

  it('opens in the system browser by default', async () => {
    await render()
    await activateFirstUrl()
    expect(window.houston.openExternal).toHaveBeenCalledWith('https://example.com/x')
  })

  it('opens in a pane when the setting is on', async () => {
    const opened: string[] = []
    await render({ openLinksInPane: true, onOpenUrlInPane: (u) => opened.push(u) })
    await activateFirstUrl()
    expect(opened).toEqual(['https://example.com/x'])
    expect(window.houston.openExternal).not.toHaveBeenCalled()
  })

  it('falls back to the system browser when no pane destination exists', async () => {
    await render({ openLinksInPane: true })
    await activateFirstUrl()
    expect(window.houston.openExternal).toHaveBeenCalledWith('https://example.com/x')
  })
})
