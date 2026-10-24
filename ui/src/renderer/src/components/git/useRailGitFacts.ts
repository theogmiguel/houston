import { useEffect, useRef, useState } from 'react'
import type { GitFileStatus, HoustonClient } from '../../houston/client'
import { subscribeWindowParked, windowParked } from '../../windowParked'
import { createGitStatusPoller, type GitStatusPoller } from './gitStatusPoller'

export interface RailDiffTotals {
  added: number
  deleted: number
  ahead: number
  behind: number
  changedFiles: number
}

// Each refresh runs three git processes per workspace, and returning to the window
// should not pay that on every alt-tab: a focus-triggered refresh is honoured only
// when the last poll is older than this. The 60 s interval still bounds staleness.
export const FOCUS_REFRESH_MIN_MS = 10_000

function totals(files: GitFileStatus[], ahead: number, behind: number): RailDiffTotals {
  return files.reduce((sum, file) => ({
    added: sum.added + (file.added ?? 0),
    deleted: sum.deleted + (file.deleted ?? 0),
    ahead,
    behind,
    changedFiles: files.length,
  }), { added: 0, deleted: 0, ahead, behind, changedFiles: files.length })
}

export function useRailGitFacts(client: HoustonClient | null, dirs: readonly string[]): ReadonlyMap<string, RailDiffTotals> {
  const [facts, setFacts] = useState<Map<string, RailDiffTotals>>(new Map())
  const key = dirs.join('\0')
  const requestedDirs = key ? key.split('\0') : []
  const poller = useRef<GitStatusPoller | null>(null)
  // One poller per connection, so a changed directory set shares the in-flight bound with the requests still pending.
  useEffect(() => {
    if (!client) return
    const created = createGitStatusPoller(client)
    poller.current = created
    return () => {
      created.dispose()
      poller.current = null
    }
  }, [client])
  useEffect(() => {
    if (!client || requestedDirs.length === 0) return
    const wanted = new Set(requestedDirs)
    const unsubscribe = client.subscribe('git_status', (message) => {
      if (!wanted.has(message.dir) || message.base != null) return
      setFacts((current) => new Map(current).set(message.dir, totals(message.files, message.ahead, message.behind)))
    })
    let lastPollAt = 0
    // A window hidden to the tray keeps running; nobody reads the rail, so polls park
    // and the reveal refreshes once, throttled like a focus return.
    const refresh = (): void => {
      if (windowParked()) return
      lastPollAt = Date.now()
      poller.current?.request(requestedDirs)
    }
    const onFocus = (): void => {
      if (Date.now() - lastPollAt < FOCUS_REFRESH_MIN_MS) return
      refresh()
    }
    refresh()
    window.addEventListener('focus', onFocus)
    const offParked = subscribeWindowParked(() => {
      if (windowParked()) poller.current?.dropQueued()
      else onFocus()
    })
    const timer = window.setInterval(refresh, 60_000)
    return () => {
      unsubscribe()
      poller.current?.dropQueued()
      window.removeEventListener('focus', onFocus)
      offParked()
      window.clearInterval(timer)
    }
  }, [client, key])
  return facts
}
