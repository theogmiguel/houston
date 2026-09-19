import type { AgentKind } from '../houston/generated/AgentKind'

export const ENGINE_ORDER: AgentKind[] = [
  'claude',
  'codex',
  'antigravity',
  'opencode',
  'cursor',
  'grok',
  'shell',
  'ssh',
  'droid',
  'copilot',
  'aider',
  'custom'
]

const ENGINE_LABEL: Partial<Record<AgentKind, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity'
}

export function engineLabel(engine: AgentKind): string {
  return ENGINE_LABEL[engine] ?? engine.charAt(0).toUpperCase() + engine.slice(1)
}
