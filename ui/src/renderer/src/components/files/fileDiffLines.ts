export interface FileDiffLines {
  added: Set<number>
  modified: Set<number>
  deleted: Set<number>
}

interface PendingChange {
  added: number[]
  deleted: number
  newLine: number
}

export function parseFileDiffLines(patch: string): FileDiffLines {
  const result: FileDiffLines = { added: new Set(), modified: new Set(), deleted: new Set() }
  let newLine = 0
  let pending: PendingChange = { added: [], deleted: 0, newLine: 0 }
  const flush = (): void => {
    const paired = Math.min(pending.added.length, pending.deleted)
    pending.added.slice(0, paired).forEach((line) => result.modified.add(line))
    pending.added.slice(paired).forEach((line) => result.added.add(line))
    if (pending.deleted > paired) result.deleted.add(Math.max(1, pending.newLine))
    pending = { added: [], deleted: 0, newLine }
  }

  for (const line of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      flush()
      newLine = Number(hunk[1])
      pending = { added: [], deleted: 0, newLine }
    } else if (line.startsWith('@@')) {
      flush()
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      pending.added.push(newLine++)
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      if (pending.added.length === 0 && pending.deleted === 0) pending.newLine = newLine
      pending.deleted += 1
    } else if (line.startsWith(' ')) {
      flush()
      newLine += 1
    } else if (line.startsWith('\\ No newline')) {
      continue
    } else {
      flush()
    }
  }
  flush()
  return result
}
