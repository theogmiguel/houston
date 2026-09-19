// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillToolState } from '../../houston/generated/SkillToolState'
import { SkillsSurface } from './SkillsSurface'

vi.mock('../../houston/bridge', () => ({
  listSkills: vi.fn(() =>
    Promise.resolve([
      {
        agent: 'claude',
        source: 'project',
        name: 'deploy',
        path: '/p/deploy.md',
        invoke: '/deploy',
        description: ''
      }
    ])
  ),
  writeSkill: vi.fn(),
  deleteSkill: vi.fn(),
  readFile: vi.fn()
}))

function noop(): void {}

function toolState(tool: SkillToolState['tool'], skills: string[]): SkillToolState {
  return {
    tool,
    path: `/home/dev/.${tool}/skills`,
    detected: true,
    inherits_claude: false,
    skills: skills.map((name) => ({ name, path: `/skills/${name}`, digest: 'd' })),
    error: null
  }
}

describe('SkillsSurface — the librarian, no Run', () => {
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

  async function settleLibrary(): Promise<void> {
    for (let i = 0; i < 60; i++) {
      if (container.querySelector('[data-testid="skills-library"]')) return
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5))
      })
    }
    throw new Error('SkillsView never left its Suspense fallback: no [data-testid="skills-library"]')
  }

  function render(props: Partial<React.ComponentProps<typeof SkillsSurface>> = {}): void {
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
          {...props}
        />
      )
    })
  }

  it('renders something real with zero agents / nothing loaded', async () => {
    render()
    await settleLibrary()
    expect(container.textContent).toContain('Reusable instructions your agents can use')
    expect(container.textContent).toContain('Open a skill to read its instructions')
  })

  it('renders no Run / paste control anywhere on the surface', async () => {
    render({ tools: [toolState('claude', ['deploy'])] })
    await settleLibrary()
    const pasteButtons = Array.from(container.querySelectorAll('button')).filter((b) => {
      const l = b.getAttribute('aria-label') ?? ''
      return l.startsWith('paste "') || l.startsWith('Paste ')
    })
    expect(pasteButtons).toHaveLength(0)
  })

  it('the auto-push switch sits in a labelled Distribution group, with Rescan on its row', async () => {
    render({ tools: [toolState('claude', ['deploy'])] })
    await settleLibrary()
    const heading = Array.from(container.querySelectorAll('[data-testid="settings-subhead"]')).find(
      (h) => h.textContent === 'Distribution'
    )
    expect(heading).toBeDefined()
    const list = heading!.parentElement!.querySelector('[data-testid="settings-list"]')!
    const row = list.querySelector('[data-testid="settings-row"]')!
    expect(row.getAttribute('data-settings-row-name')).toBe('Auto-push drift')
    expect(row.querySelector('[data-testid="skills-auto-push"]')).not.toBeNull()
    expect(row.querySelector('button[aria-label="Refresh distribution"]')).not.toBeNull()
  })

  it('renders exactly one header — the Settings-grammar SectionHead', async () => {
    render({ tools: [toolState('claude', ['deploy'])] })
    await settleLibrary()
    for (let i = 0; i < 60 && container.querySelectorAll('[data-testid="list-detail-item"]').length === 0; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5))
      })
    }
    const heads = container.querySelectorAll('[data-testid="settings-section-title"]')
    expect(heads).toHaveLength(1)
    expect(heads[0].textContent).toBe('Skills')
    expect(container.querySelector('[data-testid="skills-library"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-testid="list-detail-item"]').length).toBeGreaterThan(0)
  })
})
