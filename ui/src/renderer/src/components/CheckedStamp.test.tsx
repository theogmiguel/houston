// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CheckedStamp, checkedWords } from './CheckedStamp'

describe('checkedWords', () => {
  const now = Date.UTC(2026, 0, 2, 12, 0, 0)
  const ago = (ms: number): number => now - ms

  it('says "just now" for anything inside the first minute', () => {
    expect(checkedWords(now, now)).toBe('Checked just now')
    expect(checkedWords(ago(59_000), now)).toBe('Checked just now')
  })

  it('counts minutes, then hours, then days', () => {
    expect(checkedWords(ago(4 * 60_000), now)).toBe('Checked 4 min ago')
    expect(checkedWords(ago(59 * 60_000), now)).toBe('Checked 59 min ago')
    expect(checkedWords(ago(3 * 3_600_000), now)).toBe('Checked 3 h ago')
    expect(checkedWords(ago(50 * 3_600_000), now)).toBe('Checked 2 d ago')
  })

  it('never counts backwards from a clock that moved', () => {
    expect(checkedWords(now + 5_000, now)).toBe('Checked just now')
  })
})

describe('CheckedStamp', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('renders nothing at all before the first answer', () => {
    act(() => root.render(<CheckedStamp at={null} />))
    expect(container.querySelector('[data-testid="checked-stamp"]')).toBeNull()
  })

  it('re-words itself once a minute, without being re-rendered', () => {
    vi.useFakeTimers()
    const at = Date.now()
    act(() => root.render(<CheckedStamp at={at} />))
    const stamp = (): string =>
      container.querySelector('[data-testid="checked-stamp"]')!.textContent ?? ''
    expect(stamp()).toBe('Checked just now')

    act(() => {
      vi.advanceTimersByTime(4 * 60_000)
    })
    expect(stamp()).toBe('Checked 4 min ago')
  })
})
