import { useEffect } from 'react'
import type { HoustonClient } from './client'

/** Reports desktop presence on each connection; the watcher loads after boot. */
export function useDesktopPresence(client: HoustonClient | null): void {
  useEffect(() => {
    if (!client) return
    const stop = import('./desktopPresence').then((m) => m.watchHostDesktopPresence(client))
    return () => void stop.then((off) => off())
  }, [client])
}
