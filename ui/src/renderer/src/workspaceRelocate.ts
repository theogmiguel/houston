import type { Dispatch, SetStateAction } from 'react'
import type { ServerMsg } from './houston/generated/ServerMsg'
import type { HoustonClient } from './houston/client'
import { pickDirectories } from './houston/bridge'
import { gridStorageKey, loadGrids, type GridMeta, type LayoutState } from './layout/tree'

type Set<T> = Dispatch<SetStateAction<T>>

export interface RelocateState {
  gridsByWs: Map<string, GridMeta[]>
  setWsColors: Set<Record<string, string>>
  setLayouts: Set<Map<string, LayoutState>>
  setGridsByWs: Set<Map<string, GridMeta[]>>
  setSelectedGridByWs: Set<Map<string, string>>
  setWsPinned: Set<string[]>
  setWsOrder: Set<string[]>
  setWsRenaming: Set<string | null>
  setSelectedWs: Set<string>
}

function moveItem(oldKey: string, newKey: string): void {
  try {
    const value = localStorage.getItem(oldKey)
    if (value === null) return
    localStorage.setItem(newKey, value)
    localStorage.removeItem(oldKey)
  } catch {}
}

/** The daemon re-pointed a moved workspace: this client's state keyed by the old path
 *  follows it, mirroring what App's dropWorkspaceLocalState removes. */
export function moveWorkspaceLocalState(from: string, to: string, s: RelocateState): void {
  const rekey = <T>(prev: Map<string, T>): Map<string, T> => {
    const value = prev.get(from)
    if (value === undefined) return prev
    const next = new Map(prev)
    next.delete(from)
    return next.set(to, value)
  }
  s.setWsColors((prev) => {
    if (!(from in prev)) return prev
    const { [from]: color, ...rest } = prev
    return { ...rest, [to]: color }
  })
  const grids = s.gridsByWs.get(from) ?? loadGrids(from)
  const gridKeys = grids.map((g) => [gridStorageKey(from, g.id), gridStorageKey(to, g.id)] as const)
  for (const [oldKey, newKey] of gridKeys) moveItem(`tr-layout:${oldKey}`, `tr-layout:${newKey}`)
  moveItem(`tr-grids:${from}`, `tr-grids:${to}`)
  s.setLayouts((prev) => {
    let next = prev
    for (const [oldKey, newKey] of gridKeys) {
      const layout = next.get(oldKey)
      if (layout === undefined) continue
      if (next === prev) next = new Map(prev)
      next.delete(oldKey)
      next.set(newKey, layout)
    }
    return next
  })
  s.setGridsByWs(rekey)
  s.setSelectedGridByWs(rekey)
  const swap = (prev: string[]): string[] => (prev.includes(from) ? prev.map((p) => (p === from ? to : p)) : prev)
  s.setWsPinned(swap)
  s.setWsOrder(swap)
  s.setWsRenaming((cur) => (cur === from ? null : cur))
  s.setSelectedWs((cur) => (cur === from ? to : cur))
}

export function relocatedNotice(msg: Extract<ServerMsg, { type: 'workspace_relocated' }>): {
  code: string
  title: string
  body: string
} {
  const { worktrees, sessions, notes } = msg.moved
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
  return {
    code: `workspace-relocated:${msg.to}`,
    title: `Workspace now at ${msg.to}`,
    body: [`${plural(sessions, 'session')} and ${plural(worktrees, 'worktree')} followed.`, ...notes].join(' ')
  }
}

/** Locate moved folder…: pick the new folder, resolving a WSL pick to its in-distro path. */
export async function locateMovedFolder(
  client: HoustonClient,
  path: string,
  pushError: (message: string) => void
): Promise<void> {
  const pick = (await pickDirectories())?.[0]
  if (pick === undefined) return
  const resolved = pick.startsWith('\\\\')
    ? await (await import('./houston/workspacePick')).resolveWorkspacePick(pick)
    : { wire: pick, path: pick }
  if ('refusal' in resolved) {
    pushError(resolved.refusal)
    return
  }
  client.relocateWorkspace(path, resolved.wire)
}
