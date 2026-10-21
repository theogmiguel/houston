import type { ChangeRow } from './changes'
import type { DiffState } from './useGitStatusSubscription'
import type { DiffFindSource } from './diffFind'
import { diffFindLines } from './DiffBody'

/** What Changes renders right now: every expanded inline diff, or the selected file's diff. */
export function changesFindSources({ inline, visibleRows, expandedPaths, inlineDiffs, selectedRow, diff }: {
  inline: boolean
  visibleRows: readonly ChangeRow[]
  expandedPaths: ReadonlySet<string>
  inlineDiffs: ReadonlyMap<string, DiffState>
  selectedRow: ChangeRow | null
  diff: DiffState | null
}): DiffFindSource[] {
  const source = (row: ChangeRow, state: DiffState | null | undefined): DiffFindSource[] =>
    state && !row.blocked ? [{ key: row.path, lines: diffFindLines(state.patch), truncated: state.truncated }] : []
  if (inline) return visibleRows.filter((row) => expandedPaths.has(row.path)).flatMap((row) => source(row, inlineDiffs.get(row.path)))
  if (selectedRow === null || diff === null || diff.path !== selectedRow.path) return []
  return source(selectedRow, diff)
}
