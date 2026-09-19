import type { PaneKey } from './tree'

export type PaneType = 'terminal' | 'editor' | 'browser' | 'git' | 'skills' | 'files'
export type DetachablePaneType = Exclude<
  PaneType,
  'browser' | 'editor' | 'git' | 'skills' | 'files'
>

export function isDetachable(paneType: PaneType): paneType is DetachablePaneType {
  return paneType === 'terminal'
}

export interface DetachPayload {
  paneId: PaneKey
  sourceWorkspaceId: string
  paneType: DetachablePaneType
  sessionId: number
}

export async function resolveDetachRoot(
  payload: DetachPayload,
  liveCwd: (session: number) => Promise<string>
): Promise<string> {
  try {
    return await liveCwd(payload.sessionId)
  } catch {
    return payload.sourceWorkspaceId
  }
}

export function isWorkspaceEmptyOfSessionsAndSwarms(
  path: string,
  excludeSessionId: number | null,
  sessions: Iterable<{ id: number; project_dir: string }>,
  swarms: Iterable<{ root_dir: string }>,
  remainingPanesInSourceTree: number
): boolean {
  if (remainingPanesInSourceTree > 0) return false
  for (const s of sessions) {
    if (s.project_dir === path && s.id !== excludeSessionId) return false
  }
  for (const s of swarms) {
    if (s.root_dir === path) return false
  }
  return true
}

export interface DetachOps {
  resolveRoot: () => Promise<string>
  addWorkspace: (root: string) => void
  reparentSession: (session: number, root: string) => Promise<void>
  removePaneFromSource: () => void
  isSourceEmptyAfterDetach: () => boolean
  removeSourceWorkspace: () => void
  selectWorkspace: (root: string) => void
  onError?: (error: unknown) => void
}

export async function detachPaneToNewWorkspace(
  payload: DetachPayload,
  ops: DetachOps
): Promise<void> {
  let root: string
  try {
    root = await ops.resolveRoot()
    await ops.reparentSession(payload.sessionId, root)
    ops.addWorkspace(root)
    ops.removePaneFromSource()
  } catch (e) {
    ops.onError?.(e)
    return
  }
  if (root !== payload.sourceWorkspaceId && ops.isSourceEmptyAfterDetach()) {
    ops.removeSourceWorkspace()
  }
  ops.selectWorkspace(root)
}
