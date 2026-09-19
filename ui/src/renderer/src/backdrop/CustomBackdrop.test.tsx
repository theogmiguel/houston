// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CustomBackdrop } from './CustomBackdrop'
import { bumpImageVersion, setBackgroundStateForTests } from '../backgroundMode'
import type { LoadedSource } from './source'

const { loadBackgroundSourceMock, renderBackdropMock } = vi.hoisted(() => ({
  loadBackgroundSourceMock: vi.fn(),
  renderBackdropMock: vi.fn()
}))

vi.mock('./source', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./source')>()),
  loadBackgroundSource: loadBackgroundSourceMock
}))

vi.mock('./index', () => ({
  renderBackdrop: renderBackdropMock
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function loadedSource(): LoadedSource {
  return { bitmap: {} as ImageBitmap, width: 100, height: 100 }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('CustomBackdrop', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    setBackgroundStateForTests({ mode: 'solid' })
    loadBackgroundSourceMock.mockReset()
    renderBackdropMock.mockReset()
    loadBackgroundSourceMock.mockResolvedValue(loadedSource())
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    setBackgroundStateForTests({ mode: 'solid' })
  })

  function render(theme = 'graphite', onUnavailable?: (reason: string) => void): void {
    act(() => {
      root.render(<CustomBackdrop theme={theme} onUnavailable={onUnavailable} />)
    })
  }

  it('renders nothing at all in Solid — the whole opt-out', () => {
    render()
    expect(container.querySelector('[data-testid="custom-backdrop"]')).toBeNull()
    expect(container.innerHTML).toBe('')
    expect(loadBackgroundSourceMock).not.toHaveBeenCalled()
  })

  it('renders a canvas behind the shell in Custom and passes the store params', async () => {
    setBackgroundStateForTests({ mode: 'custom' })
    render()
    await flush()
    expect(container.querySelector('[data-testid="custom-backdrop"]')).not.toBeNull()
    const canvas = container.querySelector('[data-testid="custom-backdrop-canvas"]')
    expect(canvas).not.toBeNull()
    expect(renderBackdropMock).toHaveBeenCalledTimes(1)
    const [c, bitmap, viewport, params] = renderBackdropMock.mock.calls[0]
    expect(c).toBe(canvas)
    expect(bitmap).toBe((await loadBackgroundSourceMock.mock.results[0].value).bitmap)
    expect(viewport).toEqual({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 })
    expect(params).toEqual({
      pixelSize: expect.any(Number),
      colorSteps: expect.any(Number),
      originalColors: expect.any(Boolean),
      ceiling: expect.any(Number),
      dark: true
    })
  })

  it('lands the field opacity and pixelated rendering on the canvas', async () => {
    setBackgroundStateForTests({ mode: 'custom', fieldOpacity: 70 })
    render()
    await flush()
    const canvas = container.querySelector<HTMLCanvasElement>('[data-testid="custom-backdrop-canvas"]')
    if (!canvas) throw new Error('canvas not rendered')
    expect(canvas.style.opacity).toBe(String(70 / 100))
    expect(canvas.style.imageRendering).toBe('pixelated')
  })

  it('calls onUnavailable exactly once for the same failing source', async () => {
    loadBackgroundSourceMock.mockResolvedValue(null)
    const onUnavailable = vi.fn()
    setBackgroundStateForTests({ mode: 'custom' })
    render('graphite', onUnavailable)
    await flush()
    expect(onUnavailable).toHaveBeenCalledTimes(1)
    expect(onUnavailable).toHaveBeenCalledWith('preset graphite')

    setBackgroundStateForTests({ mode: 'custom', pixelSize: 3 })
    await flush()
    expect(onUnavailable).toHaveBeenCalledTimes(1)
  })

  it('the fade STARTS at fadeStop, so 100 is no fade at all', async () => {
    setBackgroundStateForTests({ mode: 'custom', fadeStop: 100 })
    render()
    await flush()
    const fade = container.querySelector<HTMLElement>('[data-testid="custom-backdrop-fade"]')
    if (!fade) throw new Error('fade not rendered')
    expect(fade.style.background).toContain('transparent 100%')
    setBackgroundStateForTests({ mode: 'custom', fadeStop: 88 })
    render()
    await flush()
    expect(fade.style.background).toContain('transparent 88%')
    expect(fade.style.background).toContain('100%)')
  })

  it('a replaced user image is decoded again, even though its name did not change', async () => {
    setBackgroundStateForTests({ mode: 'custom', preset: 'user' })
    render()
    await flush()
    expect(loadBackgroundSourceMock).toHaveBeenCalledTimes(1)
    act(() => bumpImageVersion())
    await flush()
    expect(loadBackgroundSourceMock).toHaveBeenCalledTimes(2)
  })

  it('flips dark with the theme on re-render', async () => {
    setBackgroundStateForTests({ mode: 'custom' })
    render('graphite')
    await flush()
    expect(renderBackdropMock.mock.calls[0][3].dark).toBe(true)

    render('paper')
    await flush()
    const last = renderBackdropMock.mock.calls[renderBackdropMock.mock.calls.length - 1]
    expect(last[3].dark).toBe(false)
  })
})
