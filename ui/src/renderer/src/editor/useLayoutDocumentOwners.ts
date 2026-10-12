import { useEffect, useRef, useState } from 'react'
import { loadInspectorTabs } from '../scmPanel'
import type { LayoutNode, LayoutState } from '../layout/tree'
import { bufferKey, DOCUMENT_TABS_EVENT, FILES_TABS_MAX, FILES_TABS_STORAGE_PREFIX, fileTabOwners, retainBuffer } from './bufferStore'

// Layouts own editor documents even when a hidden grid has no mounted surface.
export function useLayoutDocumentOwners(
  workspaces: readonly { path: string }[],
  layouts: ReadonlyMap<string, LayoutState>
): void {
  const owners = useRef(new Map<string, () => void>())
  const [tabsVersion, setTabsVersion] = useState(0)
  useEffect(() => {
    const changed = (): void => setTabsVersion(version => version + 1)
    window.addEventListener(DOCUMENT_TABS_EVENT, changed)
    return () => window.removeEventListener(DOCUMENT_TABS_EVENT, changed)
  }, [])
  useEffect(() => {
    const wanted = new Map<string, [string, string]>()
    const files = new Map<string, string>()
    const visit = (workspace: string, node: LayoutNode | null): void => {
      if (!node) return
      if (node.kind === 'split' || node.kind === 'stack') node.children.forEach(child => visit(workspace, child))
      else if (node.kind === 'files') files.set(node.id, workspace)
      else if (node.kind === 'editor') wanted.set(bufferKey(workspace, node.path), [workspace, node.path])
    }
    for (const workspace of workspaces) {
      for (const [key, layout] of layouts) {
        if (key.startsWith(`${workspace.path}::`)) visit(workspace.path, layout.tree)
      }
    }
    visit('all', layouts.get('all')?.tree ?? null)
    for (const workspace of [...workspaces, { path: 'all' }]) {
      if (loadInspectorTabs(workspace.path).openTabs.includes('files')) files.set(`side:${workspace.path}`, workspace.path)
    }
    for (const [owner, fallbackWorkspace] of files) {
      const registered = fileTabOwners.get(owner)
      const workspace = registered?.workspace ?? fallbackWorkspace
      if (registered) {
        for (const path of registered.paths) wanted.set(bufferKey(workspace, path), [workspace, path])
        continue
      }
      try {
        const saved = JSON.parse(localStorage.getItem(`${FILES_TABS_STORAGE_PREFIX}${workspace}`) ?? '{}') as { tabs?: { path: string }[] }
        for (const tab of saved.tabs?.slice(0, FILES_TABS_MAX) ?? []) {
          if (typeof tab?.path === 'string') wanted.set(bufferKey(workspace, tab.path), [workspace, tab.path])
        }
      } catch { /* Invalid persisted tabs have no document ownership. */ }
    }
    for (const owner of fileTabOwners.keys()) if (!files.has(owner)) fileTabOwners.delete(owner)
    for (const [key, [workspace, path]] of wanted) {
      if (!owners.current.has(key)) owners.current.set(key, retainBuffer(workspace, path))
    }
    for (const [key, release] of owners.current) {
      if (wanted.has(key)) continue
      owners.current.delete(key)
      release()
    }
  }, [workspaces, layouts, tabsVersion])
  useEffect(() => () => {
    for (const release of owners.current.values()) release()
    owners.current.clear()
  }, [])
}
