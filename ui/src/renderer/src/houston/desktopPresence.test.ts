// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientMsg } from './generated/ClientMsg'
import { PRESENCE_REPORT_INTERVAL_MS, watchDesktopPresence } from './desktopPresence'

let focused = true
let visibility: DocumentVisibilityState = 'visible'

beforeEach(() => {
  focused = true
  visibility = 'visible'
  vi.useFakeTimers()
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function mount(): { reports: boolean[]; unmount: () => void } {
  const reports: boolean[] = []
  const send = (msg: ClientMsg): void => {
    if (msg.type === 'desktop_presence') reports.push(msg.active)
  }
  return { reports, unmount: watchDesktopPresence({ send }) }
}

describe('watchDesktopPresence', () => {
  it('reports a focused window as active, then at most once per interval', () => {
    const { reports } = mount()
    expect(reports).toEqual([true])
    window.dispatchEvent(new KeyboardEvent('keydown'))
    window.dispatchEvent(new PointerEvent('pointermove'))
    expect(reports).toEqual([true])
    vi.advanceTimersByTime(PRESENCE_REPORT_INTERVAL_MS)
    window.dispatchEvent(new KeyboardEvent('keydown'))
    expect(reports).toEqual([true, true])
  })

  it('reports away once on blur and active again on the next input', () => {
    const { reports } = mount()
    focused = false
    window.dispatchEvent(new Event('blur'))
    window.dispatchEvent(new Event('blur'))
    window.dispatchEvent(new KeyboardEvent('keydown'))
    expect(reports).toEqual([true, false])
    focused = true
    window.dispatchEvent(new PointerEvent('pointerdown'))
    expect(reports).toEqual([true, false, true])
  })

  it('reports a hidden window as away and an unfocused one never as active', () => {
    focused = false
    const { reports } = mount()
    expect(reports).toEqual([])
    focused = true
    window.dispatchEvent(new Event('focus'))
    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(reports).toEqual([true, false])
  })

  it('stops listening once unsubscribed, without reporting', () => {
    const { reports, unmount } = mount()
    unmount()
    vi.advanceTimersByTime(PRESENCE_REPORT_INTERVAL_MS)
    window.dispatchEvent(new KeyboardEvent('keydown'))
    expect(reports).toEqual([true])
  })
})
