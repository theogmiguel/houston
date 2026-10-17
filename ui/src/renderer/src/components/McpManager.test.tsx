// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
    tools: [tool('claude'), tool('codex'), tool('opencode')],
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
    expect(screen.getByRole('heading', { name: 'MCP servers' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Claude Code' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Codex' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'OpenCode' })).toBeTruthy()
    expect(screen.queryByRole('columnheader', { name: 'Cursor' })).toBeNull()
    expect(screen.getByText(/Not managed here:/)).toBeTruthy()
  })

  it('shows failed connection reasons inline and toggles one server destination through existing handlers', () => {
    const onUpsertServer = vi.fn()
    const onSync = vi.fn()
    render(<McpManager {...props({
      tools: [{ ...tool('claude'), error: 'npx was not found on PATH' }, tool('codex'), tool('opencode')],
      onUpsertServer,
      onSync
    })} />)
    expect(screen.getAllByText('Failed')).toHaveLength(1)
    expect(screen.getByText('npx').tagName).toBe('CODE')
    expect(screen.getAllByText(/was not found on PATH/)).toHaveLength(1)
    fireEvent.click(screen.getByTestId('mcp-cell-claude-github'))
    expect(onUpsertServer).toHaveBeenCalledWith('github', expect.objectContaining({ destinations: ['codex', 'opencode'] }))
    expect(onSync).toHaveBeenCalledWith('claude')
  })

  it('shows absent agent destinations as off while keeping server check failures scoped', () => {
    render(<McpManager {...props({
      tools: [tool('claude'), tool('codex', []), tool('opencode', [])],
      checks: [['github', { state: 'failed', message: 'npx was not found on PATH' }]]
    })} />)
    expect(screen.getByTestId('mcp-cell-claude-github').textContent).toContain('In sync')
    expect(screen.getByText(/Houston can't start github/)).toBeTruthy()
    expect(screen.getByTestId('mcp-cell-codex-github').textContent).toBe('Off')
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy()
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

  it('keeps the server and agent columns when empty, without a hint about cells that are not there', () => {
    render(<McpManager {...props({ source: [], tools: [], loaded: true })} />)
    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent)
    expect(headers).toEqual(expect.arrayContaining(['Server', 'Claude Code', 'Codex', 'OpenCode']))
    expect(screen.getByRole('heading', { name: 'No MCP servers' })).toBeTruthy()
    expect(document.body.textContent).toContain('Not managed here: ZCode, Antigravity.')
    expect(document.body.textContent).not.toContain('Click a cell')
  })
})

it('reports failed tests at server level and retries without duplicating the failure in agent cells', () => {
  const onTest = vi.fn()
  render(<McpManager {...props({ embedded: true, onTest, checks: [['github', { state: 'failed', message: 'npx was not found on PATH' }]] })} />)
  expect(screen.getAllByText(/Houston can't start github/)).toHaveLength(1)
  expect(screen.queryByText('Failed')).toBeNull()
  expect(screen.queryByText('Slack')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
  expect(onTest).toHaveBeenCalledWith('github')
  expect(document.querySelectorAll('main')).toHaveLength(0)
})

it('expands a Settings server and toggles only its owning agent destination', () => {
  const onSync = vi.fn(), onUpsertServer = vi.fn()
  render(<McpManager {...props({ embedded: true, onSync, onUpsertServer })} />)
  expect(screen.queryByRole('table')).toBeNull()
  const summary = screen.getByText('github').closest('summary')!
  fireEvent.click(summary)
  expect(summary.parentElement?.querySelector('input')).toBeNull()
  fireEvent.click(screen.getByRole('switch', { name: 'github in Claude Code' }))
  expect(onUpsertServer).toHaveBeenCalledWith('github', expect.objectContaining({ destinations: ['codex', 'opencode'] }))
  expect(onSync).toHaveBeenCalledWith('claude')
  fireEvent.click(screen.getByRole('button', { name: 'Edit command' }))
  expect(screen.getByRole('dialog', { name: 'Edit github' })).toBeTruthy()
})

it('keeps fix guidance and Edit command inside the failure notice, and counts the filter segments', () => {
  const onUpsertServer = vi.fn()
  render(<McpManager {...props({ embedded: true, source: [server('github'), server('linear')], tools: [tool('claude', [server('github'), server('linear')])], onUpsertServer, checks: [['github', { state: 'failed', message: 'npx was not found on PATH' }]] })} />)
  const notice = screen.getByRole('alert')
  expect(notice.textContent).toContain('Install Node.js, or give the command an absolute path such as /usr/local/bin/npx.')
  fireEvent.click(within(notice).getByRole('button', { name: 'Edit command' }))
  expect(screen.getByRole('dialog', { name: 'Edit github' })).toBeTruthy()
  const segments = screen.getByRole('radiogroup', { name: 'Filter servers' }).textContent
  expect(segments).toContain('All2')
  expect(segments).toContain('Configured2')
  expect(segments).toContain('Problems1')
})
