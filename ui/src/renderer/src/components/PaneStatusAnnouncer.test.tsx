// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionInfo } from '../houston/client'
import { ANNOUNCE_CLEAR_MS, ANNOUNCE_SETTLE_MS, announcement, announcerSnapshot, StatusAnnouncerRegion, type AnnouncerSnapshot } from './PaneStatusAnnouncer'

const snap = (over: Partial<AnnouncerSnapshot> = {}): AnnouncerSnapshot => ({ pane: 1, title: 'api', status: 'idle', othersNeedingYou: 0, ...over })

describe('announcement', () => {
  it('names the focused pane for each reported transition', () => {
    expect(announcement(snap(), snap({ status: 'working' }))).toBe('api is working.')
    expect(announcement(snap({ status: 'working' }), snap({ status: 'idle' }))).toBe('api finished.')
    expect(announcement(snap({ status: 'working' }), snap({ status: 'needs-input' }))).toBe('api needs your input.')
    expect(announcement(snap({ status: 'needs-input' }), snap({ status: 'idle' }))).toBe('api is ready.')
  })

  it('stays silent for starting, unavailable and unchanged statuses', () => {
    expect(announcement(snap(), snap({ status: 'spawning' }))).toBeNull()
    expect(announcement(snap({ status: 'working' }), snap({ status: 'unavailable' }))).toBeNull()
    expect(announcement(snap(), snap({ title: 'renamed' }))).toBeNull()
  })

  it('counts the other panes that need you', () => {
    expect(announcement(snap(), snap({ othersNeedingYou: 1 }))).toBe('1 other pane needs you.')
    expect(announcement(snap({ othersNeedingYou: 1 }), snap({ othersNeedingYou: 3 }))).toBe('3 other panes need you.')
    expect(announcement(snap({ othersNeedingYou: 2 }), snap({ othersNeedingYou: 0 }))).toBe('No other panes need you.')
    expect(announcement(snap({ status: 'working' }), snap({ status: 'idle', othersNeedingYou: 1 }))).toBe('api finished. 1 other pane needs you.')
  })

  it('treats a focus move as a new baseline, not a transition', () => {
    expect(announcement(snap({ status: 'working' }), snap({ pane: 2, title: 'web', status: 'needs-input', othersNeedingYou: 2 }))).toBeNull()
  })
})

describe('announcerSnapshot', () => {
  const session = (id: number, status: SessionInfo['status']): SessionInfo => ({ id, title: `pane-${id}`, status, state: 'running', spawned_by: null } as SessionInfo)

  it('reads the focused pane and leaves it out of the needs-you count', () => {
    expect(announcerSnapshot(session(1, 'needs-input'), [1, 2])).toEqual({ pane: 1, title: 'pane-1', status: 'needs-input', othersNeedingYou: 1 })
    expect(announcerSnapshot(undefined, [1, 2])).toEqual({ pane: null, title: '', status: null, othersNeedingYou: 2 })
  })
})

describe('StatusAnnouncerRegion', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { cleanup(); vi.useRealTimers() })

  function mount(initial: AnnouncerSnapshot): { region: HTMLElement; push: (next: AnnouncerSnapshot) => void } {
    const view = render(<StatusAnnouncerRegion snapshot={initial} />)
    const region = view.getByTestId('pane-status-announcer')
    return { region, push: (next) => view.rerender(<StatusAnnouncerRegion snapshot={next} />) }
  }

  it('is a polite, atomic live region that starts empty', () => {
    const { region } = mount(snap())
    expect(region.getAttribute('role')).toBe('status')
    expect(region.getAttribute('aria-atomic')).toBe('true')
    expect(region.className).toBe('sr-only')
    expect(region.textContent).toBe('')
  })

  it('announces one message once the transition settles', () => {
    const { region, push } = mount(snap({ status: 'working' }))
    push(snap({ status: 'idle' }))
    act(() => { vi.advanceTimersByTime(ANNOUNCE_SETTLE_MS - 1) })
    expect(region.textContent).toBe('')
    act(() => { vi.advanceTimersByTime(1) })
    expect(region.textContent).toBe('api finished.')
  })

  it('announces on time while the title changes faster than the settle window', () => {
    const { region, push } = mount(snap())
    push(snap({ status: 'working' }))
    for (let step = 1; step <= 3; step++) {
      act(() => { vi.advanceTimersByTime(400) })
      push(snap({ status: 'working', title: `api · step ${step}` }))
    }
    act(() => { vi.advanceTimersByTime(ANNOUNCE_SETTLE_MS - 1200) })
    expect(region.textContent).toBe('api · step 3 is working.')
  })

  it('says nothing for a status that flips back inside the settle window', () => {
    const { region, push } = mount(snap({ status: 'working' }))
    push(snap({ status: 'idle' }))
    act(() => { vi.advanceTimersByTime(ANNOUNCE_SETTLE_MS / 2) })
    push(snap({ status: 'working' }))
    act(() => { vi.advanceTimersByTime(ANNOUNCE_SETTLE_MS * 2) })
    expect(region.textContent).toBe('')
  })

  it('collapses a burst of transitions into one message for where it settled', () => {
    const { region, push } = mount(snap({ status: 'idle' }))
    push(snap({ status: 'working' }))
    push(snap({ status: 'needs-input' }))
    act(() => { vi.advanceTimersByTime(ANNOUNCE_SETTLE_MS) })
    expect(region.textContent).toBe('api needs your input.')
  })

  it('does not announce the newly focused pane when focus moves', () => {
    const { region, push } = mount(snap({ status: 'working' }))
    push(snap({ pane: 2, title: 'web', status: 'needs-input', othersNeedingYou: 1 }))
    act(() => { vi.advanceTimersByTime(ANNOUNCE_SETTLE_MS * 2) })
    expect(region.textContent).toBe('')
    push(snap({ pane: 2, title: 'web', status: 'working', othersNeedingYou: 1 }))
    act(() => { vi.advanceTimersByTime(ANNOUNCE_SETTLE_MS) })
    expect(region.textContent).toBe('web is working.')
  })

  it('clears after a while so the same message is read again next time', () => {
    const { region, push } = mount(snap({ status: 'idle' }))
    push(snap({ status: 'working' }))
    act(() => { vi.advanceTimersByTime(ANNOUNCE_SETTLE_MS) })
    expect(region.textContent).toBe('api is working.')
    act(() => { vi.advanceTimersByTime(ANNOUNCE_CLEAR_MS) })
    expect(region.textContent).toBe('')
  })
})
