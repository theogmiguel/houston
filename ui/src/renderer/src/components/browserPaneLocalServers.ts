import { useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { HoustonClient } from '../houston/client'
import type { LocalServer } from '../houston/generated/LocalServer'
import type { ServerMsg } from '../houston/generated/ServerMsg'

type LocalServerReply = Extract<ServerMsg, { type: 'workspace_local_servers' }>

// 3 s keeps the list responsive while an agent boots its dev server; after two
// identical replies the set has settled and 10 s bounds how long a new server
// stays unnoticed by an idle pane.
const POLL_MS = 3000
const SETTLED_POLL_MS = 10_000

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
    let signature: string | null = null
    let identical = 0
    let timer = 0
    const unsubscribe = client.subscribe('workspace_local_servers', (message) => {
      if (message.workspace !== workspaceDir) return
      setReply(message)
      const next = JSON.stringify([message.servers, message.unsupported, message.truncated])
      identical = next === signature ? identical + 1 : 0
      signature = next
    })
    const refresh = (): void => {
      client.workspaceLocalServers(workspaceDir)
      // The reply for this request usually arrived through the subscription above;
      // identical counts the repeats seen, so 1 means two identical replies in a row.
      timer = window.setTimeout(refresh, identical >= 1 ? SETTLED_POLL_MS : POLL_MS)
    }
    refresh()
    return () => {
      unsubscribe()
      window.clearTimeout(timer)
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
