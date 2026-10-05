import { useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { HoustonClient } from '../houston/client'
import type { LocalServer } from '../houston/generated/LocalServer'
import type { ServerMsg } from '../houston/generated/ServerMsg'

type LocalServerReply = Extract<ServerMsg, { type: 'workspace_local_servers' }>

export function useBrowserPaneLocalServers(
  client: HoustonClient | undefined,
  workspaceDir: string,
  fresh: boolean,
  hiddenByExpand: boolean | undefined,
  gridHidden: boolean
): { servers: LocalServer[]; unsupported: string | null; truncated: boolean } {
  const [reply, setReply] = useState<LocalServerReply | null>(null)

  useEffect(() => {
    if (!client || !fresh || hiddenByExpand || gridHidden) return
    const unsubscribe = client.subscribe('workspace_local_servers', (message) => {
      if (message.workspace === workspaceDir) setReply(message)
    })
    const refresh = (): void => client.workspaceLocalServers(workspaceDir)
    refresh()
    // Three seconds keeps the list responsive while limiting repeated /proc scans.
    const interval = window.setInterval(refresh, 3000)
    return () => {
      unsubscribe()
      window.clearInterval(interval)
    }
  }, [client, fresh, gridHidden, hiddenByExpand, workspaceDir])

  const matching = reply?.workspace === workspaceDir
  return {
    servers: matching ? reply.servers : [],
    unsupported: matching ? reply.unsupported : null,
    truncated: Boolean(matching && reply.truncated)
  }
}

export function hasBrowserPage(
  tabs: Array<{ url: string | null }>,
  surfaceMountFailed: boolean,
  failMsg: string | null
): boolean {
  return tabs.some((tab) => tab.url !== null) && !surfaceMountFailed && failMsg === null
}

export function tabFailureHandler(
  tabId: number,
  activeTabId: number,
  setFailMsg: (message: string | null) => void,
  setFailureAttempts: Dispatch<SetStateAction<number>>,
  setDetails: Dispatch<SetStateAction<boolean>>
): (message: string | null) => void {
  return (message) => {
    if (tabId !== activeTabId) return
    setFailMsg(message)
    setFailureAttempts((count) => count + 1)
    setDetails(message !== null)
  }
}
