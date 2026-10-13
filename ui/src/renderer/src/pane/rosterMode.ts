import { useCallback, useSyncExternalStore } from 'react'
import type { RosterMode } from '../components/ui/RosterSurface'
import type { SessionInfo } from '../houston/client'

const CHANGE_EVENT = 'houston:roster-mode'
const KEY_PREFIX = 'tr-roster-mode:'

export function useRosterMode(
  paneId: string | undefined,
  session: Pick<SessionInfo, 'project_dir' | 'session_origin' | 'id'>
): [RosterMode, (mode: RosterMode) => void] {
  const key = KEY_PREFIX + (paneId ?? `${session.project_dir}:${session.session_origin ?? session.id}`)
  const read = useCallback((): RosterMode => {
    const saved = localStorage.getItem(key)
    return saved === 'collapsed' || saved === 'expanded' ? saved : 'auto'
  }, [key])
  const subscribe = useCallback((changed: () => void) => {
    const localChange = (event: Event): void => {
      if ((event as CustomEvent<string>).detail === key) changed()
    }
    const storageChange = (event: StorageEvent): void => {
      if (event.key === key || event.key === null) changed()
    }
    window.addEventListener(CHANGE_EVENT, localChange)
    window.addEventListener('storage', storageChange)
    return () => {
      window.removeEventListener(CHANGE_EVENT, localChange)
      window.removeEventListener('storage', storageChange)
    }
  }, [key])
  const mode = useSyncExternalStore(subscribe, read, () => 'auto' as const)
  const setMode = useCallback((next: RosterMode): void => {
    localStorage.setItem(key, next)
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: key }))
  }, [key])
  return [mode, setMode]
}
