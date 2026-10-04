// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpServer } from '../houston/generated/McpServer'
import type { McpToolState } from '../houston/generated/McpToolState'
import type { McpManagerProps } from './McpManager'
import { McpManager } from './McpManager'

function server(name = 'github'): McpServer {
  return { name, transport: 'stdio', command: 'npx', args: ['-y', 'server'], env: [], url: null, headers: [], cwd: null, enabled: true, fingerprint: 'fp', destinations: [] }
}

function tool(tool: McpToolState['tool'], servers: McpServer[] = [server()]): McpToolState {
  return { tool, path: `~/.${tool}/mcp.json`, detected: true, servers, error: null }
}

function props(overrides: Partial<McpManagerProps> = {}): McpManagerProps {
  return {
    source: [server()],
    tools: [tool('claude'), tool('codex'), tool('opencode'), tool('cursor')],
    results: [],
    checks: [],
    loaded: true,
    onRefresh: () => {},
    onSync: () => {},
    onImport: () => {},
    onSetEnabled: () => {},
    onUpsertServer: () => {},
    onRemoveServer: () => {},
    onTest: () => {},
    onOpenSource: () => {},
    ...overrides
  }
}

afterEach(cleanup)

describe('Connections matrix', () => {
  it('shows managed CLI columns and explains providers not managed here', () => {
    render(<McpManager {...props()} />)
    expect(screen.getByRole('heading', { name: 'Connections' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Claude Code' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Codex' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'OpenCode' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Cursor' })).toBeTruthy()
    expect(screen.getByText(/Not managed here:/)).toBeTruthy()
  })

  it('shows failed connection reasons inline and toggles one server destination through existing handlers', () => {
    const onUpsertServer = vi.fn()
    const onSync = vi.fn()
    render(<McpManager {...props({
      tools: [{ ...tool('claude'), error: 'npx was not found on PATH' }, tool('codex'), tool('opencode'), tool('cursor')],
      onUpsertServer,
      onSync
    })} />)
    expect(screen.getAllByText('Failed')).toHaveLength(1)
    expect(screen.getByText('npx').tagName).toBe('CODE')
    expect(screen.getAllByText(/was not found on PATH/)).toHaveLength(1)
    fireEvent.click(screen.getByTestId('mcp-cell-claude-github'))
    expect(onUpsertServer).toHaveBeenCalledWith('github', expect.objectContaining({ destinations: ['codex', 'opencode', 'cursor'] }))
    expect(onSync).toHaveBeenCalledWith('claude')
  })

  it('shows absent agent destinations as off while keeping server check failures scoped', () => {
    render(<McpManager {...props({
      tools: [tool('claude'), tool('codex', []), tool('opencode', []), tool('cursor', [])],
      checks: [['github', { state: 'failed', message: 'npx was not found on PATH' }]]
    })} />)
    expect(screen.getByTestId('mcp-cell-claude-github').textContent).toContain('Failed')
    expect(screen.getByTestId('mcp-cell-codex-github').textContent).toBe('Off')
    expect(screen.getByText('npx').tagName).toBe('CODE')
  })

  it('puts a bordered row action beside the overflow menu', () => {
    render(<McpManager {...props({
      source: [server('github'), server('linear')],
      checks: [['github', { state: 'failed', message: 'npx was not found on PATH' }]]
    })} />)
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'More actions for linear' })).toBeTruthy()
  })

  it('uses the page Add server action for an empty state', () => {
    render(<McpManager {...props({ source: [], tools: [], loaded: true })} />)
    expect(screen.getByRole('heading', { name: 'No MCP servers' })).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Add server' })[0])
    expect(screen.getByRole('dialog', { name: 'Add server' })).toBeTruthy()
  })
})
