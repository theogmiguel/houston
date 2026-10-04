import type { AgentKind } from '../houston/client'
import type { ChatEffort } from '../houston/generated/ChatEffort'
import type { RoleRoute } from '../houston/generated/RoleRoute'

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
  model?: string
  effort?: ChatEffort
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
  model: string | null
  effort: ChatEffort | null
  modelSource: SlotValueSource
  effortSource: SlotValueSource
  skippedRoute: string | null
  invalidReason: string | null
}

export type SlotValueSource = 'preset' | 'profile' | 'agent default' | 'workspace setting' | 'user override'

export interface SlotOverrides {
  agent?: AgentKind
  model?: string | null
  effort?: ChatEffort | null
}

export interface ProfileLaunchDefaults {
  model?: string | null
  effort?: ChatEffort | null
}

export interface ResolvedSlotsOptions {
  routes?: readonly RoleRoute[]
  profileDefaults?: Partial<Record<AgentKind, ProfileLaunchDefaults>>
  overrides?: Readonly<Record<number, SlotOverrides>>
}

const EFFORT_AGENTS: readonly AgentKind[] = ['claude', 'codex', 'antigravity', 'grok']

function routeForRole(routes: readonly RoleRoute[], role: string): RoleRoute | undefined {
  return routes.find((route) => route.pattern === '*' || route.pattern === role ||
    (route.pattern.endsWith('*') && role.startsWith(route.pattern.slice(0, -1))))
}

export function resolveSlots(
  preset: SessionPreset | null,
  agent: AgentKind,
  count: number,
  task: string,
  options: ResolvedSlotsOptions = {}
): SessionSlot[] {
  const roles = preset?.roles ?? []
  const trimmedTask = task.trim()
  return Array.from({ length: count }, (_, index) => {
    const role = roles.length > 0 ? roles[index % roles.length] : undefined
    const override = options.overrides?.[index] ?? {}
    const slotAgent = override.agent ?? role?.engine ?? agent
    const profile = options.profileDefaults?.[slotAgent]
    const route = role?.label ? routeForRole(options.routes ?? [], role.label) : undefined
    const routeRequiresUnsupportedEffort = !!route?.effort && !EFFORT_AGENTS.includes(slotAgent)
    const modelOverride = !!override.model?.trim()
    const effortOverride = override.effort !== undefined && override.effort !== null
    const model = (modelOverride ? override.model : route && !routeRequiresUnsupportedEffort
      ? route.model : profile?.model ?? role?.model ?? null) ?? null
    const effort = (effortOverride ? override.effort : route && !routeRequiresUnsupportedEffort
      ? route.effort ?? profile?.effort ?? role?.effort ?? null : profile?.effort ?? role?.effort ?? null) ?? null
    const instruction = role?.instruction
    return {
      index,
      agent: slotAgent,
      roleLabel: role?.label ?? null,
      prompt: [instruction, trimmedTask].filter((value): value is string => !!value).join('\n\n'),
      model,
      effort,
      modelSource: modelOverride ? 'user override' : route && !routeRequiresUnsupportedEffort && model === route.model
        ? 'workspace setting' : profile?.model && model === profile.model ? 'profile'
          : role?.model && model === role.model ? 'preset' : 'agent default',
      effortSource: effortOverride ? 'user override' : route && !routeRequiresUnsupportedEffort && route.effort && effort === route.effort
        ? 'workspace setting' : profile?.effort && effort === profile.effort ? 'profile'
          : role?.effort && effort === role.effort ? 'preset' : 'agent default',
      skippedRoute: routeRequiresUnsupportedEffort
        ? `${route?.pattern} requires ${route.effort} effort, unsupported by ${slotAgent}` : null,
      invalidReason: effort && !EFFORT_AGENTS.includes(slotAgent)
        ? `Effort ${effort} is unsupported by ${slotAgent}` : null
    }
  })
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
  return resolveSlots(preset, agent, count, task)
}
