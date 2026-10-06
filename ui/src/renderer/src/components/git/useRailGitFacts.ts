import { useEffect, useState } from 'react'
import type { GitFileStatus, HoustonClient } from '../../houston/client'

export interface RailDiffTotals {
  added: number
  deleted: number
  ahead: number
  behind: number
  changedFiles: number
}

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
  useEffect(() => {
    if (!client || requestedDirs.length === 0) return
    const wanted = new Set(requestedDirs)
    const unsubscribe = client.subscribe('git_status', (message) => {
      if (!wanted.has(message.dir) || message.base != null) return
      setFacts((current) => new Map(current).set(message.dir, totals(message.files, message.ahead, message.behind)))
    })
    const refresh = (): void => { for (const dir of requestedDirs) client.gitStatus(dir, null) }
    refresh()
    window.addEventListener('focus', refresh)
    const timer = window.setInterval(refresh, 60_000)
    return () => {
      unsubscribe()
      window.removeEventListener('focus', refresh)
      window.clearInterval(timer)
    }
  }, [client, key])
  return facts
}
