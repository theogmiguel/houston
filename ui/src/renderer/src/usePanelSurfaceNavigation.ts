import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { SessionInfo } from './houston/client'
import type { SurfaceKind } from './scmPanel'
import { loadInspectorTabs, saveInspectorTabs } from './scmPanel'

interface UsePanelSurfaceNavigationOptions {
  activeId: number | null
  sessions: ReadonlyMap<number, SessionInfo>
  sideWorkspace: string
  setScmOpen: Dispatch<SetStateAction<boolean>>
  setActiveSurface: (surface: 'grid' | 'side') => void
  setPanelMountEpoch: Dispatch<SetStateAction<number>>
}

export function usePanelSurfaceNavigation({
  activeId,
  sessions,
  sideWorkspace,
  setScmOpen,
  setActiveSurface,
  setPanelMountEpoch,
}: UsePanelSurfaceNavigationOptions) {
  const openPanelSurface = useCallback((surface: SurfaceKind): void => {
    const workspace = sideWorkspace === 'all' ? sessions.get(activeId ?? -1)?.project_dir ?? 'all' : sideWorkspace
    if (!workspace) return
    const current = loadInspectorTabs(workspace)
    const openTabs = current.openTabs.includes(surface) ? current.openTabs : [...current.openTabs, surface]
    saveInspectorTabs(workspace, { openTabs, active: surface })
    setScmOpen(true)
    setActiveSurface('side')
    setPanelMountEpoch((epoch) => epoch + 1)
  }, [activeId, sessions, setActiveSurface, setPanelMountEpoch, setScmOpen, sideWorkspace])

  return { openPanelSurface }
}
