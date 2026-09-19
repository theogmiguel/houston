import { describe, expect, it } from 'vitest'
import { buildRows, cellFor, cellTitle, maskSecret } from './mcpRows'
import type { McpServer } from './generated/McpServer'
import type { McpToolState } from './generated/McpToolState'
import type { AgentKind } from './generated/AgentKind'

function server(name: string, fingerprint: string, enabled = true): McpServer {
  return {
    name,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    env: [],
    url: null,
    headers: [],
    cwd: null,
    enabled,
    fingerprint,
    destinations: []
  }
}

function column(tool: AgentKind, servers: McpServer[], detected = true): McpToolState {
  return { tool, path: `/home/dev/${tool}`, detected, servers, error: null }
}

describe('the MCP matrix fold (row 36)', () => {
  it('agrees across tools that spell a server differently but mean the same one', () => {
    const rows = buildRows(
      [server('docs', 'http|https://x/mcp||1')],
      [
        column('claude', [server('docs', 'http|https://x/mcp||1')]),
        column('codex', [server('docs', 'http|https://x/mcp||1')])
      ]
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].hasDrift).toBe(false)
    expect(cellFor(rows[0], 'claude').kind).toBe('in-sync')
  })

  it('calls it drift when the entries that exist disagree', () => {
    const rows = buildRows(
      [server('docs', 'A')],
      [column('claude', [server('docs', 'A')]), column('codex', [server('docs', 'B')])]
    )
    expect(rows[0].hasDrift).toBe(true)
    expect(cellFor(rows[0], 'codex').kind).toBe('drifted')
  })

  it('does not call a missing entry drift', () => {
    const rows = buildRows(
      [server('docs', 'A')],
      [column('claude', [server('docs', 'A')]), column('cursor', [], false)]
    )
    expect(rows[0].hasDrift).toBe(false)
    expect(cellFor(rows[0], 'cursor')).toEqual({ kind: 'absent' })
  })

  it('shows a server a tool has and Houston does not, rather than hiding it', () => {
    const rows = buildRows([], [column('opencode', [server('sentry', 'S')])])
    expect(rows.map((r) => r.name)).toEqual(['sentry'])
    expect(rows[0].source).toBeNull()
  })

  it('reports a switched-off entry as its own state, not as absent', () => {
    const rows = buildRows(
      [server('docs', 'A')],
      [column('claude', [server('docs', 'A-off', false)])]
    )
    const cell = cellFor(rows[0], 'claude')
    expect(cell.kind).toBe('disabled')
    expect(cellTitle(cell, 'Claude Code')).toContain('switched off')
  })

  it('sorts rows by name so the matrix is stable between reads', () => {
    const rows = buildRows(
      [server('zeta', 'Z'), server('alpha', 'A')],
      [column('codex', [server('mid', 'M')])]
    )
    expect(rows.map((r) => r.name)).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('masks a literal secret but never the name of one', () => {
    expect(maskSecret('${AI_MEMORY_TOKEN}')).toBe('${AI_MEMORY_TOKEN}')
    expect(maskSecret('$TOKEN')).toBe('$TOKEN')
    expect(maskSecret('abc')).toBe('••••')
    expect(maskSecret('sk-live-1234')).toBe('sk-••••')
    expect(maskSecret('')).toBe('')
  })
})
