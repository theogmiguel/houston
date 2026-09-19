import type { AgentKind } from '../houston/client'

export const COMPOSER_AGENTS: readonly AgentKind[] = [
  'claude',
  'codex',
  'cursor',
  'antigravity',
  'opencode',
  'grok',
  'shell'
]

export const AGENT_LABEL: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor Agent',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
  grok: 'Grok Build',
  shell: 'Terminal'
}

export const MAX_COUNT = 6

export const TASK_MAX_BYTES = 8192

export interface PresetRole {
  label: string
  instruction?: string
  engine?: AgentKind
}

export interface SessionPreset {
  id: string
  name: string
  blurb: string
  defaultAgent: AgentKind
  count: number
  roles: PresetRole[]
}

export const SESSION_PRESETS: readonly SessionPreset[] = [
  {
    id: 'solo',
    name: 'Solo',
    blurb: 'One agent in one terminal.',
    defaultAgent: 'claude',
    count: 1,
    roles: []
  },
  {
    id: 'pair',
    name: 'Pair',
    blurb: 'One builds, one reviews the same tree.',
    defaultAgent: 'claude',
    count: 2,
    roles: [
      { label: 'builder', instruction: 'You are the builder on this task. Implement it end to end.' },
      {
        label: 'reviewer',
        instruction:
          "You are the reviewer. Read the working tree and report bugs, missing tests, and edge cases — don't write code unless asked."
      }
    ]
  },
  {
    id: 'workbench',
    name: 'Workbench',
    blurb: 'An agent plus a shell for git and tests.',
    defaultAgent: 'claude',
    count: 2,
    roles: [{ label: 'agent' }, { label: 'shell', engine: 'shell' }]
  },
  {
    id: 'swarm',
    name: 'Swarm',
    blurb: 'Four agents fan out on parallel work.',
    defaultAgent: 'claude',
    count: 4,
    roles: []
  }
]

export interface SessionSlot {
  index: number
  agent: AgentKind
  roleLabel: string | null
  prompt: string
}

export function taskByteLength(task: string): number {
  return new TextEncoder().encode(task).length
}

export function taskOverLimitMessage(task: string): string | null {
  const bytes = taskByteLength(task)
  if (bytes <= TASK_MAX_BYTES) return null
  return `Task is too long (${bytes.toLocaleString('en-US')} of ${TASK_MAX_BYTES.toLocaleString('en-US')} bytes).`
}

export function expandSlots(
  preset: SessionPreset | null,
  agent: AgentKind,
  count: number,
  task: string
): SessionSlot[] {
  const roles = preset?.roles ?? []
  return Array.from({ length: count }, (_, index) => {
    const role = roles.length > 0 ? roles[index % roles.length] : undefined
    const instruction = role?.instruction
    const trimmedTask = task.trim()
    const prompt = [instruction, trimmedTask].filter((s): s is string => !!s).join('\n\n')
    return {
      index,
      agent: role?.engine ?? agent,
      roleLabel: role?.label ?? null,
      prompt
    }
  })
}
