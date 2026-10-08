import { useEffect, useMemo, useState } from 'react'
import type { HoustonClient, PrInfo, PullRequestLink, SessionInfo } from './houston/client'
import { buildLinkedPullRequests, gridPrSources, type GridPrStack } from './components/panel/linkedPullRequests'

export function useLinkedPullRequests(
  client: HoustonClient | null,
  sessions: ReadonlyMap<number, SessionInfo>,
  paneIds: readonly number[],
  prsByDir: ReadonlyMap<string, { pr: PrInfo | null }>,
): PullRequestLink[] {
  const sources = useMemo(() => gridPrSources(sessions, paneIds, prsByDir), [paneIds, prsByDir, sessions])
  const [stacks, setStacks] = useState<GridPrStack[]>([])

  useEffect(() => {
    if (!client || sources.length === 0) {
      setStacks([])
      return
    }
    const pending = new Map<number, { dir: string; number: number }>()
    const requestedNumbers = new Set<number>()
    setStacks([])
    const unsubscribe = client.subscribe('pr_stack', (message) => {
      const request = pending.get(message.request)
      if (!request || request.dir !== message.dir) return
      pending.delete(message.request)
      if (message.stack) {
        setStacks((current) => [...current, {
          dir: message.dir,
          baseNumber: request.number,
          layers: message.stack!.layers,
        }])
      }
    })
    for (const source of sources) {
      if (requestedNumbers.has(source.pr.number)) continue
      requestedNumbers.add(source.pr.number)
      const request = client.prStack(source.dir, source.pr.number)
      pending.set(request, { dir: source.dir, number: source.pr.number })
    }
    return unsubscribe
  }, [client, sources])

  return useMemo(() => buildLinkedPullRequests(sources, stacks), [sources, stacks])
}
