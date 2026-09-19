// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { StrictMode, createElement, type ReactNode } from 'react'

const strict = ({ children }: { children: ReactNode }): ReactNode =>
  createElement(StrictMode, null, children)
import {
  MAX_NOTICES,
  NOTICE_DEFAULT_MS,
  dismissNoticeByCode,
  pushNoticeInto,
  resolveNotice,
  useNotices
} from './notices'

afterEach(() => {
  vi.useRealTimers()
})

describe('resolveNotice', () => {
  it('defaults kind to info and duration to that kind default', () => {
    const rec = resolveNotice({ code: 'c', title: 'hi' }, 1)
    expect(rec.kind).toBe('info')
    expect(rec.durationMs).toBe(NOTICE_DEFAULT_MS.info)
    expect(rec.id).toBe(1)
  })

  it('leaves warning and error sticky by default', () => {
    expect(resolveNotice({ code: 'a', title: 'a', kind: 'warning' }, 1).durationMs).toBeNull()
    expect(resolveNotice({ code: 'b', title: 'b', kind: 'error' }, 2).durationMs).toBeNull()
  })

  it('honours an explicit duration over the kind default', () => {
    expect(resolveNotice({ code: 'a', title: 'a', kind: 'error', durationMs: 500 }, 1).durationMs).toBe(500)
    expect(resolveNotice({ code: 'a', title: 'a', kind: 'info', durationMs: null }, 1).durationMs).toBeNull()
  })
})

describe('pushNoticeInto', () => {
  const rec = (code: string, id: number, title = code): ReturnType<typeof resolveNotice> =>
    resolveNotice({ code, title }, id)

  it('appends the newest at the END of the list (the reference order)', () => {
    const a = pushNoticeInto([], rec('a', 1))
    const b = pushNoticeInto(a.list, rec('b', 2))
    expect(b.list.map((n) => n.code)).toEqual(['a', 'b'])
    expect(b.evicted).toBe(0)
  })

  it('replaces a same-code notice in place of a second row, moving it last', () => {
    const first = pushNoticeInto([], rec('a', 1, 'first'))
    const other = pushNoticeInto(first.list, rec('b', 2))
    const again = pushNoticeInto(other.list, rec('a', 3, 'second'))
    expect(again.list.map((n) => n.code)).toEqual(['b', 'a'])
    expect(again.list.at(-1)?.title).toBe('second')
    expect(again.list).toHaveLength(2)
  })

  it('evicts the OLDEST once the cap is reached and reports how many', () => {
    let list: ReturnType<typeof resolveNotice>[] = []
    for (let i = 1; i <= MAX_NOTICES + 2; i++) {
      const next = pushNoticeInto(list, rec(`c${i}`, i))
      list = next.list
      if (i <= MAX_NOTICES) expect(next.evicted).toBe(0)
      else expect(next.evicted).toBe(1)
    }
    expect(list).toHaveLength(MAX_NOTICES)
    expect(list[0].code).toBe('c3')
  })
})

describe('dismissNoticeByCode', () => {
  it('removes every row carrying that code and leaves the rest ordered', () => {
    const list = [resolveNotice({ code: 'a', title: 'a' }, 1), resolveNotice({ code: 'b', title: 'b' }, 2)]
    expect(dismissNoticeByCode(list, 'a').map((n) => n.code)).toEqual(['b'])
  })

  it('returns the SAME array when the code is not present (no re-render)', () => {
    const list = [resolveNotice({ code: 'a', title: 'a' }, 1)]
    expect(dismissNoticeByCode(list, 'zz')).toBe(list)
  })
})

describe('useNotices timers', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('drops a timed notice when its window elapses, and keeps a sticky one', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useNotices(), { wrapper: strict })
    act(() => {
      result.current.push({ code: 'timed', title: 'Copied', durationMs: 3000 })
      result.current.push({ code: 'stuck', title: 'boom', kind: 'error' })
    })
    expect(result.current.notices.map((n) => n.code)).toEqual(['timed', 'stuck'])
    act(() => vi.advanceTimersByTime(2999))
    expect(result.current.notices.map((n) => n.code)).toEqual(['timed', 'stuck'])
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.notices.map((n) => n.code)).toEqual(['stuck'])
    act(() => vi.advanceTimersByTime(60_000))
    expect(result.current.notices.map((n) => n.code)).toEqual(['stuck'])
  })

  it("re-pushing a code mid-window restarts its clock — the predecessor's timer cannot take the replacement with it", () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useNotices(), { wrapper: strict })
    act(() => void result.current.push({ code: 'copy', title: 'Copied 1 line', durationMs: 3000 }))
    act(() => vi.advanceTimersByTime(2900))
    act(() => void result.current.push({ code: 'copy', title: 'Copied 2 lines', durationMs: 3000 }))
    act(() => vi.advanceTimersByTime(200))
    expect(result.current.notices.map((n) => n.title)).toEqual(['Copied 2 lines'])
    act(() => vi.advanceTimersByTime(2800))
    expect(result.current.notices).toHaveLength(0)
  })

  it('dismissing a notice clears the eviction count once the stack empties', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useNotices(), { wrapper: strict })
    act(() => {
      for (let i = 0; i < MAX_NOTICES + 2; i++) {
        result.current.push({ code: `c${i}`, title: `t${i}`, kind: 'error' })
      }
    })
    expect(result.current.evicted).toBe(2)
    expect(result.current.notices).toHaveLength(MAX_NOTICES)
    act(() => {
      for (const n of [...result.current.notices]) result.current.dismiss(n.code)
    })
    expect(result.current.notices).toHaveLength(0)
    expect(result.current.evicted).toBe(0)
  })
})
