import { useEffect, useRef, useState } from 'react'

// Long enough that a status flicker does not reshuffle the list, short enough that a real change shows up promptly.
export const SMART_SETTLE_MS = 3000

// Smart ranking reads this snapshot, not the live cards. The timer starts at the first change and is
// never restarted, so steady updates still refresh the snapshot every `delayMs` instead of starving it.
export function useSettledSmartCards<T>(live: T, enabled: boolean, delayMs: number = SMART_SETTLE_MS): T {
  const [settled, setSettled] = useState(live)
  const latest = useRef(live)
  latest.current = live
  const timer = useRef<number | null>(null)
  useEffect(() => {
    if (!enabled) {
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = null
      setSettled(live)
      return
    }
    if (timer.current !== null || Object.is(settled, live)) return
    timer.current = window.setTimeout(() => {
      timer.current = null
      setSettled(latest.current)
    }, delayMs)
  }, [live, enabled, delayMs, settled])
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current) }, [])
  return settled
}
