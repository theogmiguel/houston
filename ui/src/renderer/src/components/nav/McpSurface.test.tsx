// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { McpServer } from '../../houston/generated/McpServer'
import type { McpToolState } from '../../houston/generated/McpToolState'
import { McpSurface } from './McpSurface'

function noop(): void {}

function server(name: string): McpServer {
  return {
    name,
    transport: 'stdio',
    command: 'npx',
    args: [],
    env: [],
    url: null,
    headers: [],
    cwd: null,
    enabled: true,
    fingerprint: 'A',
    destinations: []
  }
}

function column(tool: McpToolState['tool']): McpToolState {
  return { tool, path: `/home/dev/.${tool}/config`, detected: true, servers: [server('context7')], error: null }
}

describe('McpSurface — managed MCP connections', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render(props: Partial<React.ComponentProps<typeof McpSurface>> = {}): void {
    act(() => {
      root.render(
        <McpSurface
          source={[]}
          tools={[]}
          results={[]}
          checks={[]}
          loaded={true}
          onRefresh={noop}
          onSync={noop}
          onImport={noop}
          onSetEnabled={noop}
          onUpsertServer={noop}
          onRemoveServer={noop}
          onTest={noop}
          onOpenSource={noop}
          {...props}
        />
      )
    })
  }

  async function settleManager(): Promise<void> {
    await act(async () => { await import('../McpManager') })
    for (let i = 0; i < 100; i++) {
      if (container.querySelector('[data-testid="mcp-manager"]')) return
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    }
    throw new Error(`McpManager never left its Suspense fallback: ${container.textContent}`)
  }

  it('shows the loading state and then a useful empty page', async () => {
    render({ loaded: false })
    await settleManager()
    expect(container.textContent).toContain('Opening servers…')

    render({ loaded: true })
    await settleManager()
    expect(container.textContent).toContain('No MCP servers')
    expect(container.textContent).not.toContain('from the list below')
  })

  it('renders managed CLI columns and server rows instead of a skills matrix', async () => {
    render({ source: [server('context7')], tools: [column('claude')] })
    await settleManager()
    expect(container.textContent).toContain('context7')
    expect(container.querySelector('[data-testid="table-frame"]')).not.toBeNull()
    expect(container.textContent).toContain('Claude Code')
    expect(container.textContent).toContain('Codex')
    expect(container.querySelector('[data-skill-cell]')).toBeNull()
    expect(container.textContent).not.toContain('What skills each CLI can see')
  })

  it('offers the page Add server action for an empty state', async () => {
    render({ source: [], tools: [], loaded: true })
    await settleManager()
    const add = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Add server')
    expect(add).toBeTruthy()
    act(() => add!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
  })
})
