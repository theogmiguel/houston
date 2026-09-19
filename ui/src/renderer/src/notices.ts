import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'

export type NoticeKind = 'info' | 'success' | 'warning' | 'error'

export interface NoticeAction {
  label: string
  onClick: () => void
}

export interface NoticeInput {
  code: string
  kind?: NoticeKind
  title: string
  body?: string
  action?: NoticeAction
  durationMs?: number | null
  dismissible?: boolean
}

export interface NoticeRecord {
  id: number
  code: string
  kind: NoticeKind
  title: string
  body?: string
  action?: NoticeAction
  durationMs: number | null
  dismissible: boolean
}

export const NOTICE_DEFAULT_MS: Record<NoticeKind, number | null> = {
  info: 3000,
  success: 3000,
  warning: null,
  error: null
}

export const MAX_NOTICES = 5

export function resolveNotice(input: NoticeInput, id: number): NoticeRecord {
  const kind = input.kind ?? 'info'
  return {
    id,
    code: input.code,
    kind,
    title: input.title,
    body: input.body,
    action: input.action,
    durationMs: input.durationMs === undefined ? NOTICE_DEFAULT_MS[kind] : input.durationMs,
    dismissible: input.dismissible ?? true
  }
}

export function pushNoticeInto(
  list: readonly NoticeRecord[],
  rec: NoticeRecord,
  cap: number = MAX_NOTICES
): { list: NoticeRecord[]; evicted: number } {
  const next = [...list.filter((n) => n.code !== rec.code), rec]
  const evicted = Math.max(0, next.length - cap)
  return { list: evicted > 0 ? next.slice(evicted) : next, evicted }
}

export function dismissNoticeByCode(
  list: readonly NoticeRecord[],
  code: string
): readonly NoticeRecord[] {
  return list.some((n) => n.code === code) ? list.filter((n) => n.code !== code) : list
}

export interface NoticeStore {
  notices: readonly NoticeRecord[]
  push: (input: NoticeInput) => string
  dismiss: (code: string) => void
  evicted: number
}

interface NoticeState {
  list: readonly NoticeRecord[]
  evicted: number
}

type NoticeEvent =
  | { type: 'push'; rec: NoticeRecord; cap: number }
  | { type: 'dismiss'; code: string }
  | { type: 'expire'; id: number }

// `list` and `evicted` share one reducer because they change together: under
// StrictMode a `setEvicted` called from inside a `setNotices` updater would
// count every eviction twice and make the overflow row lie.
function reduceNotices(state: NoticeState, ev: NoticeEvent): NoticeState {
  switch (ev.type) {
    case 'push': {
      const { list, evicted } = pushNoticeInto(state.list, ev.rec, ev.cap)
      return { list, evicted: state.evicted + evicted }
    }
    case 'dismiss': {
      const list = dismissNoticeByCode(state.list, ev.code)
      if (list === state.list) return state
      return { list, evicted: list.length === 0 ? 0 : state.evicted }
    }
    case 'expire': {
      if (!state.list.some((n) => n.id === ev.id)) return state
      const list = state.list.filter((n) => n.id !== ev.id)
      return { list, evicted: list.length === 0 ? 0 : state.evicted }
    }
  }
}

const EMPTY: NoticeState = { list: [], evicted: 0 }

export function useNotices(cap: number = MAX_NOTICES): NoticeStore {
  const [state, dispatch] = useReducer(reduceNotices, EMPTY)
  const seq = useRef(0)
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((code: string) => {
    dispatch({ type: 'dismiss', code })
  }, [])

  const push = useCallback(
    (input: NoticeInput): string => {
      const rec = resolveNotice(input, ++seq.current)
      dispatch({ type: 'push', rec, cap })
      if (rec.durationMs !== null) {
        timers.current.set(
          rec.id,
          setTimeout(() => {
            timers.current.delete(rec.id)
            dispatch({ type: 'expire', id: rec.id })
          }, rec.durationMs)
        )
      }
      return rec.code
    },
    [cap]
  )

  useEffect(() => {
    const map = timers.current
    return () => {
      for (const t of map.values()) clearTimeout(t)
      map.clear()
    }
  }, [])

  return useMemo(
    () => ({ notices: state.list, push, dismiss, evicted: state.evicted }),
    [state.list, state.evicted, push, dismiss]
  )
}
