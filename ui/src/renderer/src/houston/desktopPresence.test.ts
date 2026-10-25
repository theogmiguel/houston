// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientMsg } from './generated/ClientMsg'
import { BROWSER_FOCUS_GRACE_MS, PRESENCE_REPORT_INTERVAL_MS, watchDesktopPresence } from './desktopPresence'

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

function mountWithBrowser(): { reports: boolean[]; browserFocus: () => void; unmount: () => void } {
  const reports: boolean[] = []
  const send = (msg: ClientMsg): void => {
    if (msg.type === 'desktop_presence') reports.push(msg.active)
  }
  let listener: (() => void) | null = null
  const unmount = watchDesktopPresence({ send }, (onFocus) => {
    listener = onFocus
    return () => {
      listener = null
    }
  })
  return { reports, browserFocus: () => listener?.(), unmount }
}

function blur(): void {
  focused = false
  window.dispatchEvent(new Event('blur'))
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

  it('keeps reporting present when focus moves into the docked browser', () => {
    const { reports, browserFocus } = mountWithBrowser()
    blur()
    vi.advanceTimersByTime(BROWSER_FOCUS_GRACE_MS / 2)
    browserFocus()
    vi.advanceTimersByTime(BROWSER_FOCUS_GRACE_MS * 4)
    expect(reports).toEqual([true])
  })

  it('treats a browser focus event just before the blur the same way', () => {
    const { reports, browserFocus } = mountWithBrowser()
    browserFocus()
    blur()
    vi.advanceTimersByTime(BROWSER_FOCUS_GRACE_MS * 4)
    expect(reports).toEqual([true])
  })

  it('reports away when the window loses focus to anything else', () => {
    const { reports } = mountWithBrowser()
    blur()
    expect(reports).toEqual([true])
    vi.advanceTimersByTime(BROWSER_FOCUS_GRACE_MS)
    expect(reports).toEqual([true, false])
  })

  it('counts focusing the browser as input, at most once per interval', () => {
    const { reports, browserFocus } = mountWithBrowser()
    blur()
    browserFocus()
    expect(reports).toEqual([true])
    vi.advanceTimersByTime(PRESENCE_REPORT_INTERVAL_MS)
    browserFocus()
    expect(reports).toEqual([true, true])
  })

  it('stops listening to the browser once unsubscribed', () => {
    const { reports, browserFocus, unmount } = mountWithBrowser()
    blur()
    unmount()
    vi.advanceTimersByTime(PRESENCE_REPORT_INTERVAL_MS)
    browserFocus()
    expect(reports).toEqual([true])
  })
})
