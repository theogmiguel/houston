// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillToolState } from '../../houston/generated/SkillToolState'
import { SkillsSurface } from './SkillsSurface'

vi.mock('../../houston/bridge', () => ({
  listSkills: vi.fn((dir: string | null) => Promise.resolve([
    {
      agent: 'claude',
      source: dir ? 'project' : 'user',
      name: 'deploy',
      path: dir ? `${dir}/.claude/skills/deploy/SKILL.md` : '/home/dev/.claude/skills/deploy/SKILL.md',
      invoke: '/deploy',
      description: ''
    }
  ])),
  addAllowedRoot: vi.fn(() => Promise.resolve()),
  writeSkill: vi.fn(),
  deleteSkill: vi.fn(),
  readFile: vi.fn(() => Promise.resolve(''))
}))

vi.mock('../../houston/useHarness', () => ({
  useHarness: vi.fn(() => ({ state: null, report: null, reportError: null, loadReport: noop }))
}))

import { readFile } from '../../houston/bridge'
import { useHarness } from '../../houston/useHarness'

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
    vi.mocked(useHarness).mockReset().mockReturnValue({
      state: null,
      report: null,
      reportError: null,
      loadReport: noop
    })
    vi.mocked(readFile).mockReset().mockResolvedValue('')
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function settleLibrary(): Promise<void> {
    for (let i = 0; i < 200; i++) {
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
          client={null}
          workspace={null}
          focusedPaneName={null}
          canRunSkillInFocusedPane={false}
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

  it('renders exactly one header — the shared page header', async () => {
    render({ tools: [toolState('claude', ['deploy'])] })
    await settleLibrary()
    for (let i = 0; i < 60 && container.querySelectorAll('[data-testid="list-detail-item"]').length === 0; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5))
      })
    }
    const heads = container.querySelectorAll('h1')
    expect(heads).toHaveLength(1)
    expect(heads[0].textContent).toBe('Skills')
    expect(container.querySelector('[data-testid="skills-library"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-testid="list-detail-item"]').length).toBeGreaterThan(0)
  })

  async function openDeploy(): Promise<void> {
    await settleLibrary()
    const findDeploy = (): HTMLButtonElement | null =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="list-detail-item"]'))
        .find((button) => button.textContent?.includes('deploy')) ?? null
    let open = findDeploy()
    for (let i = 0; i < 100 && !open; i++) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
      open = findDeploy()
    }
    if (!open) throw new Error('deploy skill was not listed')
    act(() => open.click())
  }

  it('runs a selected skill in the focused pane through onRun', async () => {
    const onRun = vi.fn()
    render({
      workspace: '/p',
      focusedPaneName: 'auth-refactor',
      canRunSkillInFocusedPane: true,
      onRunSkill: onRun
    })
    await openDeploy()
    const use = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Use in auth-refactor')
    )
    expect(use).toBeDefined()
    act(() => use!.click())
    expect(onRun).toHaveBeenCalledWith('/deploy')
    expect(container.textContent).toContain('User · This workspace')
  })

  it('lists only user skills and names that scope without a selected workspace', async () => {
    render()
    await openDeploy()
    expect(container.textContent).toContain('User skills only')
    expect(container.textContent).toContain('user')
    expect(container.textContent).not.toContain('project')
  })

  it('disables Use with its reason when no agent pane is focused', async () => {
    render({ workspace: '/p' })
    await openDeploy()
    const use = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Focus a live agent pane to use this skill"]'
    )
    expect(use?.disabled).toBe(true)
    expect(use?.textContent).toContain('Focus an agent pane')
  })

  it('loads workspace skills and shows the no-review usage line', async () => {
    vi.mocked(useHarness).mockReturnValue({
      state: null,
      report: null,
      reportError: null,
      loadReport: noop
    })
    render({ workspace: '/p' })
    await openDeploy()
    expect(container.textContent).toContain('project')
    expect(container.querySelector('[data-testid="skill-agent-relations"]')).not.toBeNull()
    expect(container.textContent).toContain('Usage appears after the first Harness review.')
    expect(vi.mocked(readFile)).not.toHaveBeenCalled()
  })

  it('shows usage from the latest published Harness digest', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(
      `${JSON.stringify({ skills: { deploy: 1 } })}\n${JSON.stringify({ skills: {} })}`
    )
    vi.mocked(useHarness).mockReturnValue({
      state: {
        workspace: '/p',
        routine: null,
        reviews: [{ id: 1, status: 'published', run_dir: '/p/.houston/harness/r1' } as never],
        findings: [],
        models: [],
        providerCoverage: []
      },
      report: null,
      reportError: null,
      loadReport: noop
    })
    render({ workspace: '/p' })
    await openDeploy()
    for (let i = 0; i < 60 && !container.textContent?.includes('Used in 1 of 2 sessions'); i++) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
    }
    expect(container.textContent).toContain('Used in 1 of 2 sessions · from the last Harness review')
    expect(vi.mocked(readFile)).toHaveBeenCalledWith('/p/.houston/harness/r1/digest.jsonl')
  })
})
