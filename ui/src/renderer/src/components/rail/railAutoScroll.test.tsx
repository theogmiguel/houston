// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTO_SCROLL_EDGE_PX, AUTO_SCROLL_MAX_STEP_PX, edgeScrollStep, useEdgeAutoScroll, workspaceDropIndex } from './railAutoScroll'

describe('edgeScrollStep', () => {
  it('is zero away from the edges', () => {
    expect(edgeScrollStep(200, 0, 400)).toBe(0)
  })

  it('scrolls up near the top edge, faster the closer the pointer is', () => {
    expect(edgeScrollStep(AUTO_SCROLL_EDGE_PX / 2, 0, 400)).toBeLessThan(0)
    expect(edgeScrollStep(0, 0, 400)).toBe(-AUTO_SCROLL_MAX_STEP_PX)
    expect(edgeScrollStep(0, 0, 400)).toBeLessThan(edgeScrollStep(AUTO_SCROLL_EDGE_PX / 2, 0, 400))
  })

  it('scrolls down near the bottom edge and caps beyond it', () => {
    expect(edgeScrollStep(395, 0, 400)).toBeGreaterThan(0)
    expect(edgeScrollStep(900, 0, 400)).toBe(AUTO_SCROLL_MAX_STEP_PX)
  })
})

describe('workspaceDropIndex', () => {
  const rows = [{ top: 0, height: 32 }, { top: 200, height: 32 }, { top: 400, height: 32 }]

  it('drops before the first row whose midpoint lies below the pointer', () => {
    expect(workspaceDropIndex(rows, 10)).toBe(0)
    expect(workspaceDropIndex(rows, 210)).toBe(1)
  })

  it('maps a pointer over a workspace\'s grid cards to the slot after that workspace', () => {
    expect(workspaceDropIndex(rows, 120)).toBe(1)
    expect(workspaceDropIndex(rows, 300)).toBe(2)
  })

  it('drops at the end below the last row midpoint', () => {
    expect(workspaceDropIndex(rows, 900)).toBe(3)
    expect(workspaceDropIndex([], 5)).toBe(0)
  })
})

describe('useEdgeAutoScroll', () => {
  let container: HTMLDivElement
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] })
    container = document.createElement('div')
    document.body.appendChild(container)
  })
  afterEach(() => {
    vi.useRealTimers()
    container.remove()
  })

  it('scrolls the container while the pointer rests at its bottom edge, then stops', () => {
    const list = document.createElement('div')
    let top = 0
    Object.defineProperty(list, 'scrollTop', { get: () => top, set: (value: number) => { top = value } })
    list.getBoundingClientRect = () => ({ top: 0, bottom: 400, left: 0, right: 300, height: 400, width: 300, x: 0, y: 0, toJSON: () => ({}) })
    const ref = { current: list }
    const scrolled = vi.fn()
    let api!: ReturnType<typeof useEdgeAutoScroll>
    function Probe(): null {
      api = useEdgeAutoScroll(ref, scrolled)
      return null
    }
    const root = createRoot(container)
    act(() => root.render(<Probe />))
    act(() => api.track(398))
    act(() => { vi.advanceTimersByTime(50) })
    expect(top).toBeGreaterThan(0)
    expect(scrolled).toHaveBeenCalled()
    api.stop()
    const stopped = top
    act(() => { vi.advanceTimersByTime(100) })
    expect(top).toBe(stopped)
    act(() => root.unmount())
  })
})
