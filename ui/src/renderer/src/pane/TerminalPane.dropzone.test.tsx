// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { ExpandedContext } from '../layout/expandedContext'
import type { TermActions } from './TerminalPane'
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

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get: () => 400
})
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get: () => 300
})

let resolveDroppedFile = vi.fn<(f: File) => Promise<string | null>>()
vi.mock('../houston/bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../houston/bridge')>()),
  resolveDroppedFile: (f: File) => resolveDroppedFile(f)
}))

let saveImageResolve: (() => void) | null = null
let saveImageResolvers: Array<() => void> = []
const saveImage = vi.fn(
  (_bytes: Uint8Array, _ext: string) =>
    new Promise<string>((resolve) => {
      const r = (): void => resolve('/tmp/a.png')
      saveImageResolve = r
      saveImageResolvers.push(r)
    })
)
window.houston = {
  pathKind: vi.fn().mockResolvedValue(null),
  openExternal: vi.fn(),
  saveImage: (bytes: Uint8Array, ext: string) => saveImage(bytes, ext)
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

function fileItem(type: string): { kind: 'file'; type: string } {
  return { kind: 'file', type }
}

function dragEvent(
  type: string,
  items: Array<{ kind: 'file'; type: string }>,
  files: File[] = [],
  data: Record<string, string> = {}
): Event {
  const e = new Event(type, { bubbles: true, cancelable: true })
  const stringTypes = Object.keys(data)
  const carriesFiles = items.length > 0 || files.length > 0
  Object.defineProperty(e, 'dataTransfer', {
    value: {
      types: carriesFiles ? ['Files', ...stringTypes] : stringTypes,
      items: items.map((i) => ({ ...i, getAsFile: () => null })),
      files,
      getData: (t: string) => data[t] ?? ''
    },
    configurable: true
  })
  return e
}

function fakeFile(name: string, type: string): File {
  return new File(['x'], name, { type })
}

describe('TerminalPane drop-zone overlay (Q8)', () => {
  let container: HTMLDivElement
  let root: Root
  let fakeClient: HoustonClient
  let actionsRef: { current: TermActions | null }

  async function render(): Promise<void> {
    act(() => {
      root.render(
        <StrictMode>
          <ExpandedContext.Provider value={null}>
            <TerminalPane
              client={fakeClient}
              info={makeSession()}
              theme="warm-espresso"
              active={false}
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
              actions={actionsRef}
            />
          </ExpandedContext.Provider>
        </StrictMode>
      )
    })
    await act(async () => {
      await flushGhosttyAttach()
    })
  }

  function host(): HTMLElement {
    const el = container.querySelector('.term-host') as HTMLElement | null
    if (!el) throw new Error('.term-host not found')
    return el
  }

  function dropzone(): HTMLElement | null {
    return container.querySelector('.term-dropzone')
  }

  beforeEach(async () => {
    resolveDroppedFile = vi.fn<(f: File) => Promise<string | null>>().mockResolvedValue(null)
    ghosttyMock.reset()
    saveImage.mockClear()
    saveImageResolve = null
    saveImageResolvers = []
    actionsRef = { current: null }
    fakeClient = {
      resizeSession: vi.fn(),
      attachSession: vi.fn(),
      sessionVisibility: vi.fn(),
      sendStdin: vi.fn()
    } as unknown as HoustonClient
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await render()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('shows the singular label for a single-file drag', async () => {
    act(() => host().dispatchEvent(dragEvent('dragenter', [fileItem('text/plain')])))
    expect(dropzone()?.textContent).toContain('Drop to paste path')
    expect(dropzone()?.querySelector('[data-testid="dropzone-icon-file"]')).not.toBeNull()
  })

  it('shows the plural label with the count for a multi-file drag', async () => {
    act(() =>
      host().dispatchEvent(
        dragEvent('dragenter', [fileItem('text/plain'), fileItem('text/plain')])
      )
    )
    act(() =>
      host().dispatchEvent(
        dragEvent('dragover', [fileItem('text/plain'), fileItem('text/plain')])
      )
    )
    expect(dropzone()?.textContent).toContain('Drop to paste 2 paths')
  })

  describe('a uri-list-only drag (the WebKitGTK file-manager shape)', () => {
    const URI_LIST = 'text/uri-list'

    it('lights the overlay even though no Files type is advertised', async () => {
      act(() =>
        host().dispatchEvent(dragEvent('dragenter', [], [], { [URI_LIST]: 'file:///tmp/a.txt' }))
      )
      expect(dropzone()).not.toBeNull()
      expect(dropzone()?.textContent).toContain('Drop to paste path')
    })

    it('accepts the dragover, which is what stops WebKit navigating to the file', async () => {
      const e = dragEvent('dragover', [], [], { [URI_LIST]: 'file:///tmp/a.txt' })
      act(() => {
        host().dispatchEvent(e)
      })
      expect(e.defaultPrevented).toBe(true)
    })

    it('pastes the uri-list path without a host round trip', async () => {
      await act(async () => {
        host().dispatchEvent(
          dragEvent('drop', [], [], { [URI_LIST]: 'file:///tmp/my%20shot.png' })
        )
      })
      expect(pasted()).toEqual(["'/tmp/my shot.png' "])
      expect(resolveDroppedFile).not.toHaveBeenCalled()
    })
  })

  it('shows the image icon while dragging an image', async () => {
    act(() => host().dispatchEvent(dragEvent('dragenter', [fileItem('image/png')])))
    expect(dropzone()?.querySelector('[data-testid="dropzone-icon-image"]')).not.toBeNull()
    expect(dropzone()?.textContent).toContain('Drop to paste path')
  })

  it('shows "Copying…" with the spinner while an image drop is pending, then resolves back to hidden', async () => {
    resolveDroppedFile.mockResolvedValue(null)
    act(() => host().dispatchEvent(dragEvent('dragenter', [fileItem('image/png')])))

    await act(async () => {
      host().dispatchEvent(dragEvent('drop', [fileItem('image/png')], [fakeFile('a.png', 'image/png')]))
    })

    expect(dropzone()?.textContent).toContain('Copying…')
    expect(dropzone()?.querySelector('[data-testid="dropzone-icon-busy"]')).not.toBeNull()

    await act(async () => {
      saveImageResolve?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(dropzone()).toBeNull()
  })

  it('keeps "Copying…" up across overlapping drops until the LAST one settles', async () => {
    resolveDroppedFile.mockResolvedValue(null)

    act(() => host().dispatchEvent(dragEvent('dragenter', [fileItem('image/png')])))
    await act(async () => {
      host().dispatchEvent(dragEvent('drop', [fileItem('image/png')], [fakeFile('a.png', 'image/png')]))
    })
    expect(dropzone()?.textContent).toContain('Copying…')
    expect(saveImageResolvers).toHaveLength(1)
    const resolveFirst = saveImageResolvers[0]

    await act(async () => {
      host().dispatchEvent(dragEvent('drop', [fileItem('image/png')], [fakeFile('b.png', 'image/png')]))
    })
    expect(saveImageResolvers).toHaveLength(2)
    const resolveSecond = saveImageResolvers[1]

    await act(async () => {
      resolveFirst()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(dropzone()?.textContent).toContain('Copying…')

    await act(async () => {
      resolveSecond()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(dropzone()).toBeNull()
  })

  it('clears the overlay when an image save fails, instead of stranding "Copying…"', async () => {
    resolveDroppedFile.mockResolvedValue(null)
    saveImage.mockImplementationOnce(() => Promise.reject(new Error('disk full')))

    await act(async () => {
      host().dispatchEvent(
        dragEvent('drop', [fileItem('image/png')], [fakeFile('a.png', 'image/png')])
      )
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(dropzone()).toBeNull()
    const toast = container.querySelector('[data-notice]')
    expect(toast?.textContent).toContain('disk full')
  })

  it('pastes multi-file drops in drop order even when the later file resolves first', async () => {
    let resolveFirst: (p: string) => void = () => {}
    resolveDroppedFile
      .mockImplementationOnce(
        () =>
          new Promise<string | null>((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValueOnce('/tmp/b.txt')

    await act(async () => {
      host().dispatchEvent(
        dragEvent(
          'drop',
          [fileItem('text/plain'), fileItem('text/plain')],
          [fakeFile('a.txt', 'text/plain'), fakeFile('b.txt', 'text/plain')]
        )
      )
    })
    expect(pasted()).toEqual([])

    await act(async () => {
      resolveFirst('/tmp/a.txt')
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(pasted()).toEqual(["'/tmp/a.txt' ", "'/tmp/b.txt' "])
  })
})
