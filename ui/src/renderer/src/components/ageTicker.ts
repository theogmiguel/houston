import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()
let now = Date.now()
let timer: ReturnType<typeof setInterval> | undefined

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
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
