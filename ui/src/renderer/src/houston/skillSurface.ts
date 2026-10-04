import type { Skill } from '../env'
import { isLive } from './client'
import type { AgentKind } from './generated/AgentKind'
import type { SessionInfo } from './generated/SessionInfo'
import type { SkillToolState } from './generated/SkillToolState'

export const SKILL_CLI_ORDER: readonly AgentKind[] = [
  'claude',
  'codex',
  'opencode',
  'cursor',
  'grok',
  'antigravity'
]

const SKILL_CLI_LABEL: Record<AgentKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  grok: 'Grok',
  antigravity: 'Antigravity',
  shell: 'Shell',
  custom: 'Custom',
  droid: 'Droid',
  copilot: 'Copilot',
  aider: 'Aider',
  ssh: 'SSH'
}

export function skillScopeLabel(workspaceSelected: boolean): string {
  return workspaceSelected ? 'User · This workspace' : 'User skills only'
}

export function canUseSkillInFocusedPane(
  sessions: ReadonlyMap<number, SessionInfo>,
  activeId: number | null,
  workspace: string,
  connection: 'connecting' | 'ready' | 'reconnecting' | 'failed'
): boolean {
  const pane = activeId === null ? undefined : sessions.get(activeId)
  return Boolean(
    connection === 'ready' && pane && pane.agent !== 'shell' && isLive(pane.state) &&
    (workspace === 'all' || pane.project_dir === workspace)
  )
}

export type SkillCliRelation = {
  tool: AgentKind
  label: string
  relation: string
}

export function skillCliRelations(skill: Skill, tools: SkillToolState[] | null): SkillCliRelation[] {
  const states = new Map((tools ?? []).map((tool) => [tool.tool, tool]))
  const sourceEntry = states.get(skill.agent)?.skills.find((entry) => entry.name === skill.name)

  return SKILL_CLI_ORDER.map((tool) => {
    if (tool === 'antigravity') {
      return { tool, label: SKILL_CLI_LABEL[tool], relation: 'not managed here' }
    }
    if (tool === skill.agent) {
      return {
        tool,
        label: SKILL_CLI_LABEL[tool],
        relation: `source · ${skill.source === 'project' ? 'this workspace' : 'user'}`
      }
    }

    const state = states.get(tool)
    const entry = state?.skills.find((candidate) => candidate.name === skill.name)
    if (entry && sourceEntry) {
      return {
        tool,
        label: SKILL_CLI_LABEL[tool],
        relation: entry.digest === sourceEntry.digest ? 'copy in sync' : 'copy differs'
      }
    }
    if (state?.inherits_claude && skill.agent === 'claude' && sourceEntry) {
      return { tool, label: SKILL_CLI_LABEL[tool], relation: `reads ${SKILL_CLI_LABEL[skill.agent]}’s copy` }
    }
    return { tool, label: SKILL_CLI_LABEL[tool], relation: 'no copy' }
  })
}

/** One line per relation, naming every CLI that shares it, in first-appearance order. */
export function skillRelationLines(relations: SkillCliRelation[]): string[] {
  const labelsByRelation = new Map<string, string[]>()
  for (const { label, relation } of relations) {
    labelsByRelation.set(relation, [...(labelsByRelation.get(relation) ?? []), label])
  }
  return [...labelsByRelation].map(([relation, labels]) => `${labels.join(', ')} · ${relation}`)
}

export function skillUsageLine(skillName: string, digest: string | null, hasReview: boolean): string {
  if (!hasReview) return 'Usage appears after the first Harness review.'
  if (digest === null) return 'Usage is unavailable from the last Harness review.'

  const sessions = digest
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { skills?: Record<string, number> })
  const used = sessions.filter((session) => (session.skills?.[skillName] ?? 0) > 0).length
  return `Used in ${used} of ${sessions.length} sessions · from the last Harness review`
}
