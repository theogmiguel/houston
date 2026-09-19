// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
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

describe('the ListDetail surfaces sit in a column wide enough to be two columns', () => {
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

  async function settleCard(): Promise<void> {
    for (let i = 0; i < 80; i++) {
      if (container.querySelector('[data-testid="list-detail"]')) return
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5))
      })
    }
    throw new Error('no [data-testid="list-detail"] rendered')
  }

  function expectBothColumnsAtTheWideRung(): void {
    const column = container.querySelector('[data-testid="nav-column"]')!
    const shell = container.querySelector('[data-testid="list-detail"]')!
    const list = container.querySelector('[data-testid="list-detail-list"]')!
    const detail = container.querySelector('[data-testid="list-detail-detail"]')!

    const maxWidth = Number(/max-w-\[(\d+)px\]/.exec(column.className)![1])
    const padding = 2 * Number(/px-\[(\d+)px\]/.exec(column.className)![1])
    const rung = Number(
      /\[@container_\(min-width:(\d+)px\)\]:grid-cols-\[280px/.exec(shell.className)![1]
    )
    expect(maxWidth - padding).toBeGreaterThanOrEqual(rung)
    expect(list.className).not.toContain('hidden')
    expect(detail.className).toContain(`[@container_(min-width:${rung}px)]:flex`)
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
    await settleCard()
    expectBothColumnsAtTheWideRung()
  })
})
