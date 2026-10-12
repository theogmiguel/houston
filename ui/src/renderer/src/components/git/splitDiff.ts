import type { DiffLineKind } from '../ui/Diff'

export interface NumberedDiffLine {
  kind: DiffLineKind
  text: string
  oldNumber: number | null
  newNumber: number | null
}

export type SplitDiffRow = { header: NumberedDiffLine } | { old: NumberedDiffLine | null; new: NumberedDiffLine | null }

export function pairDiffLines(lines: NumberedDiffLine[]): SplitDiffRow[] {
  const rows: SplitDiffRow[] = []
  let deleted: NumberedDiffLine[] = []
  let added: NumberedDiffLine[] = []
  const flush = (): void => {
    for (let i = 0; i < Math.max(deleted.length, added.length); i++) {
      rows.push({ old: deleted[i] ?? null, new: added[i] ?? null })
    }
    deleted = []
    added = []
  }
  for (const line of lines) {
    if (line.kind === 'del') {
      if (added.length > 0) flush()
      deleted.push(line)
    } else if (line.kind === 'add') added.push(line)
    else {
      flush()
      rows.push(line.kind === 'ctx' ? { old: line, new: line } : { header: line })
    }
  }
  flush()
  return rows
}
