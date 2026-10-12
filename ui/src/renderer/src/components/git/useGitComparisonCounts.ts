import { useEffect, useState } from 'react'
import type { HoustonClient } from '../../houston/client'

export function useGitComparisonCounts(client: HoustonClient | null, dir: string | null, defaultBase: string | null): { working: number | null; branch: number | null } {
  const [working, setWorking] = useState<number | null>(null)
  const [branch, setBranch] = useState<number | null>(null)
  useEffect(() => { setWorking(null); setBranch(null) }, [client, dir])
  useEffect(() => {
    setBranch(null)
    if (!client || !dir) return
    const off = client.subscribe('git_status', (message) => {
      if (message.dir !== dir) return
      const count = new Set(message.files.map((file) => file.path)).size
      if (!message.base) {
        setWorking(count)
        if (defaultBase) client.gitStatus(dir, defaultBase)
      } else if (message.base === defaultBase) setBranch(count)
    })
    client.gitStatus(dir, null)
    if (defaultBase) client.gitStatus(dir, defaultBase)
    return off
  }, [client, dir, defaultBase])
  return { working, branch }
}
