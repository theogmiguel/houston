// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PopoverViews } from './PopoverViews'
import { anchorPopoverStart, largestViewBounds } from './popoverMotion'
import { AnimOut } from './AnimOut'

describe('popover motion helpers', () => {
  it('keeps the trigger start edge when its label width changes', () => {
    expect(anchorPopoverStart(40, 90, 800, 8)).toBe(40)
    expect(anchorPopoverStart(40, 180, 800, 8)).toBe(40)
  })

  it('clamps the anchor within the viewport at the right edge', () => {
    expect(anchorPopoverStart(760, 100, 800, 8)).toBe(692)
  })

  it('anchors to the start edge for Houston, which does not use RTL', () => {
    expect(anchorPopoverStart(24, 120, 800, 8)).toBe(24)
  })

  it('keeps the largest view bounds', () => {
    expect(largestViewBounds([{ width: 240, height: 180 }, { width: 360, height: 120 }]))
      .toEqual({ width: 360, height: 180 })
  })
})

describe('PopoverViews', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('fades the outgoing view before mounting the incoming view', () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    const views = [
      { id: 'profile', bounds: { width: 180, height: 120 }, content: <span>Profile view</span> },
      { id: 'specific', bounds: { width: 280, height: 160 }, content: <span>Specific view</span> }
    ]
    const { container, rerender } = render(<PopoverViews views={views} activeId="profile" />)

    rerender(<PopoverViews views={views} activeId="specific" />)
    expect(screen.getByText('Profile view')).toBeTruthy()
    expect((container.firstElementChild as HTMLElement).style.width).toBe('280px')
    expect((container.firstElementChild as HTMLElement).style.height).toBe('160px')
    act(() => vi.advanceTimersByTime(119))
    expect(screen.queryByText('Specific view')).toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByText('Specific view')).toBeTruthy()
    expect(screen.getByText('Specific view').parentElement?.className).toBe('popover-view-in')
  })

  it('switches immediately without transitions when reduced motion is enabled', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const views = [
      { id: 'profile', bounds: { width: 180, height: 120 }, content: <span>Profile view</span> },
      { id: 'specific', bounds: { width: 280, height: 160 }, content: <span>Specific view</span> }
    ]
    const { rerender } = render(<PopoverViews views={views} activeId="profile" />)

    rerender(<PopoverViews views={views} activeId="specific" />)
    expect(screen.getByText('Specific view').parentElement?.className).toBe('')
    expect(screen.queryByText('Profile view')).toBeNull()
  })

  it('removes a closing popover immediately when reduced motion is enabled', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const { rerender } = render(<AnimOut open><span>Popover content</span></AnimOut>)
    rerender(<AnimOut open={false}><span>Popover content</span></AnimOut>)
    expect(screen.queryByText('Popover content')).toBeNull()
  })
})
