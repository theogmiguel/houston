// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AppHarness,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'

let frames: FrameRequestCallback[] = []

function handle(harness: AppHarness): HTMLElement {
  const el = harness.container.querySelector<HTMLElement>('[data-testid="rail-resize-handle"]')
  if (!el) throw new Error('rail resize handle not found')
  return el
}

function railWidthVar(harness: AppHarness): string {
  return handle(harness).parentElement?.style.getPropertyValue('--w-rail') ?? ''
}

function topbarLeft(harness: AppHarness): Element {
  const el = harness.container.querySelector('header .flex.items-center.min-w-0')
  if (!el) throw new Error('topbar-left cell not found')
  return el
}

function showRailButton(harness: AppHarness): HTMLButtonElement {
  const btn = topbarLeft(harness).querySelector('button')
  if (!btn) throw new Error('rail toggle not found')
  return btn as HTMLButtonElement
}

beforeEach(() => {
  resetHarness()
  localStorage.clear()
  frames = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    frames.push(cb)
    return frames.length
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
})

describe('rail resize — the rail can be dragged wider or narrower', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
    vi.restoreAllMocks()
  })

  const down = (x: number): void => {
    act(() => {
      handle(harness!).dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x })
      )
    })
  }
  const move = (x: number): void => {
    act(() => {
      handle(harness!).dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: x })
      )
    })
  }
  const up = (x: number): void => {
    act(() => {
      handle(harness!).dispatchEvent(
        new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: x })
      )
    })
  }
  const flush = (): void => {
    const pending = frames
    frames = []
    act(() => pending.forEach((cb) => cb(0)))
  }

  it('starts at the shipped width and clamps a drag at the floor', async () => {
    harness = await renderReadyApp()
    expect(railWidthVar(harness)).toBe('240px')

    down(240)
    move(180)
    flush()

    expect(railWidthVar(harness)).toBe('200px')
    up(180)
  })

  it('clamps a drag at the ceiling', async () => {
    harness = await renderReadyApp()

    down(240)
    move(900)
    flush()

    expect(railWidthVar(harness)).toBe('420px')
    up(900)
  })

  it('coalesces a burst of moves into one frame', async () => {
    harness = await renderReadyApp()

    down(240)
    move(300)
    move(360)
    move(400)

    expect(frames.length).toBe(1)
    flush()
    expect(railWidthVar(harness)).toBe('400px')
    up(400)
  })

  it('a drag under the collapse threshold hides the rail and remembers the last width', async () => {
    harness = await renderReadyApp()

    down(240)
    move(320)
    flush()
    expect(railWidthVar(harness)).toBe('320px')

    move(120)
    flush()

    expect(harness.container.querySelector('aside')).toBeNull()
    expect(localStorage.getItem('tr-rail-width')).toBe('320')
  })

  it('expand brings the rail back at the remembered width', async () => {
    harness = await renderReadyApp()

    down(240)
    move(320)
    flush()
    move(120)
    flush()
    expect(harness.container.querySelector('aside')).toBeNull()

    act(() => showRailButton(harness!).click())

    expect(harness.container.querySelector('aside')).not.toBeNull()
    expect(railWidthVar(harness)).toBe('320px')
  })

  it('double-clicking the handle resets the width to the default', async () => {
    harness = await renderReadyApp()

    down(240)
    move(360)
    flush()
    up(360)
    expect(railWidthVar(harness)).toBe('360px')

    act(() => {
      handle(harness!).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })

    expect(railWidthVar(harness)).toBe('240px')
    expect(localStorage.getItem('tr-rail-width')).toBe('240')
  })
})
