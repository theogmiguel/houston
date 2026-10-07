// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PrefixHint } from './PrefixHint'
import { prefixLayer } from '../prefixLayer'

describe('PrefixHint', () => {
  let container: HTMLDivElement
  let root: Root
  const hint = (): Element | null => container.querySelector('[data-testid="prefix-hint"]')

  beforeEach(() => {
    vi.useFakeTimers()
    prefixLayer.disarm()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root.render(<PrefixHint />))
  })
  afterEach(() => {
    act(() => prefixLayer.disarm())
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('appears 250 ms after the prefix, not before, and leaves with the layer', () => {
    act(() => prefixLayer.arm())
    act(() => vi.advanceTimersByTime(249))
    expect(hint()).toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(hint()).not.toBeNull()
    act(() => prefixLayer.disarm())
    expect(hint()).toBeNull()
  })

  it('shows the redesigned panel and Pull Requests prefix destinations', () => {
    act(() => prefixLayer.arm())
    act(() => vi.advanceTimersByTime(250))
    expect(hint()?.textContent).toContain('panel surfaces')
    expect(hint()?.textContent).toContain('B')
    expect(hint()?.textContent).toContain('F')
    expect(hint()?.textContent).toContain('D')
    expect(hint()?.textContent).toContain('P')
    expect(hint()?.textContent).toContain('L')
    expect(hint()?.textContent).toContain('Pull Requests screen')
    expect(hint()?.textContent).toContain('R')
  })
})
