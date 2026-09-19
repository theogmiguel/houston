// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { isTauriMock } = vi.hoisted(() => ({ isTauriMock: vi.fn(() => true) }))
vi.mock('../houston/host', () => ({ isTauri: () => isTauriMock() }))

const { startResizeDraggingMock } = vi.hoisted(() => ({ startResizeDraggingMock: vi.fn() }))
vi.mock('../houston/bridge', () => ({
  startResizeDragging: (d: string) => startResizeDraggingMock(d)
}))

const { WindowResizeGrips } = await import('./WindowResizeGrips')

const ALL_DIRECTIONS = [
  'north',
  'south',
  'east',
  'west',
  'north-east',
  'north-west',
  'south-east',
  'south-west'
]

describe('WindowResizeGrips', () => {
  let container: HTMLDivElement
  let root: Root

  function render(): void {
    act(() => {
      root.render(
        <StrictMode>
          <WindowResizeGrips />
        </StrictMode>
      )
    })
  }

  function grip(direction: string): HTMLElement {
    const el = container.querySelector(`[data-testid="resize-grip-${direction}"]`)
    if (!el) throw new Error(`no grip for ${direction}`)
    return el as HTMLElement
  }

  beforeEach(() => {
    isTauriMock.mockReturnValue(true)
    startResizeDraggingMock.mockReset()
    startResizeDraggingMock.mockResolvedValue(undefined)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders one grip per edge and corner', () => {
    render()
    for (const direction of ALL_DIRECTIONS) expect(grip(direction)).toBeTruthy()
    expect(container.querySelectorAll('[data-testid^="resize-grip-"]')).toHaveLength(8)
  })

  it('renders nothing under Electron', () => {
    isTauriMock.mockReturnValue(false)
    render()
    expect(container.querySelectorAll('[data-testid^="resize-grip-"]')).toHaveLength(0)
  })

  it('forwards each grip its own direction', () => {
    render()
    for (const direction of ALL_DIRECTIONS) {
      startResizeDraggingMock.mockClear()
      act(() => {
        grip(direction).dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
        )
      })
      expect(startResizeDraggingMock).toHaveBeenCalledWith(direction)
    }
  })

  it('cancels the browser default so no gesture races the WM grab', () => {
    render()
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
    act(() => {
      grip('north').dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(true)
  })

  it('ignores a non-left button, which belongs to whatever is underneath', () => {
    render()
    act(() => {
      grip('east').dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 })
      )
    })
    expect(startResizeDraggingMock).not.toHaveBeenCalled()
  })

  it('reports a failed resize instead of an unhandled rejection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    startResizeDraggingMock.mockRejectedValue(new Error('no WM'))
    render()
    await act(async () => {
      grip('south').dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
      )
      await Promise.resolve()
    })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
