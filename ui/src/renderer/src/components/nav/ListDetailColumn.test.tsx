// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServer } from '../../houston/generated/McpServer'
import { McpSurface } from './McpSurface'
import { SkillsSurface } from './SkillsSurface'

vi.mock('../../houston/bridge', () => ({
  listSkills: vi.fn(() =>
    Promise.resolve([
      {
        agent: 'claude',
        source: 'user',
        name: 'deploy',
        path: '/home/t/.claude/skills/deploy/SKILL.md',
        invoke: '/deploy',
        description: ''
      }
    ])
  ),
  writeSkill: vi.fn(),
  deleteSkill: vi.fn(),
  readFile: vi.fn(() => Promise.resolve('# deploy')),
  addAllowedRoot: vi.fn(() => Promise.resolve())
}))

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

describe('wide surfaces have room for their main content', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    document.documentElement.style.setProperty('--w-list-detail-breakpoint', '720px')
    document.documentElement.style.setProperty('--w-list-detail-column', '280px')
    vi.stubGlobal('ResizeObserver', class {
      private readonly callback: ResizeObserverCallback

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
      }

      observe(target: Element): void {
        Object.defineProperty(target, 'clientWidth', { configurable: true, value: 1280 })
        this.callback([], this)
      }

      unobserve(): void {}
      disconnect(): void {}
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    document.documentElement.style.removeProperty('--w-list-detail-breakpoint')
    document.documentElement.style.removeProperty('--w-list-detail-column')
  })

  async function settleCard(): Promise<void> {
    await act(async () => { await import('../SkillsView') })
    for (let i = 0; i < 80; i++) {
      if (container.querySelector('[data-testid="list-detail"]')) return
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5))
      })
    }
    throw new Error('no [data-testid="list-detail"] rendered')
  }

  function expectBothColumnsAtTheWideRung(): void {
    const shell = container.querySelector('[data-testid="list-detail"]')!
    const column = shell.closest('main')!
    const list = container.querySelector('[data-testid="list-detail-list"]')!
    const detail = container.querySelector('[data-testid="list-detail-detail"]')!

    const maxWidth = Number(/max-w-\[(\d+)px\]/.exec(column.className)![1])
    // PageFrame pads with a spacing token; theme.css defines --space-4-5 as 20px.
    expect(column.className).toContain('px-[var(--space-4-5)]')
    const padding = 2 * 20
    expect(shell.className).toContain('grid-cols-[var(--w-list-detail-column)_minmax(0,1fr)]')
    const theme = readFileSync(resolve(process.cwd(), 'src/renderer/src/theme.css'), 'utf8')
    const rung = Number(/--w-list-detail-breakpoint:\s*(\d+)px/.exec(theme)![1])
    expect(Number(/--w-list-detail-column:\s*(\d+)px/.exec(theme)![1])).toBe(280)
    expect(maxWidth - padding).toBeGreaterThanOrEqual(rung)
    expect(list.className).not.toContain('hidden')
    expect(detail.className).not.toContain('hidden')
  }

  it('Skills', async () => {
    act(() => {
      root.render(
        <SkillsSurface
          tools={null}
          pushes={[]}
          autoPushEnabled={false}
          onRefresh={noop}
          onPush={noop}
          onPushUndo={noop}
          onAutoPushSet={noop}
        />
      )
    })
    await settleCard()
    expectBothColumnsAtTheWideRung()
  })

  it('Connections', async () => {
    act(() => {
      root.render(
        <McpSurface
          source={[server('context7')]}
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
        />
      )
    })
    await act(async () => { await import('../McpManager') })
    for (let i = 0; i < 100 && !container.querySelector('[data-testid="table-frame"]'); i++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    }
    const table = container.querySelector('[data-testid="table-frame"]')
    expect(table).not.toBeNull()
    expect(table!.className).toContain('overflow-x-auto')
    expect(container.textContent).toContain('Claude Code')
    expect(container.textContent).toContain('Cursor')
  })
})
