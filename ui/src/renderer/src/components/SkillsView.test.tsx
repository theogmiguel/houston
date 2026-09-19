// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Skill } from '../env'
import type { SkillPushRecord } from '../houston/generated/SkillPushRecord'
import type { SkillToolState } from '../houston/generated/SkillToolState'
import { SkillsView } from './SkillsView'

const listSkills = vi.fn()
const writeSkill = vi.fn()
const deleteSkill = vi.fn()
const readFile = vi.fn()

vi.mock('../houston/bridge', () => ({
  listSkills: (...args: unknown[]) => listSkills(...args),
  writeSkill: (...args: unknown[]) => writeSkill(...args),
  deleteSkill: (...args: unknown[]) => deleteSkill(...args),
  readFile: (...args: unknown[]) => readFile(...args),
  addAllowedRoot: () => Promise.resolve()
}))

const previewSkillUrl = vi.fn()
const installSkillFromUrl = vi.fn()

vi.mock('../houston/skillInstall', () => ({
  previewSkillUrl: (...args: unknown[]) => previewSkillUrl(...args),
  installSkillFromUrl: (...args: unknown[]) => installSkillFromUrl(...args)
}))

const SKILLS: Skill[] = [
  {
    agent: 'claude',
    source: 'project',
    name: 'deploy',
    path: '/p/.claude/skills/deploy/SKILL.md',
    invoke: '/deploy',
    description: 'Ships the current branch to staging'
  },
  {
    agent: 'codex',
    source: 'user',
    name: 'triage',
    path: '/home/.codex/prompts/triage.md',
    invoke: '/triage',
    description: 'Sorts incoming bug reports'
  }
]

describe('SkillsView — the redesigned library', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    listSkills.mockReset().mockResolvedValue(SKILLS)
    writeSkill.mockReset()
    deleteSkill.mockReset()
    readFile.mockReset().mockResolvedValue('')
    previewSkillUrl.mockReset()
    installSkillFromUrl.mockReset()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function flush(times = 5): Promise<void> {
    for (let i = 0; i < times; i++) {
      await act(async () => {
        await Promise.resolve()
      })
    }
  }

  function render(props: Partial<React.ComponentProps<typeof SkillsView>> = {}): void {
    act(() => {
      root.render(<SkillsView dir={null} {...props} />)
    })
  }

  function byLabel(label: string): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === label
    )
  }

  function typeInto(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('filters the list by search text across name and description', async () => {
    render()
    await flush()
    expect(byLabel('View deploy')).toBeDefined()
    expect(byLabel('View triage')).toBeDefined()

    const search = container.querySelector<HTMLInputElement>('[role="searchbox"]')!
    typeInto(search, 'staging')
    await flush()
    expect(byLabel('View deploy')).toBeDefined()
    expect(byLabel('View triage')).toBeUndefined()
  })

  it('shows an actionable no-matches state with a way to clear the search', async () => {
    render()
    await flush()
    const search = container.querySelector<HTMLInputElement>('[role="searchbox"]')!
    typeInto(search, 'nothing matches this')
    await flush()
    expect(container.querySelector('[data-testid="skills-no-matches"]')).not.toBeNull()
    const clear = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Clear search'
    )!
    act(() => clear.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
    expect(byLabel('View deploy')).toBeDefined()
    expect(byLabel('View triage')).toBeDefined()
  })

  it('shows an actionable empty state (New skill / Install from link) with zero skills', async () => {
    listSkills.mockResolvedValue([])
    render()
    await flush()
    expect(container.querySelector('[data-testid="skills-empty"]')).not.toBeNull()
    expect(container.textContent).toContain('New skill')
    expect(container.textContent).toContain('Install from link')
  })

  it('opens a skill\'s detail view with its real description, origin and scope', async () => {
    render({ dir: '/p' })
    await flush()
    act(() => byLabel('View deploy')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
    expect(container.textContent).toContain('Ships the current branch to staging')
    expect(container.textContent).toContain('/p/.claude/skills/deploy/SKILL.md')
    expect(container.textContent).toContain('Project scope')
  })

  it('detail view exposes Copy invocation and, only when onRun exists, Use in selected terminal', async () => {
    render()
    await flush()
    act(() => byLabel('View deploy')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
    expect(container.textContent).toContain('Copy invocation')
    expect(byLabel('Use deploy in the selected terminal')).toBeUndefined()
  })

  it('"Use in selected terminal" calls onRun with the invocation string', async () => {
    const onRun = vi.fn()
    render({ onRun })
    await flush()
    act(() => byLabel('View deploy')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
    const useButton = byLabel('Use deploy in the selected terminal')!
    act(() => useButton.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onRun).toHaveBeenCalledWith('/deploy')
  })

  it('detail view\'s Edit control opens the edit form for that skill', async () => {
    readFile.mockResolvedValue('# Deploy\nbody')
    render()
    await flush()
    act(() => byLabel('View deploy')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
    act(() => byLabel('Edit deploy')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
    expect(container.textContent).toContain('Edit Skill')
  })

  describe('Install from link', () => {
    function openDialog(): void {
      const install = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent?.includes('Install from link')
      )!
      act(() => install.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    }

    it('shows a failed library scan and retries without claiming the library is empty', async () => {
      listSkills.mockRejectedValueOnce('Cannot read skills directory')
      render()
      await flush()
      expect(container.textContent).toContain('Cannot read skills directory')
      expect(container.querySelector('[data-testid="skills-load-error"]')).not.toBeNull()
      const retry = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Try again')!
      act(() => retry.click())
      await flush()
      expect(container.querySelector('[data-testid="skills-load-error"]')).toBeNull()
      expect(container.textContent).toContain('deploy')
    })

    it('keeps keyboard focus inside the install dialog and closes on Escape', async () => {
      render()
      await flush()
      openDialog()
      await flush()
      const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
      expect(dialog.getAttribute('aria-modal')).toBe('true')
      const buttons = dialog.querySelectorAll<HTMLButtonElement>('button:not([disabled])')
      const last = buttons[buttons.length - 1]
      last.focus()
      act(() => last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })))
      expect(document.activeElement).toBe(buttons[0])
      act(() => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
      expect(container.querySelector('[role="dialog"]')).toBeNull()
    })

    it('previews a URL, then installs it and refreshes the library', async () => {
      previewSkillUrl.mockResolvedValue({
        name: 'audit',
        description: 'Runs a security audit',
        content: '# Audit',
        sizeBytes: 8
      })
      installSkillFromUrl.mockResolvedValue({ ok: true, error: null, conflict: null })
      render()
      await flush()
      openDialog()
      await flush()

      const url = container.querySelector<HTMLInputElement>('#skill-install-url')!
      typeInto(url, 'https://example.com/skills/audit/SKILL.md')
      const preview = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === 'Preview'
      )!
      act(() => preview.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      await flush()

      expect(previewSkillUrl).toHaveBeenCalledWith('https://example.com/skills/audit/SKILL.md')
      expect(container.textContent).toContain('Runs a security audit')

      listSkills.mockClear()
      const doInstall = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === 'Install'
      )!
      act(() => doInstall.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      await flush()

      expect(installSkillFromUrl).toHaveBeenCalledWith('audit', '# Audit', null, false)
      expect(listSkills).toHaveBeenCalled()
      expect(container.querySelector('#skill-install-url')).toBeNull()
    })

    it('shows the existing vs incoming content on a conflict, and never overwrites silently', async () => {
      previewSkillUrl.mockResolvedValue({
        name: 'deploy',
        description: '',
        content: '# Deploy v2',
        sizeBytes: 11
      })
      installSkillFromUrl.mockResolvedValueOnce({
        ok: false,
        error: 'a skill named "deploy" already exists and differs',
        conflict: { existingContent: '# Deploy v1', path: '/p/.claude/skills/deploy/SKILL.md' }
      })
      render()
      await flush()
      openDialog()
      await flush()

      const url = container.querySelector<HTMLInputElement>('#skill-install-url')!
      typeInto(url, 'https://example.com/skills/deploy/SKILL.md')
      act(() =>
        Array.from(container.querySelectorAll('button'))
          .find((b) => b.textContent === 'Preview')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      )
      await flush()
      act(() =>
        Array.from(container.querySelectorAll('button'))
          .find((b) => b.textContent === 'Install')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      )
      await flush()

      expect(installSkillFromUrl).toHaveBeenCalledTimes(1)
      expect(container.textContent).toContain('# Deploy v1')
      expect(container.textContent).toContain('# Deploy v2')

      installSkillFromUrl.mockResolvedValueOnce({ ok: true, error: null, conflict: null })
      const replace = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === 'Replace existing'
      )!
      act(() => replace.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      await flush()
      expect(installSkillFromUrl).toHaveBeenLastCalledWith('deploy', '# Deploy v2', null, true)
    })

    it('shows a fetch/validation error inline and lets the user retry', async () => {
      previewSkillUrl.mockRejectedValueOnce('only https:// links are supported')
      render()
      await flush()
      openDialog()
      await flush()
      const url = container.querySelector<HTMLInputElement>('#skill-install-url')!
      typeInto(url, 'http://example.com/SKILL.md')
      act(() =>
        Array.from(container.querySelectorAll('button'))
          .find((b) => b.textContent === 'Preview')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      )
      await flush()
      expect(container.textContent).toContain('only https:// links are supported')
      expect(container.querySelector('#skill-install-url')).not.toBeNull()
    })
  })

  describe('embedded (rail door): the list + detail shell', () => {
    function toolState(tool: SkillToolState['tool'], entries: Array<[string, string]>): SkillToolState {
      return {
        tool,
        path: `/home/dev/.${tool}/skills`,
        detected: true,
        inherits_claude: false,
        skills: entries.map(([name, digest]) => ({ name, path: `/skills/${name}`, digest })),
        error: null
      }
    }

    function renderEmbedded(props: Partial<React.ComponentProps<typeof SkillsView>> = {}): void {
      act(() => {
        root.render(<SkillsView dir={null} embedded {...props} />)
      })
    }

    function listItem(name: string): HTMLButtonElement {
      return Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="list-detail-item"]')).find(
        (b) => b.textContent?.includes(name)
      )!
    }

    it('renders one SectionHead and a flat list, name over invocation · scope, no header/count bar', async () => {
      renderEmbedded()
      await flush()
      expect(container.querySelectorAll('[data-testid="settings-section-title"]')).toHaveLength(1)
      const row = listItem('deploy')
      expect(row.textContent).toContain('/deploy')
      expect(row.textContent).toContain('project')
    })

    it('shows a StatusIcon only on a drifted skill\'s row, never on one that is in sync', async () => {
      renderEmbedded({
        tools: [
          toolState('claude', [['deploy', 'A']]),
          toolState('codex', [['deploy', 'B']])
        ]
      })
      await flush()
      const row = listItem('deploy').closest('[data-testid="list-detail-row"]')!
      expect(row.querySelector('[data-testid="status-icon"]')).not.toBeNull()
      expect(row.querySelector('[data-testid="status-icon"]')?.getAttribute('data-state')).toBe('differs')

      renderEmbedded({
        tools: [toolState('claude', [['deploy', 'A']]), toolState('codex', [['deploy', 'A']])]
      })
      await flush()
      expect(listItem('deploy').querySelector('[data-testid="status-icon"]')).toBeNull()
    })

    it('opens a skill in the detail pane, showing its Copies group states as StatusIcons', async () => {
      const pushes: SkillPushRecord[] = [
        { tool: 'codex', skill: 'deploy', path: '/x', pushed_at: Math.floor(Date.now() / 1000), had_existing: false }
      ]
      renderEmbedded({
        tools: [toolState('claude', [['deploy', 'A']]), toolState('codex', [['deploy', 'B']])],
        pushes
      })
      await flush()
      act(() => listItem('deploy').dispatchEvent(new MouseEvent('click', { bubbles: true })))
      await flush()
      expect(container.textContent).toContain('Ships the current branch to staging')
      const codexRow = Array.from(container.querySelectorAll('[data-testid="settings-row"]')).find((r) =>
        r.textContent?.includes('Codex')
      )!
      const icon = codexRow.querySelector('[data-testid="status-icon"]')!
      expect(icon.getAttribute('data-state')).toBe('differs')
      expect(codexRow.textContent).toContain('Push again')
      expect(codexRow.querySelector('[aria-label^="Undo pushing"]')).not.toBeNull()
    })

    it('New skill opens the create form in the detail pane without leaving the list', async () => {
      renderEmbedded()
      await flush()
      const newSkill = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent?.includes('New skill')
      )!
      act(() => newSkill.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      await flush()
      expect(container.textContent).toContain('New skill')
      expect(container.querySelector('[data-testid="list-detail-list"]')).not.toBeNull()
      expect(listItem('deploy')).toBeDefined()
    })

    it("Edit swaps a selected skill's detail for the editor in place", async () => {
      readFile.mockResolvedValue('# Deploy\nbody')
      renderEmbedded()
      await flush()
      act(() => listItem('deploy').dispatchEvent(new MouseEvent('click', { bubbles: true })))
      await flush()
      const edit = Array.from(container.querySelectorAll('button')).find(
        (b) => b.getAttribute('aria-label') === 'Edit deploy'
      )!
      act(() => edit.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      await flush()
      expect(container.textContent).toContain('Edit deploy')
      expect(container.querySelector('textarea')).not.toBeNull()
    })
  })
})
