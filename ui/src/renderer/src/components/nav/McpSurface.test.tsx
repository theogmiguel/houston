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

describe('McpSurface — servers, not the skills library', () => {
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
    for (let i = 0; i < 60; i++) {
      if (
        container.querySelector('[data-testid="mcp-manager"]') ||
        container.querySelector('[data-testid="mcp-loading"]')
      ) {
        return
      }
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5))
      })
    }
    throw new Error('McpManager never left its Suspense fallback')
  }

  it('renders something real with zero servers and no tools loaded', async () => {
    render({ loaded: false })
    await settleManager()
    expect(container.textContent).toContain('Asking the daemon what each tool has')

    render({ loaded: true })
    await settleManager()
    expect(container.textContent).toContain('No MCP servers anywhere yet')
  })

  it('renders the server list and never the skills matrix', async () => {
    render({ source: [server('context7')], tools: [column('claude')] })
    await settleManager()
    expect(container.querySelector('[data-testid="list-detail-item"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="status-icon"]')).not.toBeNull()
    expect(container.querySelector('[data-skill-cell]')).toBeNull()
    expect(container.textContent).not.toContain('What skills each CLI can see')
  })

  it('a list with nothing in it says what to do, not just a count of zero', async () => {
    render({ source: [], tools: [column('claude')] })
    await settleManager()
    const empty = container.querySelector('[data-testid="mcp-list-empty"]')
    expect(empty).not.toBeNull()
    expect(empty!.textContent).toContain('No servers yet')
    expect(empty!.textContent).toContain(
      'Add one, or import a server one of your tools already has from the list below.'
    )
    expect(container.querySelector('[data-testid="list-detail-item"]')).toBeNull()
  })

  it('refreshes from the head, and keeps Sync all beside it', async () => {
    let refreshed = 0
    render({ source: [server('context7')], tools: [column('claude')], onRefresh: () => (refreshed += 1) })
    await settleManager()
    const buttons = Array.from(container.querySelectorAll('button'))
    const refresh = buttons.find((b) => b.getAttribute('aria-label') === 'Refresh')!
    act(() => refresh.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(refreshed).toBe(1)
    expect(buttons.map((b) => b.textContent)).toContain('Sync all')
  })
})
