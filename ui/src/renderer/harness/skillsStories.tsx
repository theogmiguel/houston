import React from 'react'
import { SkillsLeaf } from '../src/components/SkillsLeaf'
import { SkillsView } from '../src/components/SkillsView'
import { SkillInstallDialog } from '../src/components/SkillInstallDialog'
import type { Skill } from '../src/env'
import type { SkillPushRecord } from '../src/houston/generated/SkillPushRecord'
import type { SkillToolState } from '../src/houston/generated/SkillToolState'

const noop = (): void => {}

const SKILLS: Skill[] = [
  {
    agent: 'claude',
    source: 'user',
    name: 'tdd',
    path: '/home/dev/.claude/skills/tdd/SKILL.md',
    invoke: '/tdd',
    description: 'Red-green-refactor loop with an integration test first.'
  },
  {
    agent: 'claude',
    source: 'project',
    name: 'ui-tokens',
    path: '/home/dev/code/auth-refactor/.claude/skills/ui-tokens/SKILL.md',
    invoke: '/ui-tokens',
    description: 'Use theme tokens and shared chrome constants in the renderer.'
  },
  {
    agent: 'codex',
    source: 'user',
    name: 'lint-sweep',
    path: '/home/dev/.codex/skills/lint-sweep/SKILL.md',
    invoke: '/lint-sweep',
    description: ''
  }
]

type HoustonStub = Record<string, unknown>

function installStubs(): void {
  const w = window as unknown as { houston?: HoustonStub }
  w.houston = {
    ...(w.houston ?? {}),
    listSkills: async (dir: string | null) => {
      if (dir === 'loading') return new Promise<Skill[]>(() => {})
      if (dir === 'error') throw new Error('permission denied: /home/dev/.claude/skills')
      if (dir === 'empty') return []
      return SKILLS
    },
    readFile: async (path: string) => {
      if (path.includes('/.codex/')) throw new Error('permission denied')
      if (path.endsWith('digest.jsonl')) return ''
      if (path.includes('/other/')) return '# tdd\n\nA different procedure body.\n\n- one\n- two'
      return '# TDD\n\nRed, green, refactor.\n\n- Write the failing test\n- Make it pass\n- Clean up'
    },
    writeSkill: async () => ({ ok: true }),
    deleteSkill: async (path: string) => ({ ok: false, error: `permission denied: ${path}` })
  }
}

function skillTool(
  tool: SkillToolState['tool'],
  skills: Array<{ name: string; digest: string }>,
  inherits = false
): SkillToolState {
  return {
    tool,
    path: `/home/dev/.${tool}/skills`,
    detected: true,
    inherits_claude: inherits,
    skills: skills.map((s) => ({ name: s.name, digest: s.digest, path: `/skills/${tool === 'claude' ? 'claude' : 'other'}/${s.name}` })),
    error: null
  }
}

const TOOLS: SkillToolState[] = [
  skillTool('claude', [{ name: 'tdd', digest: 'A' }, { name: 'ui-tokens', digest: 'B' }]),
  skillTool('codex', [{ name: 'tdd', digest: 'X' }, { name: 'ui-tokens', digest: 'B' }]),
  skillTool('opencode', [], true),
  skillTool('cursor', [])
]

const PUSHES: SkillPushRecord[] = [
  { tool: 'codex', skill: 'tdd', path: '/home/dev/.codex/skills/tdd', pushed_at: Math.floor(new Date(2026, 9, 3).getTime() / 1000), had_existing: true }
]

type Step =
  | { click: string; text?: string }
  | { type: string; value: string }
  | { focus: string }

function useDrive(steps: Step[]): React.RefObject<HTMLDivElement | null> {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    let index = 0
    const timer = window.setInterval(() => {
      const root = ref.current
      if (!root) return
      const step = steps[index]
      if (!step) {
        window.clearInterval(timer)
        return
      }
      if ('focus' in step) {
        const target = root.querySelector<HTMLElement>(step.focus)
        if (!target) return
        target.focus()
        index += 1
        return
      }
      if ('type' in step) {
        const input = root.querySelector<HTMLInputElement>(step.type)
        if (!input) return
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(input, step.value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        index += 1
        return
      }
      const candidates = [...root.querySelectorAll<HTMLElement>(step.click)]
      const target = step.text
        ? (candidates.find((c) => c.textContent?.trim() === step.text) ?? candidates.find((c) => c.textContent?.includes(step.text!)))
        : candidates[0]
      if (!target) return
      target.click()
      index += 1
    }, 60)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the script is fixed per story
  }, [])
  return ref
}

function Panel({ width, steps, children }: { width: number; steps: Step[]; children: React.ReactNode }): React.JSX.Element {
  const ref = useDrive(steps)
  return (
    <div
      ref={ref}
      style={{ width, height: 740, flex: 'none', display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden', outline: '1px solid var(--border)' }}
    >
      {children}
    </div>
  )
}

function Gallery({ children }: { children: React.ReactNode }): React.JSX.Element {
  installStubs()
  return <div style={{ display: 'flex', gap: 10, padding: 10, alignItems: 'flex-start', background: 'var(--content-bg)', minHeight: '100%' }}>{children}</div>
}

function StandalonePanel({ dir, steps = [], tools = true }: { dir: string; steps?: Step[]; tools?: boolean }): React.JSX.Element {
  return (
    <Panel width={410} steps={steps}>
      <SkillsLeaf
        node={{ id: 1, kind: 'skills' } as never}
        dir={dir}
        onRun={noop}
        onClose={noop}
        onHeaderPointerDown={noop}
        expanded={false}
        onExpand={noop}
        tools={tools ? TOOLS : undefined}
        pushes={tools ? PUSHES : undefined}
        onPush={noop}
        onPushUndo={noop}
      />
    </Panel>
  )
}

export function SkillsStandaloneA(): React.JSX.Element {
  return (
    <Gallery>
      <StandalonePanel dir="list" tools={false} />
      <StandalonePanel dir="loading" tools={false} />
      <StandalonePanel dir="empty" tools={false} />
      <StandalonePanel dir="error" tools={false} />
    </Gallery>
  )
}

export function SkillsStandaloneB(): React.JSX.Element {
  return (
    <Gallery>
      <StandalonePanel dir="no-match" tools={false} steps={[{ type: 'input[role=searchbox]', value: 'zzz' }]} />
      <StandalonePanel
        dir="detail"
        steps={[{ click: 'button[aria-label="View tdd"]' }, { click: 'button', text: 'View difference' }]}
      />
      <StandalonePanel dir="edit" tools={false} steps={[{ click: 'button[aria-label="Edit tdd"]' }]} />
      <StandalonePanel dir="new" tools={false} steps={[{ click: 'button', text: 'New skill' }]} />
    </Gallery>
  )
}

export function SkillsStandaloneC(): React.JSX.Element {
  return (
    <Gallery>
      <StandalonePanel dir="edit-error" tools={false} steps={[{ click: 'button[aria-label="Edit lint-sweep"]' }]} />
      <StandalonePanel
        dir="action-error"
        tools={false}
        steps={[{ click: 'button[aria-label="Delete tdd"]' }, { click: 'button', text: 'Delete' }]}
      />
      <StandalonePanel
        dir="collapsed"
        tools={false}
        steps={[{ click: 'button[aria-expanded]', text: 'Codex' }]}
      />
    </Gallery>
  )
}

export function SkillsRowActions(): React.JSX.Element {
  return (
    <Gallery>
      <StandalonePanel dir="list" tools={false} steps={[{ focus: 'button[aria-label="View tdd"]' }]} />
    </Gallery>
  )
}

function EmbeddedPanel({ dir, steps = [], tools = true, relations = false }: { dir: string; steps?: Step[]; tools?: boolean; relations?: boolean }): React.JSX.Element {
  return (
    <Panel width={630} steps={steps}>
      <div style={{ padding: 16, overflow: 'auto' }}>
        <SkillsView
          dir={dir}
          embedded
          onRun={noop}
          runLabel="auth-refactor"
          scopeLabel="Project scope"
          showAgentRelations={relations}
          tools={tools ? TOOLS : undefined}
          pushes={tools ? PUSHES : undefined}
          onPush={noop}
          onPushUndo={noop}
        />
      </div>
    </Panel>
  )
}

export function SkillsEmbeddedA(): React.JSX.Element {
  return (
    <Gallery>
      <EmbeddedPanel dir="plain" steps={[{ click: 'button', text: 'tdd/tdd' }]} />
      <EmbeddedPanel dir="edit" tools={false} steps={[{ click: 'button', text: 'tdd/tdd' }, { click: 'button[aria-label="Edit tdd"]' }]} />
    </Gallery>
  )
}

export function SkillsEmbeddedB(): React.JSX.Element {
  return (
    <Gallery>
      <EmbeddedPanel dir="empty" tools={false} steps={[{ click: 'button', text: 'New skill' }]} />
      <EmbeddedPanel dir="error" tools={false} />
    </Gallery>
  )
}

export function SkillsEmbeddedC(): React.JSX.Element {
  return (
    <Gallery>
      <EmbeddedPanel dir="empty" tools={false} />
      <EmbeddedPanel dir="no-match" tools={false} steps={[{ type: 'input[role=searchbox]', value: 'zzz' }]} />
    </Gallery>
  )
}

export function SkillsEmbeddedD(): React.JSX.Element {
  return (
    <Gallery>
      <EmbeddedPanel
        dir="action-error"
        tools={false}
        steps={[{ click: 'button', text: 'tdd/tdd' }, { click: 'button[aria-label="Delete tdd"]' }, { click: 'button', text: 'Delete' }]}
      />
      <EmbeddedPanel dir="list" tools={false} relations />
    </Gallery>
  )
}

export function SkillsDeleteConfirm(): React.JSX.Element {
  installStubs()
  const ref = useDrive([{ click: 'button[aria-label="Delete tdd"]' }])
  return (
    <div ref={ref} style={{ display: 'flex', width: 410, height: 740, position: 'relative' }}>
      <SkillsView dir="list" onRun={noop} />
    </div>
  )
}

interface InstallStub {
  preview: () => Promise<unknown>
  install: (overwrite: boolean) => Promise<unknown>
}

function InstallStory({ steps, stub }: { steps: Step[]; stub: InstallStub }): React.JSX.Element {
  installStubs()
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown }
  w.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: { overwrite?: boolean }) =>
      cmd === 'system_preview_skill_url' ? stub.preview() : stub.install(Boolean(args.overwrite))
  }
  const ref = useDrive(steps)
  return (
    <div ref={ref} style={{ height: '100%' }}>
      <SkillInstallDialog dir="/home/dev/code/auth-refactor" onInstalled={noop} onClose={noop} />
    </div>
  )
}

const PREVIEW = {
  name: 'deploy',
  description: 'Ships the current branch to staging.',
  content: '---\nname: deploy\n---\n\n# Deploy\n\nRun the staging pipeline and wait for green.',
  sizeBytes: 80
}

export function SkillsInstallUrl(): React.JSX.Element {
  return (
    <InstallStory
      stub={{ preview: async () => { throw new Error('404 Not Found: https://example.com/skills/deploy/SKILL.md') }, install: async () => ({ ok: true }) }}
      steps={[
        { type: '#skill-install-url', value: 'https://example.com/skills/deploy/SKILL.md' },
        { click: 'button', text: 'Preview' }
      ]}
    />
  )
}

export function SkillsInstallPreview(): React.JSX.Element {
  return (
    <InstallStory
      stub={{ preview: async () => PREVIEW, install: async () => ({ ok: false, error: 'disk full', conflict: null }) }}
      steps={[
        { type: '#skill-install-url', value: 'https://example.com/skills/deploy/SKILL.md' },
        { click: 'button', text: 'Preview' },
        { click: 'button', text: 'Install' }
      ]}
    />
  )
}

export function SkillsInstallConflict(): React.JSX.Element {
  return (
    <InstallStory
      stub={{
        preview: async () => PREVIEW,
        install: async () => ({ ok: false, error: 'exists', conflict: { path: '/home/dev/.claude/skills/deploy/SKILL.md', existingContent: '# Deploy\n\nOld body.' } })
      }}
      steps={[
        { type: '#skill-install-url', value: 'https://example.com/skills/deploy/SKILL.md' },
        { click: 'button', text: 'Preview' },
        { click: 'button', text: 'Install' }
      ]}
    />
  )
}

export function SkillsInstallBlank(): React.JSX.Element {
  return <InstallStory stub={{ preview: async () => PREVIEW, install: async () => ({ ok: true }) }} steps={[]} />
}
