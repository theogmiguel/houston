import { useCallback, useEffect, useState } from 'react'
import { isSettingsOpen, setSettingsOpen, useSettingsOpen } from '../settingsNav'

const SIDEBAR_RAIL_KEY = 'tr-sidebar-rail'
import { findPane, type LayoutNode, type PaneKey } from '../layout/tree'

export function useShellFocus(): {
  activeId: number | null
  setActiveId: React.Dispatch<React.SetStateAction<number | null>>
  activeLeaf: string | null
  setActiveLeaf: React.Dispatch<React.SetStateAction<string | null>>
  expandedId: PaneKey | null
  setExpandedId: React.Dispatch<React.SetStateAction<PaneKey | null>>
  sidebarRail: boolean
  setSidebarRail: React.Dispatch<React.SetStateAction<boolean>>
  settings: boolean
  setSettings: React.Dispatch<React.SetStateAction<boolean>>
  handleExpand: (key: PaneKey) => void
  expandedIn: (tree: LayoutNode | null) => PaneKey | null
} {
  const [activeId, setActiveId] = useState<number | null>(null)
  const [activeLeaf, setActiveLeaf] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<PaneKey | null>(null)
  const [sidebarRail, setSidebarRail] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_RAIL_KEY) === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_RAIL_KEY, sidebarRail ? '1' : '0')
    } catch {
    }
  }, [sidebarRail])
  const settings = useSettingsOpen()
  const setSettings = useCallback<React.Dispatch<React.SetStateAction<boolean>>>(
    (next) => setSettingsOpen(typeof next === 'function' ? next(isSettingsOpen()) : next),
    []
  )

  const handleExpand = useCallback(
    (key: PaneKey): void => {
      if (key === expandedId) {
        setExpandedId(null)
        setActiveId(null)
      } else {
        setExpandedId(key)
      }
    },
    [expandedId]
  )
  const expandedIn = useCallback(
    (tree: LayoutNode | null): PaneKey | null =>
      expandedId !== null && tree && findPane(tree, expandedId) ? expandedId : null,
    [expandedId]
  )

  return {
    activeId,
    setActiveId,
    activeLeaf,
    setActiveLeaf,
    expandedId,
    setExpandedId,
    sidebarRail,
    setSidebarRail,
    settings,
    setSettings,
    handleExpand,
    expandedIn
  }
}
