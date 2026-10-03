// @vitest-environment jsdom
import { cleanup, render, screen, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReconnectBanner } from './ReconnectBanner'

afterEach(() => { cleanup(); vi.useRealTimers() })

describe('reconnect age', () => {
  it('updates in its own leaf and clears its timer on unmount', () => {
    vi.useFakeTimers()
    const since = Date.now()
    const view = render(<ReconnectBanner since={since} error={null} onRetry={() => {}} />)
    expect(vi.getTimerCount()).toBe(1)
    expect(screen.getByRole('status').textContent).toContain('0s')
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByRole('status').textContent).toContain('1s')
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
