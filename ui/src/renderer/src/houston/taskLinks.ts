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

/// The keys of the last loaded snapshot of each workspace. A terminal link can
/// only resolve a key the Tasks tab has actually seen, so a stray `HOU-9` in
/// prose is not clickable.
const taskIndexes = new Map<string, ReadonlyMap<string, number>>()

export function rememberTaskKeys(workspace: string, tasks: readonly TaskSummary[]): void {
  const byKey = new Map<string, number>()
  for (const task of tasks) byKey.set(task.key, task.id)
  taskIndexes.set(workspace, byKey)
}

export function taskIdForKey(workspace: string, key: string): number | null {
  return taskIndexes.get(workspace)?.get(key) ?? null
}
