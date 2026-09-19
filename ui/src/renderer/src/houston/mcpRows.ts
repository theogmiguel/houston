import type { AgentKind } from './generated/AgentKind'
import type { McpServer } from './generated/McpServer'
import type { McpToolState } from './generated/McpToolState'

export type CellState =
  | { kind: 'in-sync'; server: McpServer }
  | { kind: 'drifted'; server: McpServer }
  | { kind: 'disabled'; server: McpServer }
  | { kind: 'absent' }

export interface MatrixRow {
  name: string
  source: McpServer | null
  byTool: Partial<Record<AgentKind, McpServer>>
  hasDrift: boolean
}

export function buildRows(source: McpServer[], tools: McpToolState[]): MatrixRow[] {
  const rows = new Map<string, MatrixRow>()
  const fingerprints = new Map<string, Set<string>>()

  const touch = (name: string): MatrixRow => {
    let row = rows.get(name)
    if (!row) {
      row = { name, source: null, byTool: {}, hasDrift: false }
      rows.set(name, row)
      fingerprints.set(name, new Set())
    }
    return row
  }

  for (const server of source) {
    touch(server.name).source = server
    fingerprints.get(server.name)?.add(server.fingerprint)
  }
  for (const tool of tools) {
    for (const server of tool.servers) {
      touch(server.name).byTool[tool.tool] = server
      fingerprints.get(server.name)?.add(server.fingerprint)
    }
  }
  for (const [name, row] of rows) {
    row.hasDrift = (fingerprints.get(name)?.size ?? 0) > 1
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function cellFor(row: MatrixRow, tool: AgentKind): CellState {
  const server = row.byTool[tool]
  if (!server) return { kind: 'absent' }
  if (!server.enabled) return { kind: 'disabled', server }
  return { kind: row.hasDrift ? 'drifted' : 'in-sync', server }
}

export function cellTitle(cell: CellState, tool: string): string {
  switch (cell.kind) {
    case 'in-sync':
      return `In sync with your list — fingerprint ${cell.server.fingerprint}`
    case 'drifted':
      return `Differs from the others — fingerprint ${cell.server.fingerprint}`
    case 'disabled':
      return `Configured in ${tool} but switched off`
    case 'absent':
      return `Not configured in ${tool}`
  }
}

export function maskSecret(value: string): string {
  if (value.length === 0) return ''
  if (/^\$\{?[A-Za-z_]/.test(value)) return value
  if ([...value].length <= 6) return '••••'
  return `${[...value].slice(0, 3).join('')}••••`
}
