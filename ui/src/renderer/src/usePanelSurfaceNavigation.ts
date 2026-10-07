import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { PrListItem, PullRequestLink, SessionInfo } from './houston/client'
import type { ScmTab, SurfaceKind } from './scmPanel'
import { loadInspectorTabs, saveInspectorTabs } from './scmPanel'
import { pullRequestLinkFromItem } from './components/prs/PullRequestsRailScreen'
import { SIDE_OPEN_EVENT } from './sidePanel'

interface UsePanelSurfaceNavigationOptions {
  activeId: number | null
  sessions: ReadonlyMap<number, SessionInfo>
  sideWorkspace: string
  prListDir: string | null | undefined
  setScmOpen: Dispatch<SetStateAction<boolean>>
  setActiveSurface: (surface: 'grid' | 'side') => void
  setRequestedPr: Dispatch<SetStateAction<PullRequestLink | null>>
  setScmTab: Dispatch<SetStateAction<ScmTab>>
  setRailView: (view: null) => void
  setPanelMountEpoch: Dispatch<SetStateAction<number>>
}

export function usePanelSurfaceNavigation({
  activeId,
  sessions,
  sideWorkspace,
  prListDir,
  setScmOpen,
  setActiveSurface,
  setRequestedPr,
  setScmTab,
  setRailView,
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

  const openPullRequestFromScreen = useCallback((item: PrListItem): void => {
    if (!prListDir) return
    setRequestedPr(pullRequestLinkFromItem(item))
    const tabs = loadInspectorTabs(prListDir)
    const openTabs: SurfaceKind[] = tabs.openTabs.includes('pull-request') ? tabs.openTabs : [...tabs.openTabs, 'pull-request']
    saveInspectorTabs(prListDir, { openTabs, active: 'pull-request' })
    setScmTab('pull-request')
    setScmOpen(true)
    setActiveSurface('side')
    window.dispatchEvent(new CustomEvent(SIDE_OPEN_EVENT, { detail: { kind: 'pull-request', dir: prListDir, number: item.number, url: item.url } }))
    setRailView(null)
    setPanelMountEpoch((epoch) => epoch + 1)
  }, [prListDir, setActiveSurface, setPanelMountEpoch, setRailView, setRequestedPr, setScmOpen, setScmTab])

  return { openPanelSurface, openPullRequestFromScreen }
}
