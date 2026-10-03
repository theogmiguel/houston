import type { TaskSummary } from './generated/TaskSummary'

/// `HOU-<n>` as a standalone token: the negative lookarounds keep it from
/// matching inside a longer identifier such as `XHOU-1` or `HOU-12x`.
export const TASK_KEY_RE = /(?<![A-Za-z0-9_-])HOU-(?<number>\d{1,9})(?![A-Za-z0-9_-])/g

export interface TaskKeyMatch {
  key: string
  index: number
  length: number
}

export function matchTaskKeys(text: string): TaskKeyMatch[] {
  const matches: TaskKeyMatch[] = []
  for (const match of text.matchAll(TASK_KEY_RE)) {
    if (match.index === undefined) continue
    matches.push({ key: match[0], index: match.index, length: match[0].length })
  }
  return matches
}

/// Loaded snapshots index global keys for terminal links; an unseen key is
/// not clickable. Scope changes replace only their own snapshot.
const taskIndexes = new Map<string, ReadonlyMap<string, number>>()

export function rememberTaskKeys(workspace: string, tasks: readonly TaskSummary[]): void {
  const byKey = new Map<string, number>()
  for (const task of tasks) byKey.set(task.key, task.id)
  taskIndexes.set(workspace, byKey)
}

export function taskIdForKey(_workspace: string, key: string): number | null {
  for (const index of taskIndexes.values()) {
    const id = index.get(key)
    if (id !== undefined) return id
  }
  return null
}
