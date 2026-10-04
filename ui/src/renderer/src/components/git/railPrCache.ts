import { useSyncExternalStore } from 'react'
import type { GhState, PrInfo } from '../../houston/client'

export interface RailPrState {
  gh: GhState
  pr: PrInfo | null
}

let cache = new Map<string, RailPrState>()
const listeners = new Set<() => void>()

export function rememberRailPr(dir: string, status: RailPrState): void {
  cache = new Map(cache).set(dir, status)
  for (const listener of listeners) listener()
}

export function useRailPrCache(): ReadonlyMap<string, RailPrState> {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    () => cache,
    () => cache,
  )
}
