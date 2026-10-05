import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()
let now = Date.now()
let timer: ReturnType<typeof setInterval> | undefined

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    now = Date.now()
    for (const notify of listeners) notify()
    timer = setInterval(() => {
      now = Date.now()
      for (const notify of listeners) notify()
    }, 1000)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

const subscribeNever = (): (() => void) => () => {}
const getSnapshot = (): number => now

export function useAgeNow(ticking: boolean): number {
  return useSyncExternalStore(ticking ? subscribe : subscribeNever, getSnapshot, getSnapshot)
}

function ageText(start: number, end: number): string {
  const seconds = Math.max(0, Math.floor((end - start) / 1000))
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`
}

export function relativeAge(start: number, end = Date.now()): string {
  return ageText(start, end) + ' ago'
}

export function AgeLabel({ start, end, ticking }: { start: number; end?: number | null; ticking: boolean }): React.JSX.Element {
  const current = useAgeNow(ticking)
  return <>{ageText(start, end ?? current)}</>
}
