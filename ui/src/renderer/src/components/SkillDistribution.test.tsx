// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillToolState } from '../houston/generated/SkillToolState'
import type { SkillPushRecord } from '../houston/generated/SkillPushRecord'
import { SkillItemDistribution } from './SkillDistribution'

const readFile = vi.fn()
vi.mock('../houston/bridge', () => ({
  readFile: (...args: unknown[]) => readFile(...args)
}))

function toolState(
  tool: SkillToolState['tool'],
  skills: Array<{ name: string; digest: string; path?: string }>
): SkillToolState {
  return {
    tool,
    path: `/home/dev/.${tool}/skills`,
    detected: true,
    inherits_claude: false,
    skills: skills.map((s) => ({ name: s.name, path: s.path ?? `/skills/${tool}/${s.name}`, digest: s.digest })),
    error: null
  }
}

describe('SkillItemDistribution — a skill\'s own per-tool availability', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    readFile.mockReset()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render(props: Partial<React.ComponentProps<typeof SkillItemDistribution>> = {}): void {
    act(() => {
      root.render(
        <SkillItemDistribution
          skillName="deploy"
          tools={[toolState('claude', [{ name: 'deploy', digest: 'a' }])]}
          pushes={[]}
          onPush={vi.fn()}
          onPushUndo={vi.fn()}
          {...props}
        />
      )
    })
  }

  it('renders nothing when the skill has no Claude Code copy to distribute from', () => {
    render({
      tools: [toolState('claude', []), toolState('codex', [{ name: 'deploy', digest: 'a' }])]
    })
    expect(container.querySelector('[data-testid="skill-item-distribution"]')).toBeNull()
  })

  it('renders nothing when Claude is the only known tool', () => {
    render({ tools: [toolState('claude', [{ name: 'deploy', digest: 'a' }])] })
    expect(container.querySelector('[data-testid="skill-item-distribution"]')).toBeNull()
  })

  it('shows an explicit "Copy Claude\'s version" action for a missing/drifted copy, and none for an identical one', () => {
    render({
      tools: [
        toolState('claude', [{ name: 'deploy', digest: 'a' }]),
        toolState('codex', [{ name: 'deploy', digest: 'b' }]),
        toolState('opencode', [])
      ]
    })
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent)
    expect(buttons.some((t) => t?.includes("Copy Claude's version to Codex"))).toBe(true)
    expect(buttons.some((t) => t?.includes("Copy Claude's version to OpenCode"))).toBe(true)
  })

  it('calls onPush with the tool and skill name', () => {
    const onPush = vi.fn()
    render({
      tools: [
        toolState('claude', [{ name: 'deploy', digest: 'a' }]),
        toolState('codex', [])
      ],
      onPush
    })
    const push = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes("Copy Claude's version to Codex")
    )!
    act(() => push.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onPush).toHaveBeenCalledWith('codex', 'deploy')
  })

  it('shows Undo for a tool Houston has already pushed to, and calls onPushUndo', () => {
    const onPushUndo = vi.fn()
    const pushes: SkillPushRecord[] = [
      { tool: 'codex', skill: 'deploy', path: '/skills/codex/deploy', pushed_at: 0, had_existing: false }
    ]
    render({
      tools: [toolState('claude', [{ name: 'deploy', digest: 'a' }]), toolState('codex', [{ name: 'deploy', digest: 'a' }])],
      pushes,
      onPushUndo
    })
    const undo = container.querySelector<HTMLButtonElement>(
      '[aria-label="Undo pushing deploy into Codex"]'
    )!
    expect(undo).not.toBeNull()
    act(() => undo.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onPushUndo).toHaveBeenCalledWith('codex', 'deploy')
  })

  it('shows a "View difference" action for a drifted copy that reads both files before replacing', async () => {
    readFile.mockImplementation((path: string) =>
      Promise.resolve(path.includes('claude') ? '# Claude version' : '# Codex version')
    )
    render({
      tools: [
        toolState('claude', [{ name: 'deploy', digest: 'a', path: '/skills/claude/deploy' }]),
        toolState('codex', [{ name: 'deploy', digest: 'b', path: '/skills/codex/deploy' }])
      ]
    })
    const view = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'View difference'
    )!
    act(() => view.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(readFile).toHaveBeenCalledWith('/skills/claude/deploy')
    expect(readFile).toHaveBeenCalledWith('/skills/codex/deploy')
    expect(container.textContent).toContain('# Claude version')
    expect(container.textContent).toContain('# Codex version')
  })
})
