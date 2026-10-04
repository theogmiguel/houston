import { useSyncExternalStore } from 'react'
import type { RailDiffTotals } from './useRailGitFacts'

let facts: ReadonlyMap<string, RailDiffTotals> = new Map()
const listeners = new Set<() => void>()

export function rememberRailGitFacts(value: ReadonlyMap<string, RailDiffTotals>): void {
  facts = value
  for (const listener of listeners) listener()
}

export function useRailGitCache(): ReadonlyMap<string, RailDiffTotals> {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    () => facts,
    () => facts,
  )
}
