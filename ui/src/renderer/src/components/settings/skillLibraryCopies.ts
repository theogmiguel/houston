import type { Skill } from '../../env'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { SkillToolState } from '../../houston/generated/SkillToolState'
import { buildSkillRows } from '../../houston/skillRows'

const LABELS: Partial<Record<AgentKind, string>> = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', opencode: 'OpenCode', cursor: 'Cursor', grok: 'Grok', zcode: 'ZCode' }
export function copyAgentLabel(tool: AgentKind): string { return LABELS[tool] ?? tool }
export function librarySkillId(skill: Skill): string { return `${skill.source}:${skill.name}` }
export function uniqueLibrarySkills(skills: Skill[]): Skill[] {
  const unique = new Map<string, Skill>()
  for (const skill of skills) {
    const key = librarySkillId(skill)
    if (!unique.has(key) || skill.agent === 'claude') unique.set(key, skill)
  }
  return [...unique.values()]
}
export function libraryCopies(skill: Skill, tools: SkillToolState[] | null | undefined) {
  const row = buildSkillRows(tools ?? []).find(item => item.name === skill.name)
  const copies = (tools ?? []).filter(tool => tool.detected).map(tool => {
    const entry = row?.byTool[tool.tool]
    const inherited = !entry && tool.inherits_claude && row?.claude
    const differs = entry && row?.hasDrift && (!row.claude || entry.digest !== row.claude.digest)
    return { tool, status: differs ? 'Differs' : entry || inherited ? 'Synced' : 'Missing', inherited: !!inherited }
  })
  const missing = copies.filter(copy => copy.status === 'Missing')
  return { copies, missing, conflict: row?.hasDrift ?? false, source: row?.claude, checked: tools != null }
}
export function syncLibrarySkill(skill: Skill, tools: SkillToolState[] | null | undefined, onPush: (tool: AgentKind, skill: string) => void): void {
  const state = libraryCopies(skill, tools)
  if (state.conflict || !state.source || skill.agent !== 'claude') return
  for (const copy of state.missing) {
    if (!copy.tool.error && copy.tool.tool !== 'claude') onPush(copy.tool.tool, skill.name)
  }
}
