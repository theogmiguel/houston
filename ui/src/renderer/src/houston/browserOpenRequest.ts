import { openSideBrowser } from '../sidePanel'
import { loadInspectorTabs, saveInspectorTabs, saveBrowserTabUrl } from '../scmPanel'
import { useEffect, useRef } from 'react'
import { isTauri } from './host'

const OPEN_REQUEST_EVENT = 'browser://open-request'

export interface BrowserOpenRequest { workspaceId: string; action: 'open' | 'reveal' | 'close'; surfaceId: string; url?: string }

export function useBrowserOpenRequest(onRequest: (request: BrowserOpenRequest) => void): void {
  const cb = useRef(onRequest)
  cb.current = onRequest

  useEffect(() => {
    if (!isTauri()) return undefined
    let disposed = false
    let unlisten: (() => void) | null = null

    void (async () => {
      const { listen } = await import('@tauri-apps/api/event')
      const dispose = await listen<BrowserOpenRequest>(OPEN_REQUEST_EVENT, (event) => {
        if (['open', 'reveal', 'close'].includes(event.payload.action) && typeof event.payload.surfaceId === 'string') cb.current(event.payload)
      })
      if (disposed) {
        dispose()
        return
      }
      unlisten = dispose
    })()

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])
}

export function routeBrowserOpenRequest(request: BrowserOpenRequest, revealWorkspace: (workspace: string) => void, open = openSideBrowser): void {
  const { workspaceId, action, surfaceId, url } = request
  const state = loadInspectorTabs(workspaceId)
  const surface = `browser:${surfaceId}` as const
  if (action !== 'open' && !state.openTabs.includes(surface)) return
  if (action === 'close') {
    const openTabs = state.openTabs.filter((tab) => tab !== surface)
    saveInspectorTabs(workspaceId, {openTabs, active: state.active === surface ? openTabs.at(-1) ?? null : state.active})
    localStorage.removeItem(`tr-inspector-browser-url:${workspaceId}:${surfaceId}`)
  }
  if (action === 'open') saveBrowserTabUrl(workspaceId, surfaceId, url ?? '')
  if (action !== 'close') revealWorkspace(workspaceId)
  open(surfaceId, url ?? '', workspaceId, action)
}
