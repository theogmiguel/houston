import type { AgentKind } from './generated/AgentKind'
import type { SkillEntry } from './generated/SkillEntry'
import type { SkillToolState } from './generated/SkillToolState'

export type SkillCell =
  | { kind: 'same'; entry: SkillEntry }
  | { kind: 'differs'; entry: SkillEntry }
  | { kind: 'inherited' }
  | { kind: 'missing' }

export interface SkillRow {
  name: string
  claude: SkillEntry | null
  byTool: Partial<Record<AgentKind, SkillEntry>>
  hasDrift: boolean
}

export function buildSkillRows(tools: SkillToolState[]): SkillRow[] {
  const rows = new Map<string, SkillRow>()
  const digests = new Map<string, Set<string>>()

  for (const tool of tools) {
    for (const entry of tool.skills) {
      let row = rows.get(entry.name)
      if (!row) {
        row = { name: entry.name, claude: null, byTool: {}, hasDrift: false }
        rows.set(entry.name, row)
        digests.set(entry.name, new Set())
      }
      row.byTool[tool.tool] = entry
      if (tool.tool === 'claude') row.claude = entry
      digests.get(entry.name)?.add(entry.digest)
    }
  }
  for (const [name, row] of rows) {
    row.hasDrift = (digests.get(name)?.size ?? 0) > 1
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function skillCellFor(row: SkillRow, tool: SkillToolState): SkillCell {
  const entry = row.byTool[tool.tool]
  if (entry) return { kind: row.hasDrift ? 'differs' : 'same', entry }
  if (tool.inherits_claude && row.claude) return { kind: 'inherited' }
  return { kind: 'missing' }
}

export function needsPush(row: SkillRow, tool: SkillToolState): boolean {
  if (tool.tool === 'claude' || !row.claude) return false
  const entry = row.byTool[tool.tool]
  return !entry || entry.digest !== row.claude.digest
}

export function skillCellTitle(cell: SkillCell, tool: string): string {
  switch (cell.kind) {
    case 'same':
      return `Its own copy, identical to the others — ${cell.entry.path}`
    case 'differs':
      return `Its own copy, and it differs from another tool's — ${cell.entry.path}`
    case 'inherited':
      return `No copy of its own, but ${tool} reads Claude Code's skills directory, so it sees this one`
    case 'missing':
      return `${tool} cannot see this skill`
  }
}
