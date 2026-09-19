// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readDropEntries, dragCarriesFiles, FILE_PATH_MIME } from '../pane/dropTransfer'

const { listenMock } = vi.hoisted(() => ({ listenMock: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

const { isTauriMock } = vi.hoisted(() => ({ isTauriMock: vi.fn(() => true) }))
vi.mock('./host', () => ({ isTauri: () => isTauriMock() }))

const { fileDataTransfer, toCssPoint, installNativeFileDrop } = await import('./nativeFileDrop')

describe('toCssPoint', () => {
  it('divides a physical position by the device pixel ratio', () => {
    expect(toCssPoint({ x: 400, y: 200 }, 2)).toEqual({ x: 200, y: 100 })
  })

  it('passes a 1x position through', () => {
    expect(toCssPoint({ x: 37, y: 91 }, 1)).toEqual({ x: 37, y: 91 })
  })

  it('rounds a fractional-scaling result to a whole pixel', () => {
    expect(toCssPoint({ x: 300, y: 150 }, 1.5)).toEqual({ x: 200, y: 100 })
  })

  it('treats a zero or negative ratio as 1 rather than collapsing to the origin', () => {
    expect(toCssPoint({ x: 400, y: 200 }, 0)).toEqual({ x: 400, y: 200 })
    expect(toCssPoint({ x: 400, y: 200 }, -2)).toEqual({ x: 400, y: 200 })
  })
})

describe('fileDataTransfer', () => {
  it('carries the paths newline-separated under application/x-file-path', () => {
    const dt = fileDataTransfer(['/tmp/a.png', '/tmp/b.png'])
    expect(dt.getData(FILE_PATH_MIME)).toBe('/tmp/a.png\n/tmp/b.png')
  })

  it('marks the drag a copy', () => {
    expect(fileDataTransfer(['/tmp/a']).effectAllowed).toBe('copy')
  })

  it('is accepted by the drag gate and read back by the extractor', () => {
    const dt = fileDataTransfer(['/home/dev/shot.png'])
    expect(dragCarriesFiles(dt)).toBe(true)
    expect(readDropEntries(dt)).toEqual([{ path: '/home/dev/shot.png' }])
  })

  it('round-trips a path containing spaces and non-ASCII characters', () => {
    const dt = fileDataTransfer(['/tmp/my shot 日本.png'])
    expect(readDropEntries(dt)).toEqual([{ path: '/tmp/my shot 日本.png' }])
  })

  it('yields no entries for an empty drop rather than one blank path', () => {
    expect(readDropEntries(fileDataTransfer([]))).toEqual([])
  })
})

describe('installNativeFileDrop', () => {
  function captureListeners(): Map<string, (e: { payload: unknown }) => void> {
    const handlers = new Map<string, (e: { payload: unknown }) => void>()
    listenMock.mockImplementation((name: string, handler: (e: { payload: unknown }) => void) => {
      handlers.set(name, handler)
      return Promise.resolve(() => {})
    })
    return handlers
  }

  function elementUnderPointer(el: Element | null): void {
    Object.defineProperty(document, 'elementFromPoint', {
      value: () => el,
      configurable: true
    })
  }

  afterEach(() => {
    listenMock.mockReset()
    isTauriMock.mockReturnValue(true)
    Reflect.deleteProperty(document, 'elementFromPoint')
    document.body.replaceChildren()
  })

  it('subscribes to nothing under Electron — the DOM already carries the drop', async () => {
    isTauriMock.mockReturnValue(false)
    await installNativeFileDrop()
    expect(listenMock).not.toHaveBeenCalled()
  })

  it('replays a native drop as a DOM drop event on the element under the pointer', async () => {
    const handlers = captureListeners()
    const pane = document.createElement('div')
    document.body.appendChild(pane)
    elementUnderPointer(pane)
    await installNativeFileDrop()

    const seen: Array<string[]> = []
    pane.addEventListener('drop', (e) => {
      const dt = (e as DragEvent & { dataTransfer: unknown }).dataTransfer
      seen.push(readDropEntries(dt as never).map((entry) => entry.path!))
    })

    handlers.get('tauri://drag-drop')!({
      payload: { paths: ['/tmp/a.png', '/tmp/b.png'], position: { x: 100, y: 50 } }
    })

    expect(seen).toEqual([['/tmp/a.png', '/tmp/b.png']])
  })

  it('replays enter and leave so a pane overlay keyed on the pair still balances', async () => {
    const handlers = captureListeners()
    const pane = document.createElement('div')
    document.body.appendChild(pane)
    elementUnderPointer(pane)
    await installNativeFileDrop()

    const kinds: string[] = []
    for (const kind of ['dragenter', 'dragover', 'dragleave']) {
      pane.addEventListener(kind, () => kinds.push(kind))
    }

    handlers.get('tauri://drag-enter')!({
      payload: { paths: ['/tmp/a'], position: { x: 10, y: 10 } }
    })
    handlers.get('tauri://drag-over')!({ payload: { position: { x: 12, y: 12 } } })
    handlers.get('tauri://drag-leave')!({ payload: {} })

    expect(kinds).toEqual(['dragenter', 'dragover', 'dragleave'])
  })

  it('ignores a drop with no element under it instead of throwing', async () => {
    const handlers = captureListeners()
    elementUnderPointer(null)
    await installNativeFileDrop()
    expect(() =>
      handlers.get('tauri://drag-drop')!({
        payload: { paths: ['/tmp/a'], position: { x: 0, y: 0 } }
      })
    ).not.toThrow()
  })
})
